# Testing this branch on your machine

How to check, on your own machine, what this branch (`feat/storm-benchmark`) adds:

1. the **error-storm benchmark** — BugBuster against OpenTelemetry ([`bench/storm`](bench/storm));
2. the **SDK fix** it led to — `shutdown()` now waits for a flush that is still sending.

The results committed here came from a 4-core Intel Xeon (2.1 GHz), 16 GB RAM, Linux,
Node 22.23. Yours will differ in time and CPU; bytes, requests, writes and losses should match
closely.

---

## 1. Prerequisites

| Need | Why |
|---|---|
| **Node.js ≥ 22.15** | The Agent and the benchmark's collector use Node's built-in zstd. Check with `node -v`. |
| **pnpm 10+** | `corepack enable` gives you the version this repo pins. |
| ~1 GB free RAM, an idle machine | The benchmark measures CPU and event-loop delay; other busy programs skew both. |
| Internet access, the first time | `pnpm install`; the integration tests also download a MongoDB binary once. |

No database is needed for the benchmark or the tests.

## 2. Get the branch and build

```bash
git fetch origin feat/storm-benchmark
git checkout feat/storm-benchmark
pnpm install
pnpm build
```

`pnpm build` must succeed before anything below: the benchmark runs the compiled code in `dist/`.

## 3. Run the tests

```bash
pnpm test:unit
pnpm test:integration
```

Expected: every test passes (on this branch: 221 unit, 150 integration).

**The SDK fix specifically** — its regression test:

```bash
pnpm --filter @bugbusterhq/sdk-node exec vitest run test/unit/index.test.ts
```

Look for *"shutdown() waits for a periodic flush that is still sending, so its batch is not
lost"* — passing.

> If `pnpm test:integration` fails while downloading MongoDB (a firewall or proxy blocking
> `fastdl.mongodb.org`), point it at any `mongod` binary you have:
> `MONGOMS_SYSTEM_BINARY=/path/to/mongod pnpm test:integration`.

## 4. Run the benchmark

**A quick look first (about 1 minute):**

```bash
pnpm bench:storm -- --runs 1 --scenarios storm --out my-quick.md
```

**The full run (about 15–20 minutes on 4 cores):**

```bash
pnpm bench:storm -- --out my-results.md
```

Use `--out` so your results don't overwrite the committed
[`bench/storm/results.md`](bench/storm/results.md) — you'll want both side by side. A relative
`--out` is written inside `bench/storm/` (so: `bench/storm/my-results.md`). The table is
also printed to the terminal, and a `.json` with every run's raw numbers is written next to the
`.md`. Progress (`[12/90] storm · otel · run 3`) shows on stderr while it runs.

Other options: `--events 50000`, `--rate 10000` (errors per second), `--runs 5`,
`--scenarios storm,incident,cardinality`,
`--sdks bugbuster,bugbuster-noloss,bugbuster-agent,otel,otel-noloss,otel-json`.

## 5. What you should see

Compare your file with [`bench/storm/results.md`](bench/storm/results.md). For the `storm`
scenario (50,000 identical errors):

| Check | Expected |
|---|---|
| OpenTelemetry *Sent (wire)* | about **38 MB**, ~98 requests, 50,000 writes, nothing lost |
| BugBuster *Sent (wire)* | about **5 KB**, 2 requests, **6** writes |
| BugBuster, buffer sized to keep all | **50,000** delivered |
| BugBuster, defaults | about **4,100** delivered, **~45,900 lost, "all counted"** — a known open problem, not a failure of your setup |
| Any row saying **"lost, silently"** | **should not appear.** It was the `shutdown()` bug this branch fixes |

Expected to vary with your machine: *App CPU added*, the event-loop delay columns, *Final flush*
and *Peak RSS added*. The pattern should hold — BugBuster, sized to keep all, uses somewhat more
CPU than OpenTelemetry, and freezes the event loop for up to about a second during a flush (both
known open problems, see below).

Expected to stay close to the committed numbers: *Sent*, *Sent, gzip*, *Requests*, *Backend
writes*, *Errors delivered*.

## 6. Known open problems (not caused by your setup)

Found by this benchmark, not fixed on this branch:

1. **At default settings, BugBuster drops most of a fast storm.** The 8 MB error buffer holds
   about 4,100 errors per 5-second flush; the rest are counted as dropped, so the issue's count
   comes out too low.
2. **Folding a flush window freezes the event loop** for up to about a second, because it runs all
   at once on the main thread.
3. **Keeping every error costs more CPU than OpenTelemetry**: each one is stack-parsed, redacted
   and hashed, though only a handful become example events.

Details: [`bench/storm/README.md`](bench/storm/README.md#what-it-found-latest-run).

## 7. If something goes wrong

| Symptom | Likely cause |
|---|---|
| `zstdDecompressSync is not a function` / `zstdCompressSync` | Node older than 22.15. Upgrade Node. |
| `Cannot find module …/dist/app.js` | `pnpm build` was skipped or failed. |
| `app exited 1: …` | One SDK run crashed; the message after it is that process's error output. |
| Numbers jump around between runs | The machine is busy. Close other programs; use the default `--runs 5`, which reports medians. |
| A port or socket error | Something else is using it. The collector picks a free port; the Agent socket goes in a fresh temp directory each run. |

## 8. Sending your results back

Commit `bench/storm/my-results.md` (and its `.json`) on a branch, or paste the tables into an issue,
with your machine's CPU, core count, RAM, OS and Node version — the file's **Machine:** line lists
them.
