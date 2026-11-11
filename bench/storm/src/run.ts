import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release as osRelease, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHttpClient, CircuitBreaker, UdsServer } from "@bugbusterhq/agent";
import { Collector, type CollectorStats } from "./collector.js";
import { SCENARIOS } from "./scenarios.js";
import type { AppResult, SdkName } from "./app.js";

/**
 * The error-storm benchmark: the same storm through BugBuster and through a standard
 * OpenTelemetry exporter, into the same collector. See ../README.md for the method.
 *
 *   pnpm bench:storm [--events 50000] [--rate 10000] [--runs 5]
 *                    [--scenarios storm,incident,cardinality]
 *                    [--sdks bugbuster,bugbuster-agent,otel,otel-noloss] [--out results.md]
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = join(HERE, "app.js");

const SDK_LABEL: Record<SdkName, string> = {
  none: "no telemetry (baseline)",
  bugbuster: "BugBuster, direct (defaults)",
  "bugbuster-noloss": "BugBuster, direct (buffer sized to keep all)",
  "bugbuster-agent": "BugBuster, via Agent (defaults)",
  otel: "OpenTelemetry, OTLP/protobuf (defaults)",
  "otel-noloss": "OpenTelemetry, OTLP/protobuf (queue sized to keep all)",
  "otel-json": "OpenTelemetry, OTLP/JSON (defaults)",
};

interface Options {
  events: number;
  rate: number;
  runs: number;
  scenarios: string[];
  sdks: SdkName[];
  out: string;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const opts: Options = {
    events: Number(get("events") ?? 50_000),
    rate: Number(get("rate") ?? 10_000),
    runs: Number(get("runs") ?? 5),
    scenarios: (get("scenarios") ?? "storm,incident,cardinality").split(","),
    sdks: (get("sdks") ?? "bugbuster,bugbuster-noloss,bugbuster-agent,otel,otel-noloss").split(
      ",",
    ) as SdkName[],
    out: get("out") ?? join(HERE, "..", "results.md"),
  };
  for (const s of opts.scenarios) if (!SCENARIOS[s]) throw new Error(`unknown scenario: ${s}`);
  for (const s of opts.sdks) if (!SDK_LABEL[s]) throw new Error(`unknown sdk: ${s}`);
  return opts;
}

/** Runs the app once in a fresh process; resolves with what it measured about itself. */
function runApp(args: string[]): Promise<AppResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [APP, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (code !== 0 || !line) reject(new Error(`app exited ${code}: ${err.slice(-2000)}`));
      else resolve(JSON.parse(line.slice("RESULT ".length)) as AppResult);
    });
  });
}

interface RunMeasure {
  app: AppResult;
  net: CollectorStats;
}

