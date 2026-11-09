import type { OrgAlerts } from "@bugbusterhq/types";
import type { ControlDb, PublicOrg } from "../db/control.js";
import {
  clearAlertPending,
  clearAllAlertPending,
  findEarlierTwins,
  hasAlertPendingSince,
  listAlertPending,
  type IssueDocument,
} from "../db/collections/issues.js";
import { getExemplarsByIds } from "../db/collections/events.js";
import type { Mailer } from "./brevo.js";
import { renderAlertEmail, renderTestEmail, type AlertIssue } from "./email.js";

/**
 * Email alerts for new issues. Ingest marks every issue it creates as alert-pending (in the same
 * write that creates it), and marks an existing one again when it first appears in another
 * environment or service; this turns the pending issues of one org into at most one email per
 * run, then clears them. It runs right after an ingest that created an issue, from a scheduler
 * calling /internal/alerts/run, and on a timer in a long-running backend: any of them is enough,
 * and running twice at once is safe (see the lease).
 *
 * Delivery is at least once: if the email goes out and clearing the issues then fails, the next
 * run sends them again. Never the other way round, an issue cleared without its email.
 */

const LEASE_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
/** Pending issues looked at per run; the rest wait for the next one. */
const MAX_PENDING_PER_RUN = 200;
/** Issues described in one email; any more are counted ("…and 12 more"). */
const MAX_LISTED = 10;
const STACK_LINES = 6;
/**
 * Runs one call makes back to back. A run that finds the lease held leaves its issues to the
 * holder, which looks again after releasing it (see runForOrg); this bounds how often it does.
 */
const MAX_ROUNDS = 5;

export interface AlertRunResult {
  /** Emails sent (0 or 1). */
  emails: number;
  /** Issues those emails covered. */
  alerted: number;
  /** Pending issues dropped without an email: from before alerts were on, or filtered out. */
  skipped: number;
  /** True when issues are waiting: the hourly cap was reached, or another process is sending. */
  held: boolean;
  error?: string;
}

const NOTHING: AlertRunResult = { emails: 0, alerted: 0, skipped: 0, held: false };

/** One leased run, plus what runForOrg needs to decide whether to run again. */
interface LeasedRun extends AlertRunResult {
  /** When the pending issues were listed: issues marked after this were not looked at. */
  listedAt?: string;
  /** More pending issues than one run looks at. */
  more?: boolean;
  /** Waiting for the hourly cap: another run now would only hold them again. */
  capped?: boolean;
}

export interface AlertNotifierOptions {
  dashboardUrl?: string;
  maxEmailsPerHour: number;
  now?: () => Date;
}

function matchesAny(values: readonly string[], wanted: readonly string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) return true;
  return values.some((v) => wanted.includes(v));
}

/** Who an org's alerts cover, in words, for the test email. */
export function alertScope(alerts: Pick<OrgAlerts, "services" | "environments">): string {
  const services = alerts.services?.length ? alerts.services.join(", ") : "any of your services";
  const envs = alerts.environments?.length ? ` in ${alerts.environments.join(", ")}` : "";
  return services + envs;
}

function topEndpoint(doc: IssueDocument): string | undefined {
  let best: [string, number] | undefined;
  for (const entry of Object.entries(doc.endpointCounts ?? {})) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best?.[0];
}

function stackTop(stacktrace: string | undefined): string[] {
  if (!stacktrace) return [];
  const lines = stacktrace.split("\n").map((l) => l.trim());
  const frames = lines.filter((l) => l.startsWith("at "));
  return (frames.length > 0 ? frames : lines.filter(Boolean)).slice(0, STACK_LINES);
}

