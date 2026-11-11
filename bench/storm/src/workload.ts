import type { Scenario } from "./scenarios.js";

/** What the app does with one failed request's error. The only thing that differs per SDK. */
export type Reporter = (error: Error, request: FailedRequest) => void;

export interface FailedRequest {
  index: number;
  method: string;
  route: string;
  status: number;
}

const ROUTES = ["/checkout", "/orders", "/cart", "/payments/charge", "/inventory/reserve"];

/**
 * Builds the error a failing request raises. All kinds are thrown from this one site, so what
 * makes two kinds different is the error's type — exactly how a real storm of a few failure modes
 * looks to a fingerprinter. The message carries per-request detail (an order id), as real messages
 * do; BugBuster's grouping ignores it, OpenTelemetry keeps it on every span.
 */
function makeError(kind: number, index: number): Error {
  const error = new Error(
    kind === 0
      ? `Server selection timed out after 30000 ms (order o_${100000 + index})`
      : `Upstream call failed with kind ${kind} (order o_${100000 + index})`,
  );
  error.name = kind === 0 ? "MongoServerSelectionError" : `UpstreamError${kind}`;
  return error;
}

/**
 * Replays `events` failed requests at `ratePerSec`, in 10 ms ticks (drift-corrected), so the event
 * loop keeps turning between bursts the way it does in a real server — that is what makes the
 * event-loop delay measurement meaningful. Resolves when the last error has been reported.
 */
export function runStorm(
  scenario: Scenario,
  events: number,
  ratePerSec: number,
  report: Reporter,
): Promise<void> {
  const TICK_MS = 10;
  const start = performance.now();
  let sent = 0;
  return new Promise((resolve) => {
    const tick = () => {
      const due = Math.min(events, Math.ceil(((performance.now() - start) / 1000) * ratePerSec));
      for (; sent < due; sent++) {
        const kind = scenario.kindOf(sent);
        report(makeError(kind, sent), {
          index: sent,
          method: sent % 4 === 0 ? "POST" : "GET",
          route: ROUTES[kind % ROUTES.length]!,
          status: kind === 0 ? 503 : 502,
        });
      }
      if (sent >= events) {
        resolve();
        return;
      }
      const next = start + ((sent + 1) / ratePerSec) * 1000;
      setTimeout(tick, Math.max(0, Math.min(TICK_MS, next - performance.now())));
    };
    setTimeout(tick, 0);
  });
}
