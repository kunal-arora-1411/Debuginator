# Error-storm benchmark

BugBuster's core claim is that grouping errors **inside the SDK**, before anything is sent, turns
an error storm into a handful of records. This benchmark measures that claim against the standard
alternative: OpenTelemetry, reporting each failing request as a span with the error recorded on
it, exported over OTLP/HTTP.

Same storm, same machine, same collector, one fresh process per run. Latest results:
[results.md](results.md).

```bash
pnpm build
pnpm bench:storm                                   # all scenarios, 5 runs each (~12 min)
pnpm bench:storm -- --runs 1 --scenarios storm     # a quick look
```

Options: `--events 50000`, `--rate 10000` (errors per second), `--runs 5`,
`--scenarios storm,incident,cardinality`,
`--sdks bugbuster,bugbuster-noloss,bugbuster-agent,otel,otel-noloss` (also `otel-json`),
`--out results.md` (a `.json` with every run's raw numbers is written next to it).

## What it found (latest run)

- **The core claim holds.** For a storm of one or a few kinds of error, BugBuster sends kilobytes
  where OpenTelemetry sends tens of megabytes (about 8,000× less for one repeated error), and a
  backend writes a few dozen records instead of 50,000.
- **At default settings, BugBuster drops most of a fast storm.** The error buffer (8 MB, budgeted
  at about 2 KB per held error) holds ~4,100 errors per 5-second flush window; past that, errors
  are dropped before they are folded. Every drop is counted in the SDK's drop counters, but the
  issue's count comes out too low. OpenTelemetry's defaults lost nothing at this rate.
- **Keeping everything costs more app CPU than OpenTelemetry** (about 1.9 s vs 1.3 s added for
  50,000 errors): each error is stack-parsed, redacted and hashed, even though only a handful
  become example events.
- **The fold freezes the event loop.** The flush folds the whole window at once on the main
  thread: up to about 1 second for 50,000 held errors.
- **With thousands of kinds, there is little to group.** In the `cardinality` scenario BugBuster
  sends about as much as OpenTelemetry (gzipped), and writes 15,000 records.
- **Fixed along the way:** `shutdown()` did not wait for a periodic flush still sending, so a
  large batch in flight at exit was lost and never counted (49,987 of 50,000 errors in the first
  run of the `cardinality` scenario). Flushes now run one at a time.

## How it works

```text
run.ts ── spawns, per run ──▶ app.js <sdk> <scenario>      collector.ts (in run.ts's process)
                               replays the storm ── HTTP ──▶  /ingest      (BugBuster)
                               through one SDK               /v1/traces   (OTLP)
                               measures itself               counts bytes and records
```

- **The storm** (`src/workload.ts`): `--events` failing requests at `--rate` per second, in 10 ms
  ticks, so the event loop keeps turning between bursts as it does in a real server. Each error is
  a real `Error` with a per-request message (an order id).
- **Scenarios** (`src/scenarios.ts`):
  - `storm` — one error, repeated: a database timeout. Grouping's best case.
  - `incident` — 10 kinds, Zipf-weighted (one dominant failure and its consequences).
  - `cardinality` — 5,000 kinds, evenly spread. Grouping's worst case: little to group.
- **The SDKs** (`src/app.ts`), each with its defaults unless the row says otherwise:
  - `bugbuster` — `init()` in direct mode, `captureException` inside a per-request trace context
    (what `bb.requestHandler` does), `shutdown()` at the end.
  - `bugbuster-noloss` — the same, with the error buffer sized for the whole storm.
  - `bugbuster-agent` — the same SDK writing to a real Agent (`UdsServer`) over its Unix socket;
    the Agent merges, zstd-compresses and sends.
  - `otel` — `TracerProvider` + `BatchSpanProcessor` + `OTLPTraceExporter` (protobuf). One span per
    failed request with three HTTP attributes, `recordException(err)` and status `ERROR` — what
    OTel's HTTP instrumentation produces for a failing request.
  - `otel-noloss` — the same, with the span queue sized for the whole storm.
  - `otel-json` — OTLP/JSON instead of protobuf.
  - `none` — the same storm with no telemetry: the baseline every "added" number is measured from.
- **The collector** (`src/collector.ts`) counts request bodies as sent, decompresses them, and
  gzips each one itself so every row can also be compared at equal compression. It decodes
  BugBuster envelopes (folds, example events, drop counters) and OTLP/JSON (spans). Protobuf bodies
  are measured but not decoded; their span count comes from the app, which wraps the exporter and
  counts the spans it reports as sent.

## What each column means

| Column | Measured as |
|---|---|
| Sent (wire) | Request body bytes as sent. Only the Agent compresses (zstd); the SDKs send uncompressed. |
| Sent, gzip | The same bodies gzipped by the collector — every row at equal compression. |
| Requests | HTTP requests received. |
| Backend writes | BugBuster: one upsert per fold record, plus the example events a backend keeps (at most 6 per issue). OpenTelemetry: one record per span. |
| Errors delivered | Occurrences that reached the collector: as a span, or inside a fold record's count. "Lost … all counted" means the SDK's own drop counters report every one it lost; "silently" means it reported none. |
| App CPU added | `process.cpuUsage()` from just before the storm to the end of the final flush, minus the baseline's. The Agent's own CPU is not included: it is a separate process. |
| p99 / max event-loop delay | `monitorEventLoopDelay` (1 ms resolution) over the same span. The max is the longest the app was frozen. |
| Final flush | Wall time of `shutdown()` / `forceFlush()`. |
| Peak RSS added | Peak resident memory, sampled every 20 ms, minus the baseline's. |

All numbers are medians over `--runs` runs. The SDKs are interleaved run by run, so a slow patch on
the machine spreads across every row instead of landing on one.

## Fairness, and what this does not show

- **What's kept differs, by design.** OpenTelemetry keeps every occurrence with its own trace id,
  message and timestamp. BugBuster keeps a count per kind of error, plus at most 6 complete example
  events per issue. That trade is the point; it is not free, and these tables measure its price and
  its payoff, not which data is "better".
- **Defaults and no-loss rows.** Defaults are what users get, so they come first. Both SDKs can
  lose data in a big enough storm (BugBuster's error buffer, OTel's span queue), so each also has a
  row sized to keep everything — compare those when comparing cost.
- **One collector, no backend.** "Backend writes" is what each backend would have to write, not a
  measured database load.
- **Local network.** Bytes are exact; transfer times over a real network are not modelled.
- **Not in CI.** Timing numbers are too noisy on shared runners. Run it by hand, on an idle
  machine, and commit `results.md` with the machine it ran on.