export class AlertNotifier {
  constructor(
    private readonly controlDb: ControlDb,
    private readonly mailer: Mailer,
    private readonly options: AlertNotifierOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Sends one org's pending alerts, if it has any and may send now. Never throws. */
  async runForOrg(orgId: string): Promise<AlertRunResult> {
    try {
      const org = await this.controlDb.getOrg(orgId);
      if (!org) return NOTHING;
      if (!org.alerts?.enabled || org.alerts.recipients.length === 0 || org.disabled) {
        // Nobody to tell: the marks would only pile up. Switching alerts on later starts afresh.
        await clearAllAlertPending(this.controlDb.getClient().db(org.dbName));
        return NOTHING;
      }
      // A run that finds the lease held returns at once and leaves its issues to the holder. So
      // the holder, once it has released the lease, looks for issues marked since it listed them
      // and runs again for them: an issue marked before the release is seen by that look, and one
      // marked after it is run by its own ingest, which can then take the lease. Without this, an
      // issue created during a send waited for the next trigger (on Vercel, the daily cron).
      const db = this.controlDb.getClient().db(org.dbName);
      const total: AlertRunResult = { ...NOTHING };
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const leased = await this.controlDb.claimAlertLease(orgId, LEASE_MS, this.now());
        if (!leased) return round === 0 ? { ...NOTHING, held: true } : total;
        const run = await this.sendLeased(leased);
        total.emails += run.emails;
        total.alerted += run.alerted;
        total.skipped += run.skipped;
        total.held = run.held;
        if (run.error) return { ...total, error: run.error };
        if (run.capped || run.listedAt === undefined) break;
        if (!run.more && !(await hasAlertPendingSince(db, run.listedAt))) break;
      }
      return total;
    } catch (err) {
      return { ...NOTHING, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Runs every org that has alerts switched on, one after another. */
  async runAll(): Promise<{ orgs: number; emails: number; alerted: number; errors: number }> {
    const orgs = await this.controlDb.listOrgsWithAlerts();
    const total = { orgs: orgs.length, emails: 0, alerted: 0, errors: 0 };
    for (const org of orgs) {
      const r = await this.runForOrg(org.orgId);
      total.emails += r.emails;
      total.alerted += r.alerted;
      if (r.error) total.errors++;
    }
    return total;
  }

  private async sendLeased(org: PublicOrg): Promise<LeasedRun> {
    const alerts = org.alerts!;
    const now = this.now();
    const sentAt = (org.alertState?.sentAt ?? []).filter(
      (t) => now.getTime() - new Date(t).getTime() < HOUR_MS,
    );
    const finish = (sent: boolean, error?: string) =>
      this.controlDb.finishAlertRun(
        org.orgId,
        { sentAt: sent ? [...sentAt, now.toISOString()] : sentAt, sent, error },
        now,
      );

    try {
      const db = this.controlDb.getClient().db(org.dbName);
      // The real clock, not `now`: it is compared with marks ingest wrote with the real clock.
      const listedAt = new Date().toISOString();
      const pending = await listAlertPending(db, MAX_PENDING_PER_RUN);
      const more = pending.length === MAX_PENDING_PER_RUN;
      // Filters apply to where the alert is about (the places that made it pending), falling back
      // to everywhere the issue has been for marks written before those places were recorded.
      const placesOf = (list: string[] | undefined, all: string[] | undefined) =>
        list && list.length > 0 ? list : (all ?? []);
      const wanted = pending.filter(
        (issue) =>
          (issue.alertPendingAt ?? issue.firstSeen) >= alerts.since &&
          matchesAny(placesOf(issue.alertServices, issue.services), alerts.services) &&
          matchesAny(placesOf(issue.alertEnvironments, issue.environments), alerts.environments),
      );
      const twins = await findEarlierTwins(db, wanted);
      const send: IssueDocument[] = wanted.filter((i) => !twins.has(i.fingerprint));
      const sending = new Set(send.map((i) => i.fingerprint));
      const skip = pending.filter((i) => !sending.has(i.fingerprint));
      await clearAlertPending(db, skip);

      if (send.length === 0) {
        await finish(false);
        return { ...NOTHING, skipped: skip.length, listedAt, more };
      }
      if (sentAt.length >= this.options.maxEmailsPerHour) {
        // They stay pending and go out together once the hour allows another email.
        await finish(false);
        return { ...NOTHING, skipped: skip.length, held: true, capped: true, listedAt };
      }

      const listed = send.slice(0, MAX_LISTED);
      const firstExamples = alerts.includeStack
        ? await getExemplarsByIds(
            db,
            listed.flatMap((i) => (i.exemplarRefs[0] ? [i.exemplarRefs[0].eventId] : [])),
          )
        : [];
      const stackById = new Map(firstExamples.map((e) => [e.eventId, e.error?.stacktrace]));
      const issues: AlertIssue[] = listed.map((i) => ({
        fingerprint: i.fingerprint,
        ...(i.title ? { title: i.title } : {}),
        services: i.services ?? [],
        environments: i.environments ?? [],
        count: i.count,
        firstSeen: i.firstSeen,
        ...(topEndpoint(i) ? { topEndpoint: topEndpoint(i) } : {}),
        stack: stackTop(i.exemplarRefs[0] ? stackById.get(i.exemplarRefs[0].eventId) : undefined),
      }));

      await this.mailer.send(
        alerts.recipients,
        renderAlertEmail({
          orgName: org.name,
          issues,
          more: send.length - listed.length,
          dashboardUrl: this.options.dashboardUrl,
        }),
      );
      await clearAlertPending(db, send);
      await finish(true);
      return {
        emails: 1,
        alerted: send.length,
        skipped: skip.length,
        held: false,
        listedAt,
        more,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finish(false, message).catch(() => {});
      return { ...NOTHING, error: message };
    }
  }

  /** Sends the test email to an org's saved recipients. Throws when sending fails. */
  async sendTest(org: PublicOrg): Promise<number> {
    const alerts = org.alerts;
    if (!alerts || alerts.recipients.length === 0) return 0;
    await this.mailer.send(
      alerts.recipients,
      renderTestEmail({
        orgName: org.name,
        scope: alertScope(alerts),
        dashboardUrl: this.options.dashboardUrl,
      }),
    );
    return alerts.recipients.length;
  }
}