async function runOnce(
  sdk: SdkName,
  scenario: string,
  opts: Options,
  collector: Collector,
): Promise<RunMeasure> {
  collector.take(); // start clean
  if (sdk !== "bugbuster-agent") {
    const app = await runApp([
      sdk,
      scenario,
      String(opts.events),
      String(opts.rate),
      collector.url,
    ]);
    return { app, net: collector.take() };
  }

  // A real Agent, as deployed: the app writes to its socket, the Agent merges, zstd-compresses
  // and sends. Run in this process (it is a separate process from the app either way); its own
  // CPU is the host's cost, not the app's, and is not in the app's numbers.
  const dir = mkdtempSync(join(tmpdir(), "bb-bench-"));
  const socketPath = join(dir, "agent.sock");
  const agent = new UdsServer({
    socketPath,
    httpClient: new AgentHttpClient({
      url: `${collector.url}/ingest`,
      apiKey: "bench",
      totalTimeoutMs: 30_000,
      maxRetries: 3,
      circuitBreaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 }),
    }),
  });
  await agent.start();
  try {
    const app = await runApp([
      sdk,
      scenario,
      String(opts.events),
      String(opts.rate),
      collector.url,
      socketPath,
    ]);
    await agent.flush(); // what the Agent still holds when the app is done
    return { app, net: collector.take() };
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** One row of the results: medians over the runs. */
interface Row {
  sdk: SdkName;
  requests: number;
  wireBytes: number;
  rawBytes: number;
  gzipBytes: number;
  /** Records the backend would write. */
  writes: number;
  /** Errors whose occurrence reached the backend (as a span, or inside a fold's count). */
  delivered: number;
  /** Errors the SDK itself reported dropping (BugBuster's drop counters; OTel reports none). */
  reportedLost: number;
  cpuMs: number;
  flushMs: number;
  p99Ms: number;
  maxMs: number;
  peakRssMb: number;
}

function toRow(sdk: SdkName, runs: RunMeasure[]): Row {
  const per = runs.map(({ app, net }) => {
    const isBugBuster = sdk.startsWith("bugbuster");
    const spans = net.spans || app.otelExported || 0;
    return {
      requests: net.requests,
      wireBytes: net.wireBytes,
      rawBytes: net.rawBytes,
      gzipBytes: net.gzipBytes,
      writes: isBugBuster ? net.folds + net.exemplarsStored : spans,
      delivered: isBugBuster ? net.eventsAccounted : spans,
      reportedLost: isBugBuster ? net.bugbusterDropped : 0,
      cpuMs: app.cpuMs,
      flushMs: app.flushMs,
      p99Ms: app.eventLoopDelayP99Ms,
      maxMs: app.eventLoopDelayMaxMs,
      peakRssMb: app.peakRssMb,
    };
  });
  const m = (k: keyof (typeof per)[number]) => median(per.map((p) => p[k]));
  return {
    sdk,
    requests: m("requests"),
    wireBytes: m("wireBytes"),
    rawBytes: m("rawBytes"),
    gzipBytes: m("gzipBytes"),
    writes: m("writes"),
    delivered: m("delivered"),
    reportedLost: m("reportedLost"),
    cpuMs: m("cpuMs"),
    flushMs: m("flushMs"),
    p99Ms: m("p99Ms"),
    maxMs: m("maxMs"),
    peakRssMb: m("peakRssMb"),
  };
}

const fmtBytes = (b: number) =>
  b >= 1024 * 1024
    ? `${(b / (1024 * 1024)).toFixed(1)} MB`
    : b >= 1024
      ? `${(b / 1024).toFixed(1)} KB`
      : `${Math.round(b)} B`;
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtMs = (n: number) => (n >= 100 ? fmtInt(n) : n.toFixed(1)) + " ms";

function table(rows: Row[], baseline: Row, events: number): string {
  const lines = [
    "| SDK | Sent (wire) | Sent, gzip | Requests | Backend writes | Errors delivered | App CPU added | p99 / max event-loop delay | Final flush | Peak RSS added |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows) {
    const lost = events - r.delivered;
    const lostNote =
      lost <= 0
        ? ""
        : r.reportedLost >= lost
          ? ` (**${fmtInt(lost)} lost**, all counted)`
          : r.reportedLost > 0
            ? ` (**${fmtInt(lost)} lost**, ${fmtInt(r.reportedLost)} counted)`
            : ` (**${fmtInt(lost)} lost**, silently)`;
    lines.push(
      `| ${SDK_LABEL[r.sdk]} | ${fmtBytes(r.wireBytes)} | ${fmtBytes(r.gzipBytes)} | ${fmtInt(r.requests)} | ${fmtInt(r.writes)} | ${fmtInt(r.delivered)}${lostNote} | ${fmtMs(Math.max(0, r.cpuMs - baseline.cpuMs))} | ${fmtMs(r.p99Ms)} / ${fmtMs(r.maxMs)} | ${fmtMs(r.flushMs)} | ${(r.peakRssMb - baseline.peakRssMb).toFixed(0)} MB |`,
    );
  }
  lines.push(
    `| _${SDK_LABEL.none}_ | — | — | — | — | — | _${fmtMs(baseline.cpuMs)} total_ | _${fmtMs(baseline.p99Ms)} / ${fmtMs(baseline.maxMs)}_ | — | _${baseline.peakRssMb.toFixed(0)} MB total_ |`,
  );
  return lines.join("\n");
}

function packageVersion(name: string): string {
  try {
    // Read from this package's own node_modules: `pkg/package.json` is often not in a
    // package's "exports", so it can't be resolved by name.
    const pkgPath = join(HERE, "..", "node_modules", name, "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  } catch {
    return "?";
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const collector = new Collector();
  await collector.start();

  const sections: string[] = [];
  const raw: Record<string, Record<string, RunMeasure[]>> = {};
  const total = opts.scenarios.length * (opts.sdks.length + 1) * opts.runs;
  let done = 0;

  for (const scenario of opts.scenarios) {
    raw[scenario] = {};
    const results = new Map<SdkName, RunMeasure[]>();
    // Interleaved (A, B, C, A, B, C, ...) rather than all of A then all of B, so a slow patch on
    // the machine spreads across every SDK instead of landing on one.
    for (let run = 0; run < opts.runs; run++) {
      for (const sdk of ["none", ...opts.sdks] as SdkName[]) {
        const m = await runOnce(sdk, scenario, opts, collector);
        results.set(sdk, [...(results.get(sdk) ?? []), m]);
        done++;
        process.stderr.write(`\r[${done}/${total}] ${scenario} · ${sdk} · run ${run + 1}      `);
      }
    }
    for (const [sdk, runs] of results) raw[scenario][sdk] = runs;
    const baseline = toRow("none", results.get("none")!);
    const rows = opts.sdks.map((sdk) => toRow(sdk, results.get(sdk)!));
    const s = SCENARIOS[scenario]!;
    sections.push(
      `### ${s.name}: ${fmtInt(opts.events)} errors, ${s.description}\n\n${table(rows, baseline, opts.events)}`,
    );
  }
  process.stderr.write("\n");
  await collector.stop();

  const cpu = cpus()[0]?.model ?? "unknown CPU";
  const env =
    `${cpu}, ${cpus().length} cores, ${(totalmem() / 1024 ** 3).toFixed(0)} GB RAM · ` +
    `${platform()} ${osRelease()} · Node ${process.versions.node} · ` +
    `@bugbusterhq/sdk-node ${packageVersion("@bugbusterhq/sdk-node")} · ` +
    `@opentelemetry/sdk-trace ${packageVersion("@opentelemetry/sdk-trace")} + ` +
    `exporter-trace-otlp-proto ${packageVersion("@opentelemetry/exporter-trace-otlp-proto")}`;

  const md = [
    "# Error-storm benchmark results",
    "",
    `Generated by \`pnpm bench:storm\` on ${new Date().toISOString().slice(0, 10)}. ` +
      `${fmtInt(opts.events)} failing requests at ${fmtInt(opts.rate)}/s, median of ${opts.runs} runs, ` +
      "each in a fresh process. Method and caveats: [README.md](README.md).",
    "",
    `**Machine:** ${env}`,
    "",
    ...sections.flatMap((s) => [s, ""]),
    "**Columns.** *Sent (wire)*: request bodies as sent (the Agent zstd-compresses; the others " +
      "send uncompressed). *Sent, gzip*: the same bodies gzipped by the collector, to compare at " +
      "equal compression. *Backend writes*: BugBuster's fold upserts plus the example events a " +
      "backend keeps (at most 6 per issue); one record per span for OpenTelemetry. *Errors " +
      "delivered*: occurrences that reached the collector — as a span, or inside a fold's count. " +
      "*App CPU added* and *Peak RSS added* are over the no-telemetry baseline running the same " +
      "storm. Event-loop delay is measured during the storm and the final flush.",
    "",
  ].join("\n");
  writeFileSync(opts.out, md);
  writeFileSync(
    opts.out.replace(/\.md$/, ".json"),
    JSON.stringify({ opts, env, raw }, setReplacer, 2),
  );
  console.log(md);
}

function setReplacer(_key: string, value: unknown): unknown {
  return value instanceof Set ? [...value].length : value;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
