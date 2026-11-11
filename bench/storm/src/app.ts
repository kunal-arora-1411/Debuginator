import { monitorEventLoopDelay } from "node:perf_hooks";
import { SCENARIOS } from "./scenarios.js";
import { runStorm, type FailedRequest, type Reporter } from "./workload.js";

/**
 * The application under test: one fresh process per run, so the SDKs never share a heap, a JIT
 * warm-up or a CPU budget. It replays the storm through one SDK, flushes, and prints one JSON line
 * of measurements for the orchestrator (run.ts). The collector, not this process, measures what
 * was sent.
 *
 *   node dist/app.js <sdk> <scenario> <events> <ratePerSec> <collectorUrl> [agentSocket]
 */

export type SdkName =
  | "none"
  | "bugbuster"
  | "bugbuster-noloss"
  | "bugbuster-agent"
  | "otel"
  | "otel-noloss"
  | "otel-json";

export interface AppResult {
  sdk: SdkName;
  /** CPU (user + system) from just before the storm to the end of the final flush. */
  cpuMs: number;
  /** Wall time of the same span: the storm plus the final flush. */
  wallMs: number;
  /** Wall time of the final flush alone (shutdown / forceFlush). */
  flushMs: number;
  eventLoopDelayP99Ms: number;
  eventLoopDelayMaxMs: number;
  peakRssMb: number;
  /** OpenTelemetry only: spans the exporter reported as sent, and spans ended but never sent. */
  otelExported?: number;
  otelDropped?: number;
}

interface Sdk {
  report: Reporter;
  flush(): Promise<void>;
  stats?(): Pick<AppResult, "otelExported" | "otelDropped">;
}

async function makeSdk(
  sdk: SdkName,
  collectorUrl: string,
  events: number,
  agentSocket?: string,
): Promise<Sdk> {
  if (sdk === "none") return { report: () => {}, flush: async () => {} };

  if (sdk === "bugbuster" || sdk === "bugbuster-noloss" || sdk === "bugbuster-agent") {
    const { init, runWithContext, newTraceId, newSpanId } = await import("@bugbusterhq/sdk-node");
    const client = init({
      project: "storm-app",
      apiKey: "bench",
      release: "1.0.0",
      backendUrl: `${collectorUrl}/ingest`,
      // Direct mode must not pick up an Agent that happens to run on this machine.
      agentSocketPath: sdk === "bugbuster-agent" ? agentSocket! : "/nonexistent/bugbuster.sock",
      // Only a ceiling on the final flush, so the last batch isn't cut off; everything else is
      // the SDK's defaults, as a user gets them.
      shutdownFlushTimeoutMs: 60_000,
      // bugbuster-noloss: an error buffer big enough for the whole storm (the SDK budgets about
      // 2 KB per held error). Every other setting is a default.
      ...(sdk === "bugbuster-noloss" ? { ringBufferBytes: (events + 1024) * 2048 } : {}),
    });
    return {
      // As the Express integration does it: each request runs in its own trace context.
      report: (error) =>
        runWithContext({ traceId: newTraceId(), spanId: newSpanId() }, () =>
          client.captureException(error),
        ),
      flush: () => client.shutdown(),
    };
  }

  // OpenTelemetry, set up the standard way: a BatchSpanProcessor in front of the OTLP/HTTP
  // exporter, one span per failed request, the error recorded on it with recordException and
  // status ERROR — what the OTel HTTP instrumentation produces for a failing request.
  const { SpanStatusCode } = await import("@opentelemetry/api");
  const { TracerProvider, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace");
  const { OTLPTraceExporter } =
    sdk === "otel-json"
      ? await import("@opentelemetry/exporter-trace-otlp-http")
      : await import("@opentelemetry/exporter-trace-otlp-proto");
  const exporter = new OTLPTraceExporter({ url: `${collectorUrl}/v1/traces` });

  // Counts what the exporter actually managed to send, so drops are measured, not assumed.
  let exported = 0;
  let ended = 0;
  const counting: typeof exporter = Object.create(exporter);
  counting.export = (spans, done) =>
    exporter.export(spans, (result) => {
      if (result.code === 0) exported += spans.length;
      done(result);
    });

  const provider = new TracerProvider({
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: counting,
        // otel-noloss: a queue big enough for the whole storm. Every other setting is a default.
        ...(sdk === "otel-noloss" ? { maxQueueSize: events } : {}),
      }),
    ],
  });
  const tracer = provider.getTracer("storm-app", "1.0.0");
  return {
    report: (error, req: FailedRequest) => {
      const span = tracer.startSpan(`${req.method} ${req.route}`, {
        attributes: {
          "http.request.method": req.method,
          "http.route": req.route,
          "http.response.status_code": req.status,
        },
      });
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
      ended++;
    },
    flush: async () => {
      await provider.forceFlush();
      await provider.shutdown();
    },
    stats: () => ({ otelExported: exported, otelDropped: ended - exported }),
  };
}

async function main(): Promise<void> {
  const [sdkArg, scenarioArg, eventsArg, rateArg, collectorUrl, agentSocket] =
    process.argv.slice(2);
  const sdk = sdkArg as SdkName;
  const scenario = SCENARIOS[scenarioArg ?? ""];
  if (!scenario || !collectorUrl)
    throw new Error("usage: app.js <sdk> <scenario> <events> <rate> <collectorUrl>");
  const events = Number(eventsArg);
  const rate = Number(rateArg);

  const client = await makeSdk(sdk, collectorUrl, events, agentSocket);

  const loop = monitorEventLoopDelay({ resolution: 1 });
  let peakRss = process.memoryUsage().rss;
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);

  loop.enable();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await runStorm(scenario, events, rate, client.report);
  const tFlush = performance.now();
  await client.flush();
  const t1 = performance.now();
  const cpu = process.cpuUsage(cpu0);
  loop.disable();
  clearInterval(rssTimer);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const result: AppResult = {
    sdk,
    cpuMs: (cpu.user + cpu.system) / 1000,
    wallMs: t1 - t0,
    flushMs: t1 - tFlush,
    eventLoopDelayP99Ms: loop.percentile(99) / 1e6,
    eventLoopDelayMaxMs: loop.max / 1e6,
    peakRssMb: peakRss / (1024 * 1024),
    ...client.stats?.(),
  };
  process.stdout.write("\nRESULT " + JSON.stringify(result) + "\n");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
