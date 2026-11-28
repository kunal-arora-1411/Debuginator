# Debuginator — Complete Technical Reference

**One document that explains the whole system: what it is, how every stage works, every wire
field, every endpoint, every environment variable, every collection and index, every limit and
threshold, what is deliberately missing, and how to run and test it.**

| | |
|---|---|
| **Repository** | `Debuginator` |
| **Product name (in code and docs)** | **BugBuster** |
| **npm scope** | `@bugbusterhq` |
| **What it is** | A self-hosted, error-first observability platform. The distinctive choice: errors are **fingerprinted and folded inside your process, in the SDK**, before anything touches the network. |
| **Topology** | Node SDK → (Unix domain socket) → host-local Agent → (HTTPS) → backend (Fastify) → MongoDB (one database per organization) → dashboard / Query API |
| **Languages / stack** | TypeScript (ESM), Node.js, Fastify, MongoDB, zod, pnpm workspaces, vitest |
| **License** | MIT |
| **Document status** | Written from the source tree at this commit, cross-checked against `README.md` and `docs/`. Unit suite verified locally: **231 tests / 35 files, all passing**. Integration suites were *not* run to produce this document (they need a `mongod` binary — see §30). |

> **How to read this.** §1–§5 orient you. §6–§14 are the architecture and the algorithms. §15–§21
> are a package-by-package reference. §22–§25 are the four reference tables you will come back to
> (wire format, database, HTTP API, configuration). §26–§34 are operations. §35–§38 are glossary,
> FAQ, a doc index, and provenance.

---

## Table of contents

- [1. What this document is](#1-what-this-document-is)
- [2. What Debuginator is, and what it is not](#2-what-debuginator-is-and-what-it-is-not)
- [3. Names, versions, and the things that will confuse you](#3-names-versions-and-the-things-that-will-confuse-you)
- [4. Quickstart](#4-quickstart)
- [5. The core thesis](#5-the-core-thesis)
- [6. Architecture](#6-architecture)
- [7. The pipeline stage by stage](#7-the-pipeline-stage-by-stage)
- [8. The fold, in complete detail](#8-the-fold-in-complete-detail)
- [9. Fingerprinting](#9-fingerprinting)
- [10. Exemplars, fidelity, and drop counters](#10-exemplars-fidelity-and-drop-counters)
- [11. Sampling and `adjustedCount`](#11-sampling-and-adjustedcount)
- [12. Backpressure and the directive headers](#12-backpressure-and-the-directive-headers)
- [13. The shed ladder](#13-the-shed-ladder)
- [14. Root-cause graph across services](#14-root-cause-graph-across-services)
- [15. Repository map](#15-repository-map)
- [16. Package: `@bugbusterhq/types`](#16-package-bugbusterhqtypes)
- [17. Package: `@bugbusterhq/sdk-node`](#17-package-bugbusterhqsdk-node)
- [18. Package: `@bugbusterhq/agent`](#18-package-bugbusterhqagent)
- [19. Package: `@bugbusterhq/backend`](#19-package-bugbusterhqbackend)
- [20. Package: dashboard](#20-package-dashboard)
- [21. Examples](#21-examples)
- [22. Wire protocol reference](#22-wire-protocol-reference)
- [23. Data model and MongoDB schema](#23-data-model-and-mongodb-schema)
- [24. HTTP API reference](#24-http-api-reference)
- [25. Configuration reference](#25-configuration-reference)
- [26. Deployment](#26-deployment)
- [27. Operations runbook](#27-operations-runbook)
- [28. Security and data handling](#28-security-and-data-handling)
- [29. What is deliberately not built](#29-what-is-deliberately-not-built)
- [30. Testing](#30-testing)
- [31. Development workflow](#31-development-workflow)
- [32. Design decisions and tradeoffs](#32-design-decisions-and-tradeoffs)
- [33. Roadmap: growth triggers](#33-roadmap-growth-triggers)
- [34. Troubleshooting](#34-troubleshooting)
- [35. Glossary](#35-glossary)
- [36. FAQ](#36-faq)
- [37. Documentation index](#37-documentation-index)
- [38. Appendix: file inventory and provenance](#38-appendix-file-inventory-and-provenance)

---

## 1. What this document is

This is the single-file reference for the Debuginator repository. It exists because the project's
knowledge is currently spread across a 784-line `README.md`, seven files in `docs/`, five
per-package READMEs, ~20 000 lines of deliberately commented TypeScript, and one `doc.md` that is
something else entirely (see §3).

Everything here is derived from the source tree, not from memory. Where a number appears, it is
the number in the code:

- every default is the one in `packages/types/src/config.ts` and the module that consumes it;
- every endpoint is one of the 22 route registrations in `packages/backend/src/build-server.ts`;
- every collection and index is one that `packages/backend/src/db/**` actually creates;
- every threshold (spike, root-cause hop, exemplar cap) is a named constant you can grep for.

Where the repository contradicts itself, this document says so rather than picking a winner
silently — see §3 and the "Known gaps" entries in §29.

**What this document is not:** it is not a replacement for `docs/architecture/ingest-pipeline.md`
(the *reasoning* behind the design, which is genuinely worth reading) or for `docs/api.md` (the
contract as published). It is the map of the territory, plus the detail those documents leave to
the code.

---

## 2. What Debuginator is, and what it is not

### 2.1 The one-sentence version

Your Node application reports errors and logs to a backend you host yourself; the SDK groups
duplicate errors into one *issue* with a count **before** sending, so a 50 000-event error storm
becomes a handful of aggregate records plus a few full-fidelity examples — computed where the
storm is happening, not after it has already cost you the bandwidth.

### 2.2 The problem it is aimed at

A bad deploy makes one function throw 50 000 times in 10 seconds across 40 pods. At ~5 KB per
event that is ~250 MB of identical JSON heading for your observability backend in ten seconds, at
the exact moment you most need the dashboard to stay up. Event-oriented backends either fall over
or rate-limit, and either way the dashboard is wrong during the incident it was bought for.

Debuginator's answer: **grouping is a client-side primitive, not a backend concern.** The fold
happens inside your process, where the duplicate count is free.

### 2.3 What it genuinely does today

| Capability | Status |
|---|---|
| Error capture with client-side fingerprinting and folding | **Built** |
| Application logs, stored line-by-line, searchable, live tail | **Built** |
| Trace correlation: one trace id across services, per-request log views | **Built** |
| Cross-service root-cause links (`X-BB-Cause`) | **Built in code** (documented as 0.4.0; version strings still say 0.3.0 — §3) |
| Host-local Agent daemon: cross-process merge, zstd, retries, breaker, disk spool | **Built** |
| Multi-tenant backend, one MongoDB database per org | **Built** |
| Named, revocable API keys; org disable/enable; admin web page | **Built** |
| Email alerts: new issue, new environment/service, spike | **Built** (via Brevo) |
| Storage report, log retention per org, orphaned-exemplar cleanup | **Built** |
| OpenAPI 3.1 document + Swagger UI at `/docs` | **Built** |
| Dashboard (issues + logs, single HTML file) | **Built** |
| Kafka/Redpanda durable log | **Not built** (deliberate — §29, §33) |
| Probabilistic sketches (HLL / DDSketch / Space-Saving) | **Not built** (fields are exact in v1; names are stable for the swap) |
| Per-org quota / rate limiting | **Not built** (directives exist, the decision behind them is "keep everything") |
| Git/commit correlation, AI debugger, Slack/webhook alerts | **Not built** (drawn as the roadmap) |
| SDKs other than Node | **Not built** |

### 2.4 What it is not

- **Not a drop-in OpenTelemetry replacement.** It speaks its own wire format, not OTLP. It
  interoperates with OTel at exactly one seam: `traceparent`, so a trace continues across an
  OTel-instrumented service.
- **Not a metrics system.** There are no counters/gauges/histograms as first-class objects. The
  only quantitative data is what the fold produces per issue (`count`, `usersAffected`,
  `duration` percentiles, `topEndpoints`).
- **Not a SaaS.** There is no hosted version. You run the backend, the MongoDB, and the Agent.
- **Not a profiler or an APM product.** No span trees, no flame graphs, no per-endpoint latency
  breakdown beyond an issue's `topEndpoints` and `duration`.
- **Not finished.** §29 lists, honestly and specifically, what is missing and why.

---

## 3. Names, versions, and the things that will confuse you

Read this before you file a bug about the name.

| Thing | Value | Where |
|---|---|---|
| Git repository / directory | **Debuginator** | this repo |
| Product name in every document | **BugBuster** | `README.md`, all `docs/` |
| npm package scope | **`@bugbusterhq/*`** | every `package.json` |
| Root workspace package name | `bugbuster` (private) | root `package.json` |
| systemd service | `bugbuster-agent` | `packages/agent/scripts/install.sh` |
| MongoDB control database | `bugbuster_control` | backend |
| MongoDB per-org databases | `bugbuster_org_<orgId>` | backend |
| Default socket | `/var/run/bugbuster/agent.sock` | `packages/types/src/config.ts` |
| Cache/upstream references | `github.com/kunal-arora-1411/Debuginator` and `…/BugBuster` both appear | agent `package.json`, install script |

**In this document**, "Debuginator" refers to the repository, "BugBuster" to the product, and
`@bugbusterhq/*` to the packages. They are the same system.

### 3.1 Version state (this is a real inconsistency)

| Artifact | Says | Reality |
|---|---|---|
| `packages/types/package.json` | `0.3.0` | matches |
| `packages/sdk-node/package.json` | `0.3.0` | matches |
| `packages/agent/package.json` | `0.3.0` | matches |
| `packages/backend`, `dashboard`, `demo-app` | `0.0.0`, `private: true` | never published; correct |
| `README.md` | documents 0.4.0 features as built | the code **does** contain them |
| `docs/architecture/root-cause-graph.md` | "Status: **built, for 0.4.0**" | agrees with the code |
| `docs/architecture/ingest-pipeline.md` | "**Pre-implementation — no code written yet**" | **stale**; that design is implemented |

So: the cause-graph features (§14) are in the source, documented as 0.4.0, but the three published
package versions have not been bumped to 0.4.0. If you are pinning versions, trust the code and
`git log`, not the `version` field. The release procedure is in `README.md` under *Releasing the
npm packages*: bump all three `package.json` files together, merge, then
`pnpm -r publish --access public` (pnpm, never `npm publish` — only pnpm rewrites the
`workspace:^` ranges).

### 3.2 `doc.md` is not documentation

`Debuginator/doc.md` (789 lines) is an AI-generated brainstorm about how one *might* build an
observability platform from scratch: it discusses OpenTelemetry, proposes "KBTP", sketches git
correlation and an "AI Debugger". It is the origin of the project's name choices and some idioms,
and the real code does reference it in places (the event model, the fingerprint formula). But it
is **not** a description of this repository, and it contains no accurate statement about what is
built. Do not read it as docs; the code comments point at it only for provenance.

---

## 4. Quickstart

### 4.1 Prerequisites

| Requirement | Why |
|---|---|
| **Node.js ≥ 22.15** | The Agent compresses with `node:zlib`'s `zstdCompressSync`, added in 22.15. On Node 20 it does not exist and the agent/backend tests fail with `zstdCompressSync is not a function`. CI pins Node 22 for exactly this reason. |
| **pnpm 10+** | The repo pins `packageManager: pnpm@10.30.3`; `pnpm/action-setup` reads it from `package.json`. |
| **MongoDB** | `docker compose -f infra/docker-compose.yml up -d` gives you `mongo:7` on `localhost:27017`; or any MongoDB/Atlas URI. |
| Docker *or* any mongod | only for the local walkthrough |

The SDK itself only needs **Node ≥ 20** (ESM; `require()` of it works on Node ≥ 20.19 / ≥ 22.12).

### 4.2 The five-minute path

```bash
# 1 — install and build (build order matters: types first, see §31)
pnpm install
pnpm build

# 2 — a MongoDB
docker compose -f infra/docker-compose.yml up -d

# 3 — create an organization and a key of your choosing
cd packages/backend
pnpm create-org org_demo "Demo Org" bugbuster_org_demo demo-api-key
cd ../..
```

Then three terminals:

```bash
# Terminal A — backend
cd packages/backend
BUGBUSTER_CONTROL_DB_URI=mongodb://localhost:27017 PORT=8080 pnpm start
```

```bash
# Terminal B — Agent (start it BEFORE the app: the SDK probes the socket once, at init())
cd packages/agent
BUGBUSTER_AGENT_SOCKET=/tmp/bugbuster-agent.sock \
BUGBUSTER_BACKEND_URL=http://localhost:8080/ingest \
BUGBUSTER_API_KEY=demo-api-key \
pnpm start
```

```bash
# Terminal C — the instrumented demo app
cd examples/demo-app
BUGBUSTER_API_KEY=demo-api-key BUGBUSTER_AGENT_SOCKET=/tmp/bugbuster-agent.sock pnpm dev
```

Generate telemetry and read it back:

```bash
curl http://localhost:3000/throw        # capture an error
curl http://localhost:3000/throw        # again → still ONE issue, count 2. That is the fold.
curl http://localhost:3000/orders/42    # a normal request: logged, not folded
curl http://localhost:3000/checkout     # an error plus the log lines leading up to it

curl -H "Authorization: Bearer demo-api-key" http://localhost:8080/issues
curl -H "Authorization: Bearer demo-api-key" "http://localhost:8080/logs?limit=10"
```

Open the dashboard: `pnpm --filter @bugbusterhq/dashboard dev` → <http://localhost:5173>, backend
URL `http://localhost:8080`, key `demo-api-key`. Interactive API docs: <http://localhost:8080/docs>.

On **Windows**, the socket is a named pipe: use `\\.\pipe\bugbuster-agent` for
`BUGBUSTER_AGENT_SOCKET` / `agentSocketPath`, and start the agent with `node dist/index.js`.

---

## 5. The core thesis

Four ideas, in the order they matter. Everything else in the system is a consequence.

### 5.1 Grouping belongs in the client

OpenTelemetry's data model is per-event, and it defines grouping as a **backend** concern. That is
a coherent choice for a vendor-neutral standard, but it means a spec-compliant OTel SDK
structurally *cannot* collapse a storm before transmitting it. Moving the fingerprint into the SDK
is what "unlocks a ~1000:1 compression", per `ingest-pipeline.md` §4.3 — that is the project's
actual thesis, not a marketing line.

### 5.2 The SDK is handed a budget and must maximise value inside it

X bytes/sec, Y µs per request, Z MB of RAM. Within that budget:

- **aggregate at the edge** (the fold),
- **sample with invertible math** (store the weight — §11),
- **shed by priority, not by luck** (§13),
- **carry fidelity metadata** so the dashboard can never present degraded data as complete (§10).

### 5.3 Push work to where it is cheap

There are two adversaries. The host: "we add 3 ms p99 to their checkout, they rip us out." Ours:
one customer's storm degrades ingest for everyone. The resolution is an allocation of work: the
hot path does almost nothing (a ring-buffer claim), the deferred worker does the parsing and
serialization, the **Agent** does the network (TLS, retries, compression, spool), and the edge
does auth + append and **never parses the body**.

### 5.4 Silent data loss is the cardinal sin

Every drop is counted and reported. The system is designed to be able to tell you *"your
instrumentation is degraded — you are seeing 12% of your errors."* That is only possible if the
counters were designed in from day one, which they were (§10).

---

## 6. Architecture

### 6.1 The topology

```text
your Node app  ── @bugbusterhq/sdk-node: capture → fingerprint → fold (errors) / buffer (logs)
     │
     │  Unix domain socket (same host)                 … or direct HTTPS when no Agent can run
     ▼                                                     (serverless / PaaS)
BugBuster Agent ── one per host: merges every service's batches, zstd, retries, spools to disk
     │
     │  HTTPS  POST /ingest   (Authorization: Bearer <API key>, Content-Encoding: zstd)
     ▼
Backend (Fastify) ── resolves the key to an org, then writes only to that org's own MongoDB DB
     │
     ├── Query API (/issues, /logs, /admin, /docs, /openapi.json)
     └── MongoDB  bugbuster_control + bugbuster_org_<orgId> …
              │
              ▼
         Dashboard (one HTML file)
```

Two kinds of telemetry travel the same pipeline and are treated **oppositely on purpose**:

| | Errors / messages | Logs |
|---|---|---|
| Grouped? | **Yes** — folded by fingerprint into an issue | **No** — one stored document per line |
| Why | 50 000 identical failures are one fact | collapsing 10 000 "order placed" lines destroys exactly what you read logs for |
| Volume bound | fingerprint cardinality (`maxLiveFingerprints`, default 10 000) | byte caps + retention + the Agent's own caps |
| Exemplars | up to 6 full events per issue | n/a — the line *is* the record |
| Meets the other half at | the **trace id** | the **trace id** |

That trace id is what makes the two halves worth having together: every log line written during a
request carries the same id as the errors that request raised, so the dashboard jumps from an error
straight to everything that request logged, in every service it passed through.

### 6.2 The layers

| Layer | Runs in | Job | Budget |
|---|---|---|---|
| **L0** hot path | your process | `capture() → ring buffer` | < 5 µs per log, < 50 µs per exception; 0 syscalls; 0 JSON |
| **L1** worker | your process | fingerprint → **fold** → serialize | deferred; off the request path |
| **UDS hop** | same host | SDK → Agent | µs; no TLS (data never leaves the machine) |
| **L2** Agent | our daemon | cross-process fold merge · disk spool · one connection · zstd | bounded queues, 512 KB batches |
| **L3** edge | backend | auth · size · priority · append | target p99 < 15 ms; never parses the body |
| **L4** storage | MongoDB | one database per org | — |
| **L5** processing | backend, in-process | fold merge upserts, cause links, alerts | best-effort; never fails the request |

The two load-bearing pieces, per the architecture doc: **L1's fold** and **L3 never parsing the
body**.

### 6.3 The SDK picks its transport mode by itself

At `init()` the SDK probes `agentSocketPath`:

- **socket exists** → `UdsTransport` (Agent mode). The required path for backend-hosted services.
- **no socket** → `HttpTransport` pointed at `backendUrl` (direct mode). Real for
  browser/mobile/serverless; a dev convenience everywhere else.

This is checked **once**, not per flush. If an Agent appears or disappears mid-process, restart the
app. If neither an Agent nor a valid `backendUrl` exists, the SDK falls back to
`http://localhost:0/ingest` — a guaranteed-failing URL chosen so that capture still works and drops
are counted rather than the process crashing (a unit test asserts exactly this: `init()` never
throws when the backend is entirely unreachable).

### 6.4 Why an Agent at all

With N pods posting directly you get N TLS handshakes, N connection pools, N retry timers, and —
the one that actually matters — **N disjoint fold windows**, so each pod only sees its own slice of
the storm and the fold ratio is N times worse. The Agent accumulates every service's deltas on the
host into one shared merge before the single network hop.

At pilot scale the fold-ratio win is not yet the point; the architectural win is that the SDK's
entire network story collapses to *"serialize, write to a socket, forget."* No TLS, no compression,
no retries, no disk, no circuit breaker **inside your process**.

---

## 7. The pipeline stage by stage

A single error, followed all the way through.

### 7.1 Stage 0 — the call

```ts
bugbuster.captureException(err);
```

`init()` returns an engine whose `captureException` is wrapped in `try/catch` covering its entire
body. Rule 1: **no public entry point may throw into your code.**

Inside, in order:

1. **Duplicate-object guard.** A `WeakSet` of already-captured `Error` objects. The same object
   captured twice (a console hook *and* an explicit call) counts once. `WeakSet` so a long-lived
   process never retains errors past their own lifetime.
2. **Recursion guard.** A module-level `inCapture` flag, not per-instance — a logger → SDK → logger
   loop can re-enter across any two engine calls on the same thread. Return immediately if set.
3. **Sampler check.** `sampler.keep(kind)`; if dropped, `counters.sampledOut++`. In v1 the sampler
   starts at `{error: 1, log: 1, span: 1}` and only changes if the backend sends a directive (§12).
4. **Context read.** `getCurrentContext()` — the `AsyncLocalStorage` store, if this is inside a
   request. Read now, not at flush: a later downstream failure in the same request must not be
   credited with causing an error that happened earlier.
5. **Ring claim.** `ring.claim(raw, approxBytes)`. If it returns false, `counters.droppedBufferFull++`.
   **Drop, never block, never grow past the byte cap.**
6. **High-water mark.** `counters.bufferHighWaterBytes = max(…, target.usedBytes)`.

The captured record is a *reference*: the live `Error` object, an unparsed stack, a shallow copy of
log fields. No serialization, no stack parsing, no regex, no allocation beyond one slot.

Cost accounting is deliberately approximate — `APPROX_BYTES_PER_CAPTURE = 2048` flat for errors,
and for logs `200 + 2 × message.length + 512 if fields` — because `JSON.stringify` on the hot path
is exactly the mistake the design forbids, and a live `Error` may be circular anyway.

### 7.2 Stage 1 — the flush (deferred)

A `setInterval` at `flushMaxDelayMs` (default 5 s), **`unref()`'d** so the timer can never be the
reason your process fails to exit. `shutdown()` clears it and races a flush against
`shutdownFlushTimeoutMs` (default 2 s).

On each flush:

1. If the backend previously sent `X-BB-Retry-After` and the pause has not elapsed, **skip the send
   entirely** — capture and fold keep running underneath; only the network is withheld.
2. `ring.drain()` → for each raw non-log capture: parse the stack, compute the fingerprint, record
   into the fold table, and note if the fingerprint is new to this process.
3. `logRing.drain()` → build `LogEntry` objects. **Logs never touch the fold table.**
4. `foldTable.drain()` → `{ deltas, exemplars }`.
5. If there is nothing to send, return.
6. Split logs into batches of at most `flushMaxBatchBytes` (512 KB). **The error path always rides
   in the first envelope**, with the first log batch.
7. Build and send. On success, `counters.consume(sentMeta)` subtracts what was reported so the next
   meta record does not double-count. On failure, every unsent log line is added to
   `counters.droppedQuota` — counted, not silently lost.
8. Continue with the remaining log-only batches, checking `retryAfterUntilMs` between each.

One subtlety worth knowing: **drop counters are included in the first envelope only.** The Agent and
backend sum every `meta` item they receive; repeating them on each follow-up batch would report N×
the drops.

### 7.3 Stage 2 — the Agent

`UdsServer` accepts NDJSON on the socket, decodes complete lines, and accumulates into four pending
sets: folds, exemplars, logs, meta. Every 5 s (or on demand):

1. **Replay the spool first** — batches that failed previously go out before newer data
   (best-effort ordering, not a strict guarantee). A still-failing spool entry is re-spooled.
2. `mergeFoldDeltas(...)` — cross-process fold (§8.6), preserving the **highest priority** seen per
   fingerprint so a never-shed signal from any single service survives the merge.
3. Merge meta records; if the Agent itself shed log lines, add them as a `meta` item so the loss is
   reported upstream in the same channel the SDK uses.
4. Split logs into ≤ 512 KB batches; folds/exemplars/meta ride in the first.
5. `AgentHttpClient.send()` per payload — zstd-compress, `POST` with bearer auth; on failure, spool
   if configured, otherwise lose the batch (the documented behaviour: a counted drop, not a crash).

### 7.4 Stage 3 — the ingest edge

`POST /ingest` on the backend:

1. Extract the bearer token, resolve it to an org — from a hash lookup with a cache (see §19.5).
   **401** for missing/unknown/revoked, **403** for a disabled org, both **before any tenant
   database is touched**.
2. Reject bodies over `ingestMaxBodyBytes` (**2 MiB** by default: `4 × 512 KB`) with **413**.
3. Decompress (`zstd`), decode NDJSON items, and process: fold deltas merged into issues by an
   atomic upsert; exemplars inserted idempotently; logs inserted idempotently; `meta` summed.
4. Trigger any pending alert work (best-effort).
5. Reply **202 Accepted** with an empty body and the four directive headers.

### 7.5 Stage 4 — storage, and 5 — reading it back

Per-org databases hold `issues`, `issue_links`, `events`, `deploys`, `logs` (§23). The Query API
reads them (§24); the dashboard renders issues and logs; `GET /issues/:fingerprint/exemplars`
resolves the references to full payloads only when someone actually opens an issue.

---

## 8. The fold, in complete detail

This is the single most important mechanism in the system. If you understand one thing about
Debuginator, make it this.

### 8.1 What it collapses

Input (one flush window, one process):

```text
50 000 occurrences of fp_3fa9c01d2b7e4410
   ├─ 50 000 × count
   ├─ 3 812 distinct user ids
   ├─ latency samples
   ├─ endpoint counts  { "/checkout": 49 870, "/retry": 130 }
   ├─ releases seen    { "2.8.1" }
   └─ caused by        { "fp_a1b2…": 49 870 }
```

Output on the wire: **one `FoldDelta` + at most 6 `BugBusterEvent` exemplars.** The architecture doc
measures the storm case as ~40 KB instead of 250 MB — four orders of magnitude.

### 8.2 What a `FoldDelta` carries, and why it is raw

A delta deliberately carries the **ingredients**, not the answers:

```ts
{
  fingerprint: "fp_3fa9c01d2b7e4410",
  windowStart: "2026-11-05T09:00:00.000Z",
  windowEnd:   "2026-11-05T09:00:05.000Z",
  count: 50000,
  userIds: ["u_1", "u_2", …],              // raw ids, not a cardinality estimate
  endpointCounts: { "/checkout": 49870 },  // raw counts, not a top-K
  durationSamplesMs: [12, 15, 5000, …],    // raw samples, not percentiles
  release: "2.8.1",
  service: "orders-api",
  exemplars: ["evt_a", "evt_b"],           // ids; payloads travel separately
  causedBy: { "fp_a1b2…": 49870 }          // optional
}
```

Percentiles and distinct-user counts are only correct once merged across **every** window and
**every** process that observed the fingerprint. Pre-computing them in one process would give you a
confident wrong number. So the backend does the arithmetic, in one atomic upsert per delta.

There is a second reason, which the architecture doc is honest about: because fingerprinting moved
into the SDK, **the algorithm is now part of the wire contract**. Sending the grouping *inputs*
alongside the fingerprint is the mitigation that lets a future backend re-fingerprint on demand.
(That mitigation is designed, not built.)

### 8.3 The fold table, in code

`FoldTable` (`packages/sdk-node/src/worker/fold.ts`) keys entries by fingerprint within a flush
window. Per entry it keeps:

`windowStart`, `count`, `userIds: Set`, `endpointCounts: Map`, `durationSamplesMs: number[]`,
`releases: Set`, `service`, `firstEvent`, `lastEvent`, `slowestEvent`, `slowestMs`,
`novelStackEvent?`, `perReleaseEvent: Map`, `causedBy: Map`.

`record()` handles the first sighting, then increments/accumulates. `causedBy` is bounded:
`MAX_CAUSES_PER_DELTA = 16` distinct causes per delta; past that, new causes are dropped rather than
growing the map.

### 8.4 Exemplar selection and roles

`selectExemplars()` pushes in this priority order, de-duplicating by `eventId` and stopping at
**6**:

1. `one-novel-stack` — the first occurrence of a fingerprint this process has never seen
2. `first` — the first occurrence in the window
3. `last` — the most recent
4. `slowest` — the highest `durationMs` seen
5. `one-per-release` — one event for each distinct release in the window

The roles are the enum in `packages/types/src/event.ts`:
`"first" | "last" | "slowest" | "one-per-release" | "one-novel-stack"`. If one event qualifies for
several, `roleFor()` resolves in the order above (novel-stack wins).

Why these five: they are the five questions you ask about a storm — *what did it look like the
first time, what does it look like now, what was the worst case, did a deploy cause it, and is this
a genuinely new shape of failure.*

### 8.5 Cardinality is the real enemy — coarsening

Volume compresses; **cardinality kills**. It blows up the SDK's fold table, the server's index, and
query latency.

The cap is `maxLiveFingerprints` (default **10 000** per process per window). When a genuinely new
fingerprint arrives and the table is already at capacity, the SDK does **not** grow and does **not**
drop: it routes the occurrence into a shared overflow bucket keyed `"__coarsened__"`
(`COARSENED_KEY`). Fingerprints already being tracked keep updating normally. Degrade gracefully,
never OOM.

Two related behaviours:

- `computeCoarsenedFingerprint(input, depth)` exists to strip *more* trailing frames so more
  distinct-but-related errors collide into one fingerprint on purpose. The default hashed depth is
  `DEFAULT_FINGERPRINT_DEPTH = 10`.
- High-cardinality attributes are supposed to be demoted into the exemplar payload rather than the
  grouping key. (Design intent; the current key is `type + stack + service`, so this is structural
  rather than a runtime check.)

### 8.6 Cross-process merge

`mergeFoldDeltas()` merges same-fingerprint deltas from every service on the host:

| Field | Merge rule |
|---|---|
| `count` | sum |
| `userIds` | set union |
| `durationSamplesMs` | concatenate |
| `exemplars` | concatenate |
| `endpointCounts` | per-key sum |
| `causedBy` | per-key sum, under the same `MAX_CAUSES_PER_DELTA` cap |
| `windowStart` | earliest |
| `windowEnd` | latest |
| `release` | **first-seen wins** (a documented v1 simplification — it is a single string, not a set) |

Note the interaction with fingerprinting: since SDK 0.3 the **service name is part of the
fingerprint**, so this merge only ever combines one service with *itself* — i.e. its other processes
on the same host. Two different services' deltas stay separate issues.

### 8.7 Where the aggregate is kept

The stored `issues` document is **not** the API's `Issue` type. It keeps the raw ingredients
(`userIdSet`, `endpointCounts`, `durationSamplesMs`) and the API derives `usersAffected`,
`duration`, `topEndpoints` at read time. `durationSamplesMs` is capped at the most recent **1000**
samples (`$push` + `$slice: -1000`) so a hot issue cannot grow unbounded.

Why keep raw values when sketches exist? Because at pilot volume HLL and DDSketch are *measurably
worse* than an exact answer at low cardinality. v1 computes exactly; the field **names** in
`Issue` are deliberately the ones a sketch swap would keep, so upgrading later is a value-type
change, not a schema migration or a rename:

| Need | v1 | v2 replacement |
|---|---|---|
| distinct users | exact `userIdSet.length` | **HyperLogLog++** (sparse) |
| latency distribution | exact samples → percentiles | **DDSketch** (±1% relative error, mergeable) |
| top endpoints | exact counts → top-K at read | **Space-Saving top-K + explicit `other`** |

---

## 9. Fingerprinting

### 9.1 The formula

```text
base     = errorType :: normalizedStack :: primaryFunction
material = service ? (service :: base) : base
fingerprint = "fp_" + sha256(material).hex.slice(0, 16)
```

- `errorType` — the error's `name` (or the synthetic name for a handled 5xx).
- `normalizedStack` — in-app frames joined with `|`, each rendered `function@basename:line`.
- `primaryFunction` — the function of the first kept frame (or `<unknown>`).
- `service` — the SDK's `project`. **Added in 0.3**; absent means the material is byte-identical to
  pre-0.3, which is how old fingerprints stay matchable.

The result is a 16-hex-char hash behind a `fp_` prefix — the shape the `X-BB-Cause` header accepts:
`/^fp_[0-9a-f]{16}$/`.

### 9.2 What is deliberately normalized, and what is not

| Kept | Why |
|---|---|
| **line and column** | two different lines in the same function are structurally different bugs until proven otherwise |
| **function name** | part of the primary entry point |

| Normalized | Why |
|---|---|
| file path → **basename only** | the same source file built into two different deploy paths must still collide |
| **runtime/internal frames dropped** | Node internals and event-loop resumption frames are genuinely nondeterministic after an `await` |
| stack depth → **first 10 in-app frames** | frames above that are caller context — which handler called in — and vary between two occurrences of the identical bug |
| service → part of the key | a shared library's error in two services should be two issues, not one counting both |

The depth limit is the subtle one. Hashing the whole stack would treat "same bug, different caller"
as a different bug — the same over-fragmentation problem coarsening exists to fix, just triggered by
caller depth instead of cardinality pressure. Ten frames captures the call path inside the failing
subsystem and drops the generic framework/runtime frames above it.

### 9.3 Consequences you will actually observe

- **Upgrading a service to 0.3 changes every fingerprint once.** Its errors start new issues with
  the same titles; the old ones stop growing. The backend accepts both. This already happened once,
  and it is why §8.2's "send the grouping inputs" mitigation matters.
- **`HandledHttpError`s group by name, not stack.** The synthetic error recorded for a 5xx that
  nothing reported has a *fixed* stack (`at respond (bugbuster/express:1:1)`) and a name of
  `HandledHttpError:<METHOD>:<route>` — deliberately, because a captured stack would depend on the
  call site and the SDK's own line numbers, giving a different fingerprint per call site and per
  SDK version. Grouping comes from the method + route, which is what the issue is about.
- **`fingerprintOf(error)` is public.** It returns the fingerprint an error *would* group under, is
  cached in a `WeakMap`, and returns `undefined` rather than throwing if it cannot compute one. This
  is what fills the `X-BB-Cause` header.

---

## 10. Exemplars, fidelity, and drop counters

### 10.1 Exemplar cap

At most **6** exemplars are stored per issue. The cap is enforced in **application code**
(`MAX_EXEMPLARS_PER_ISSUE` in the fold table, and `addExemplarRef` in the backend), not by MongoDB —
capped collections cannot express "6 per key". Exemplars past the cap are not stored.

### 10.2 "Drop counters are sacred"

Every envelope can carry a `meta` item:

```json
{
  "droppedBufferFull": 0,
  "droppedQuota": 0,
  "sampledOut": 0,
  "bufferHighWaterBytes": 0,
  "selfCpuPct": 0,
  "configVersion": 0
}
```

Six fields, each with a job:

| Field | Means |
|---|---|
| `droppedBufferFull` | ring buffer hit its byte cap; the occurrence was refused |
| `droppedQuota` | unsent log lines (batch failure, or a `Retry-After` pause outlasting the buffer) |
| `sampledOut` | discarded by the sampler |
| `bufferHighWaterBytes` | the peak buffer occupancy observed — the memory number that actually moved |
| `selfCpuPct` | our own CPU share (0–100), for the self-throttle rule |
| `configVersion` | which directive set the sender was obeying |

The design argument: this enables a feature almost nobody ships well — *"your instrumentation is
degraded; you are seeing 12% of your errors."* The counters must exist from day one or the feature
is unfixable later.

The Agent participates: log lines it sheds under pressure are reported upstream as a `meta` item
with `droppedBufferFull` set to the shed count, so a loss inside our own daemon is visible in the
same channel as a loss in your process.

### 10.3 Fidelity on every issue

The API attaches a fidelity block to each issue:

```ts
fidelity: { isExact: boolean, adjustedCount: number }
```

`isExact === false` exactly when `adjustedCount !== 1.0`, i.e. when sampling was applied and `count`
is a weighted estimate. The dashboard shows a badge rather than presenting a sampled count as truth.
Current reality: nothing samples down in v1, so `isExact` is `true` in normal operation — the
mechanism is real and tested, the decision to use it is not yet driven by signal.

---

## 11. Sampling and `adjustedCount`

### 11.1 What is sampled

Per event kind, with initial rates `error: 1, log: 1, span: 1`. Rates only change when the backend
sends `X-BB-Sample-Directive` (§12). Nothing is down-sampled by default.

### 11.2 The correctness rule most systems botch

> **Always store the sampling weight.**

Every stored record carries `adjustedCount` (the glossary spells it `adjusted_count`; the API and
schema use `adjustedCount` — a naming inconsistency, not a behaviour difference). The dashboard can
then read *"~50 000 occurrences (2 500 sampled, 20× weight)"* instead of presenting 2 500 as if it
were 50 000. Retrofitting this is nearly impossible, so it is a schema decision made now, not later.

### 11.3 Head vs tail sampling, and this project's compromise

- **Head sampling** is cheap but decides before you know whether the request errored or was slow —
  precisely the information that determines whether you want it.
- **Tail sampling** is correct but needs all of a trace's spans buffered in one place, arriving from
  different services.
- **The compromise** (designed, and the shape the SDK is built around): buffer a request's spans
  *in-process* until that process's part of the request finishes. The outcome is then known locally
  and for free, so you can retroactively upgrade — errored or over p95 → keep everything. That
  captures most of tail sampling's value with none of the distributed machinery. True tail sampling
  in a collector (consistent-hash spans by `traceId`, hold ~20 s) is a v2 feature.

---

## 12. Backpressure and the directive headers

The mechanism that "actually protects the API", and where OTel has essentially no story: the
backend tells the SDK to **generate less**, not just to send less.

### 12.1 The four headers

Sent on the `202` response from `POST /ingest`:

| Header | Wire shape | Meaning |
|---|---|---|
| `X-BB-Sample-Directive` | `{"error":1.0,"log":0.02,"span":0.005}` | per-event-type sample rates, 0.0–1.0. The SDK stops *generating*, not just sending. |
| `X-BB-Suppress-Fingerprints` | `["fp_a1b2c3d4e5f60718"]` | those fingerprints: **counts only, no exemplar payloads**, for a 10-minute window (`SUPPRESSION_WINDOW_MS`) |
| `X-BB-Retry-After` | `30` | seconds; the SDK pauses network sends until then (capture and fold keep running) |
| `X-BB-Config-Version` | `42` | integer; lets an SDK detect that the directive set changed |

Per-fingerprint suppression is only possible *because* fingerprinting happens client-side: the
backend can name a specific fingerprint rather than only being able to throttle by volume. Once we
hold 50 000 samples of `fp_a1b2…`, we do not need the 50 001st payload; we need the count.

### 12.2 The v1 honest reality

`computeDirectives()` in the backend returns the "keep everything" set:

```ts
{ sample: { error: 1, log: 1, span: 1 }, suppressFingerprints: [], configVersion }
```

Nothing is under measured pressure at pilot scale, so the decision is trivially correct rather than
fabricated adaptive logic with no signal behind it. The **wire mechanism** (SDK obeys the headers
unconditionally) is real and tested; only the policy is trivial.

### 12.3 Known gap: the loop is open in Agent mode

`UdsTransport.send()` always resolves with `directives: undefined` — a socket per request has no
natural place to return response headers from a daemon that batched several clients together. So a
real SDK running *behind an Agent* does not yet obey the directives the way one in direct mode does.
The transport interface (`Transport`) is the seam where that would be closed.

### 12.4 Upward backpressure — protecting the host when we are down

| Mechanism | Value |
|---|---|
| connect timeout | 2 s |
| total timeout | 10 s |
| retries | 3 attempts, **5xx and network only, never 4xx** |
| backoff | **full jitter**: `random() × min(8000, 500 × 2^attempt)` ms |
| circuit breaker | 5 consecutive failures → open; 30 s cooldown → half-open (one probe); success → closed |
| disk spool | **off** in the SDK (never write to someone's disk uninvited), **on** in the Agent, bounded |
| memory ceiling | 8 MB ring by default; cross it, drop and count |

Full jitter is non-negotiable: without it, thousands of customer fleets all retry at `t+30s` and
DDoS you on recovery. Retrying 4xx is the classic way a monitoring agent *becomes* the outage.

The breaker's states are exactly three: **CLOSED** (normal), **OPEN** (fail instantly, no network
call at all), **HALF-OPEN** (exactly one probe in flight — claimed atomically; a failed probe
restarts the full cooldown). A send that the breaker refuses returns `attempted: false` rather than
an error, so the caller can distinguish "we didn't try" from "it failed".

---

## 13. The shed ladder

Every envelope item carries a **priority byte**, stamped in the SDK, so an edge can decide what to
drop **without parsing the payload**. Only six values are legal; 4–7 are unused:

| Priority | Item | Under pressure |
|---|---|---|
| **0** | debug logs | shed first, shed freely |
| **1** | info logs | shed early |
| **2** | spans on healthy endpoints (no error, no tail) | shed |
| **3** | aggregate counts (non-error); also warn/error logs | loses accuracy, not events |
| — | *hard line* | — |
| **8** | 5xx exemplars | **never shed** |
| **9** | first occurrence of a new fingerprint | **never shed** |

In code: `PrioritySchema` (a zod union of exactly those six literals) and
`NEVER_SHED_PRIORITIES = [8, 9]`. Log priority mapping is `debug → 0`, `info → 1`, `warn/error → 3`.

The `NEVER SHED` line is a **product** decision as much as an engineering one: the first sighting of
a novel error is the highest-information byte in the entire system — it must survive everything. A
novel fingerprint appearing once outranks a million repeats of a known one.

The Agent applies the same ladder to its own queues: past the soft cap, debug/info lines are
refused, while warn/error (priority ≥ `KEEP_PRIORITY = 3`) are admitted up to **2×** the cap
(`HARD_CAP_FACTOR`). Refusals are counted, never hidden.

---

## 14. Root-cause graph across services

When the database times out in `inventory`, `orders` fails because inventory did, and `checkout`
because orders did — you get three issues for one failure. This feature says so.

```text
checkout ──▶ orders ──▶ inventory ──▶ MongoDB (timeout)
   │            │            └─ MongoTimeoutError      ← the cause
   │            └─ "inventory returned 500"            ← a symptom
   └─ "orders returned 500"                            ← a symptom of a symptom
```

### 14.1 Why it cannot use traces

Tracing systems rebuild each request's tree and find the deepest error. Debuginator cannot, by
design: the SDK folded, so only a handful of example events — and their trace ids — ever reach the
backend. Joining examples by trace id works only for the rare request picked as an example in
*every* service. **Keeping every trace id would undo the fold, which is the whole point.** So cause
and effect is computed **where the fold happens — in the SDK — and folded too.**

### 14.2 The five-step mechanism

1. **Callee names the issue.** A request that came from another traced service and ends in a 5xx
   gets one response header: `X-BB-Cause: fp_3fa9c01d2b7e4410`. The value is the fingerprint of the
   first error that request captured, or of the synthetic `HandledHttpError` for a 5xx nothing
   reported.
2. **Caller remembers it.** An instrumented `fetch` (or a call the app reports with
   `noteDownstreamResponse`) reads the header and stores the fingerprint on the current request's
   context (`ctx.downstreamCause`).
3. **Caller's later errors record the link.** Every error captured in that request afterwards is
   tagged `causedBy: <that fingerprint>`. The fold table counts, per fingerprint, how many
   occurrences followed each cause.
4. **Links fold like errors.** 50 000 occurrences cost one fold record; the link is a few bytes
   inside it. The Agent sums `causedBy` across processes exactly as it sums counts.
5. **Backend keeps a graph.** Each `(cause, effect)` pair is one document with a running count.
   Issues are nodes; links are edges.

The chain is built **one hop at a time**: inventory tells orders, orders tells checkout. No service
ever needs to know more than its immediate callee, and no trace has to be kept whole.

### 14.3 Wire format

| Where | Field | Shape |
|---|---|---|
| HTTP response | `X-BB-Cause` | `fp_` + 16 hex; only on 5xx, only to traced callers |
| `FoldDelta` | `causedBy` | `Record<fingerprint, count>`; omitted when empty; ≤ 16 causes |
| `BugBusterEvent` | `causedBy` | a single fingerprint — this occurrence's cause, so an exemplar is evidence for the link |

Both new fields are optional, so mixed-version deployments keep working: an old backend ignores the
field, an old SDK never sends it, an old Agent forwards the first delta's map only (under-counting
links, never inventing them).

### 14.4 Reading the graph

- **share** = `link.count / effect.count` — the fraction of the effect's occurrences that followed
  that cause. Counts are lifetime counts on both sides, so the share stays honest even when the
  issue predates the incident.
- **symptom threshold**: share ≥ **0.5** (`SYMPTOM_MIN_SHARE`).
- **root-cause walk**: step to the strongest cause while each step's share is ≥ 0.5; stop at an
  issue with no such cause, at a cycle, or after **8 hops** (`MAX_ROOT_CAUSE_HOPS`). If the walk
  moved at all, the issue it stopped at is the root cause.
- **neighbours listed**: at most **20** per direction (`MAX_LINKS_LISTED`), strongest first.
- Reads drop dangling links with a `$lookup` on `issues`, so a fingerprint heard from another org
  is never shown.

### 14.5 Safety and cost of the header

`X-BB-Cause` is an opaque hash, sent **only** when the incoming request carried a `traceparent` —
i.e. the caller is another traced service, almost always internal. Browsers and outside clients
never send one, so they never see the header. `createExpressIntegration(client, { causeHeader: false })`
turns it off entirely. On the reading side, only calls that `instrumentFetch` propagates to
(`propagateTo`) are read, and a value that is not a well-formed fingerprint is ignored.

Cost: **nothing is added to a successful request.** On a 5xx to a traced caller, the fingerprint is
computed when the response headers are written (stack parse + one SHA-256, tens of µs) and **cached
on the error** so the flush reuses it — the work moves earlier, it is not done twice. On the caller,
one header read per failed downstream response. Memory: one optional string per request, and at most
16 cause counters per fingerprint per window.

### 14.6 What it cannot see (stated, not hidden)

- **Both sides must run the SDK.** A callee without Debuginator sends no header; the caller's error
  is then its own root — the honest answer from what is known.
- **A caller that swallows the failure** and later throws something unrelated in the same request
  still gets the link. The share threshold keeps an occasional coincidence from labelling an issue a
  symptom.
- **Non-HTTP hops** (queues, gRPC) are not covered yet. The SDK side is one call —
  `noteDownstreamResponse({ status, headers })` — so a consumer can report the cause the same way
  once a producer-side carrier exists.
- **Retries.** A request that fails downstream, retries, and succeeds still had a failure: an error
  captured afterwards links to it. Only a *later* failure in the same request replaces the
  remembered cause.
- **Capture order matters.** If your error handler sends the 500 *before* calling
  `captureException`, the header names the synthetic error and the caller's link points at an issue
  that is then never recorded. Capture before responding and the caller gets the real cause.

---

## 15. Repository map

```text
Debuginator/
├── README.md                     the primary (784-line) guide — read this too
├── DEBUGINATOR.md                ← this document
├── doc.md                        brainstorm, NOT documentation (§3.2)
├── CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  LICENSE
├── package.json                  workspace root, scripts, pnpm pin
├── tsconfig.base.json tsconfig.json  eslint.config.js  .prettierrc.json
├── .github/
│   ├── workflows/ci.yml          format → lint → typecheck → build → unit → integration
│   ├── pull_request_template.md
│   └── ISSUE_TEMPLATE/
├── infra/docker-compose.yml      mongo:7 on 27017, healthchecked, named volume
├── docs/
│   ├── api.md                    HTTP contract in prose
│   ├── schema.md                 MongoDB collections and indexes
│   ├── glossary.md               572 lines of definitions (genuinely good)
│   ├── runbook.md                the local walkthrough, step by step
│   ├── ai-agent-integration.md   a ready-made prompt for AI coding agents
│   ├── upgrade-to-0.3.md         upgrade prompt (fingerprints change once)
│   ├── openapi.json              committed OpenAPI 3.1 doc; a test fails if stale
│   └── architecture/
│       ├── ingest-pipeline.md    THE design document (reasoning, budgets, §10 triggers)
│       ├── root-cause-graph.md   the cause graph (marked built, for 0.4.0)
│       └── *.png, *.html         diagram + eight-plate blueprint
├── examples/
│   ├── demo-app/                 instrumented Express app + the real end-to-end tests
│   └── root-cause-demo/traffic.mjs  three chained services, no app needed
└── packages/
    ├── types/                    wire contract (zod). No runtime deps but zod.
    ├── sdk-node/                 the in-process SDK
    ├── agent/                    the host daemon + installer scripts
    ├── backend/                  Fastify ingest + Query API + admin + alerts
    └── dashboard/                one HTML file, no build step
```

| Package | npm name | Published | Role |
|---|---|---|---|
| `packages/types` | `@bugbusterhq/types` | yes (0.3.0) | the wire-format contract |
| `packages/sdk-node` | `@bugbusterhq/sdk-node` | yes (0.3.0) | capture, fingerprint, fold, logs, transports, Express |
| `packages/agent` | `@bugbusterhq/agent` | yes (0.3.0) | cross-process merge, zstd, retries, breaker, spool |
| `packages/backend` | `@bugbusterhq/backend` | private | ingest + API + admin + alerts |
| `packages/dashboard` | `@bugbusterhq/dashboard` | private | static viewer |
| `examples/demo-app` | `@bugbusterhq/demo-app` | private | example + E2E tests |

---

## 16. Package: `@bugbusterhq/types`

The wire-format contract. Nine source files, zod schemas plus exported constants. Every other
package depends on it; it depends only on `zod`.

### 16.1 `config.ts` — budgets as defaults

| Constant | Value | Bounds |
|---|---|---|
| `DEFAULT_RING_BUFFER_BYTES` | `8 × 1024 × 1024` (8 MB) | SDK error-buffer memory ceiling |
| `DEFAULT_LOG_BUFFER_BYTES` | 4 MB | **separate** log ring, so a log flood can never evict an exception |
| `DEFAULT_LOG_RETENTION_DAYS` | `7` | log TTL |
| `DEFAULT_MAX_LIVE_FINGERPRINTS` | `10 000` | fold-table cardinality per process per window |
| `DEFAULT_FLUSH_MAX_BATCH_BYTES` | `512 × 1024` | one request's payload |
| `DEFAULT_FLUSH_MAX_DELAY_MS` | `5 000` | flush interval |
| `DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS` | `2 000` | hard cap so shutdown never delays a deploy |
| `DEFAULT_CONNECT_TIMEOUT_MS` | `2 000` | Agent connect |
| `DEFAULT_TOTAL_TIMEOUT_MS` | `10 000` | Agent request |
| `DEFAULT_MAX_RETRIES` | `3` | 5xx/network only |
| `DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | consecutive failures to open |
| `DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS` | `30 000` | open → half-open |

Three config schemas: `SdkConfigSchema`, `AgentConfigSchema`, `BackendConfigSchema`. Every field's
default lives here, which is why this file is the single source of truth for §25.

### 16.2 `envelope.ts` — the batch unit

```ts
Priority = 0 | 1 | 2 | 3 | 8 | 9
NEVER_SHED_PRIORITIES = [8, 9]
DropCounters { droppedBufferFull, droppedQuota, sampledOut,
               bufferHighWaterBytes, selfCpuPct, configVersion }
EnvelopeItem = discriminatedUnion("type"):
    { type: "fold",     priority, payload: FoldDelta }
    { type: "exemplar", priority, payload: BugBusterEvent }
    { type: "meta",     priority, payload: DropCounters }
    { type: "log",      priority, payload: LogEntry }
Envelope { sentAt, sdkVersion, items }
```

`Envelope` is the **decoded** shape. The framing (newline-delimited) is a transport concern in
`codec.ts` and the Agent's socket server — see §22.

### 16.3 `event.ts` — one full-fidelity exemplar

```ts
ExemplarRole = "first" | "last" | "slowest" | "one-per-release" | "one-novel-stack"
TraceContext { traceId, spanId, parentSpanId? }
ServiceContext { name, version, environment }
SourceLocation { function, file, line }
ErrorDetails { type, code?, message, stacktrace }
EventType = "exception" | "message" | "span"
BugBusterEvent {
  eventId, fingerprint, exemplarRole, timestamp, type,
  trace, service, source, error?, causedBy?
}
```

The doc comment is explicit that this resolves a gap between `doc.md`'s informal event sketch and
the fold-first architecture, adding `fingerprint` and `exemplarRole` because an exemplar only makes
sense in relation to the issue it is evidence for.

### 16.4 `issue.ts` — the aggregate and the delta

```ts
DurationPercentiles { p50, p95, p99 }
TopEndpointEntry   { endpoint, count }
TopEndpoints       { top: TopEndpointEntry[], other }
ExemplarRef        { eventId, role }
IssueCause         { fingerprint, count, share }
Issue              { fingerprint, count, usersAffected, duration, topEndpoints, releases,
                     firstSeen, lastSeen, exemplarRefs, adjustedCount, title?, services,
                     environments, causedBy? }
FoldDelta          { fingerprint, windowStart, windowEnd, count, userIds, endpointCounts,
                     durationSamplesMs, release?, service?, exemplars, causedBy? }
```

Constants: `ISSUE_TITLE_MAX_CHARS = 500`, `SYMPTOM_MIN_SHARE = 0.5`, `MAX_CAUSES_PER_DELTA = 16`.
`adjustedCount` defaults to `1.0`; `services` and `environments` default to `[]`.

### 16.5 `log.ts` — the line that is its own record

```ts
LogLevel = "debug" | "info" | "warn" | "error"
LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 }
MAX_LOG_MESSAGE_CHARS = 8 * 1024
MAX_LOG_FIELDS_BYTES  = 16 * 1024
LogTrace { traceId, spanId? }
LogEntry { logId, timestamp, level, message, fields?, trace?, service }
```

The comment states the design reason plainly: a log is **never** fingerprinted or folded, because
collapsing 10 000 "order placed" lines into `count: 10000` destroys exactly what a developer reads
logs for. What logs *do* share with the error path: the same hot path, the same redaction, the same
Agent hop, the same tenant isolation, and — via `trace` — the same trace context.

### 16.6 `org.ts` — the control plane

```ts
MAX_ALERT_RECIPIENTS = 20
OrgAlerts      { enabled, recipients[], services?, environments?, includeStack, spikes?, since }
OrgAlertState  { sentAt[], lastSentAt?, lastError?, lastErrorAt?, leaseUntil? }
OrgRecord      { orgId, name, dbName, apiKeyHash?, createdAt, logRetentionDays?,
                 disabled?, disabledAt?, alerts?, alertState? }
ApiKeyRecord   { keyId, orgId, name, keyHash, createdAt, lastUsedAt?, revokedAt? }
ResolvedOrg    { orgId, dbName, logRetentionDays?, disabled?, keyId? }
```

`spikes` absent means **on** (orgs that configured alerts before spikes existed get them).
`ResolvedOrg` deliberately carries neither the raw key nor its hash — only what is needed to open
the org's own database.

### 16.7 `headers.ts` — backpressure and cause wire constants

```ts
HEADER_SAMPLE_DIRECTIVE      = "X-BB-Sample-Directive"
HEADER_SUPPRESS_FINGERPRINTS = "X-BB-Suppress-Fingerprints"
HEADER_RETRY_AFTER           = "X-BB-Retry-After"
HEADER_CONFIG_VERSION        = "X-BB-Config-Version"
HEADER_CAUSE                 = "X-BB-Cause"
SUPPRESSION_WINDOW_MS        = 10 * 60 * 1000
CAUSE_FINGERPRINT_PATTERN    = /^fp_[0-9a-f]{16}$/
```

Header names are **exact wire constants**: renaming one requires updating every SDK in the field.

### 16.8 `codec.ts` — one implementation of "what a frame boundary is"

- `encodeEnvelope(envelope): Buffer` — one JSON item per line, trailing newline.
- `decodeEnvelopeItems(buf): EnvelopeItem[]` — parses whole lines, **silently drops a partial final
  line and any corrupt line**, and never throws. This is read at process boundaries that must not be
  crashable by malformed input.
- `splitIntoBatches(items, maxBytes)` — greedy batching with `FRAMING_OVERHEAD_BYTES = 64` per item.
  An item bigger than `maxBytes` alone still gets its own batch: **never drops, never throws.**
  Shared by SDK and Agent because both must keep every POST under the backend's limit; one oversize
  request is rejected whole (413), losing everything in it.

Why NDJSON satisfies "length-prefixed" without a length prefix: `JSON.stringify` escapes embedded
newlines, so a line boundary is always an item boundary — and a truncated stream still yields every
complete item before the tear.

### 16.9 `index.ts`

Re-exports all of the above.

---

## 17. Package: `@bugbusterhq/sdk-node`

The in-process SDK. Node ≥ 20, ESM, one dependency (`@bugbusterhq/types`).

### 17.1 `init()` — the whole public surface in one call

```ts
import { init } from "@bugbusterhq/sdk-node";
export const bugbuster = init({
  project: "orders-api",
  apiKey: process.env.BUGBUSTER_API_KEY!,
  environment: process.env.NODE_ENV ?? "production",
  release: process.env.GIT_SHA,
  backendUrl: process.env.BUGBUSTER_BACKEND_URL,   // only for direct mode
});
```

Create it **once per process**. `init()` never throws at runtime and never blocks a request.

| Option | Default | Purpose |
|---|---|---|
| `project` | **required** | service name; also the log `service.name` and part of the fingerprint |
| `apiKey` | **required** | the org's key |
| `environment` | `"production"` | on every issue and log line; filterable |
| `release` | — | version/commit; ties issues to deploys and enables `one-per-release` exemplars |
| `agentSocketPath` | `/var/run/bugbuster/agent.sock` | where to probe for an Agent; checked once at `init()` |
| `backendUrl` | — | ingest URL for direct mode (used only when no socket is found) |
| `minLogLevel` | `"info"` | lowest severity recorded; cheaper than cheap to reject below it |
| `flushMaxDelayMs` | `5000` | flush interval |
| `shutdownFlushTimeoutMs` | `2000` | hard cap on `shutdown()` |
| `ringBufferBytes` | 8 MB | error-buffer byte cap |
| `logBufferBytes` | 4 MB | **separate** log-buffer cap |
| `flushMaxBatchBytes` | 512 KB | max size of one request; bigger flushes split |
| `maxLiveFingerprints` | `10 000` | distinct error types folded per window |

### 17.2 The client object

```ts
bugbuster.captureException(err, { release?, environment? })
bugbuster.captureMessage("inventory below threshold")
bugbuster.captureLog("info", "msg", { orderId })     // or use bugbuster.log.*
bugbuster.isLogLevelEnabled("debug")                 // skip building an expensive message
bugbuster.log.debug|info|warn|error(message, fields?)
bugbuster.fingerprintOf(err)                         // string | undefined
bugbuster.shutdown()                                 // flush, bounded
```

**The SDK does not install global `uncaughtException` / `unhandledRejection` handlers.** That is
your process's policy to decide. If you want them:

```ts
process.on("unhandledRejection", (reason) => bugbuster.captureException(reason));
process.on("uncaughtException", async (err) => {
  bugbuster.captureException(err);
  await bugbuster.shutdown();
  process.exit(1);
});
```

### 17.3 Additional exports

```
runWithContext, getCurrentContext, BugBusterContext
newTraceId, newSpanId, traceFromHeaders, traceHeaders, instrumentFetch, noteDownstreamResponse
computeFingerprint, computeCoarsenedFingerprint, FoldTable
HttpTransport, UdsTransport, isAgentSocketAvailable, Transport
createExpressIntegration, BugBusterExpressIntegration, ExpressIntegrationOptions
createLogApi, LogApi, LogFields
createLogStream, LogStreamOptions
RingBuffer, CaptureEngine
```

### 17.4 The hot path (`capture.ts`)

Two byte-capped `RingBuffer`s, four public methods, and a set of rules each of which is a comment
citing the invariant it enforces:

| Rule | Implementation |
|---|---|
| never throw into user code | `try/catch` around every public method body |
| never block | no I/O, no locks, no unbounded queue — a ring claim or a drop |
| cap in **bytes**, not items | `ring.claim(raw, approxBytes)`; item caps lie when one trace is huge |
| recursion guard | module-level `inCapture` flag, checked before anything else |
| duplicate-object guard | `WeakSet<object>` of seen errors |
| cheapest rejection first | `minLogLevel` compare happens **before** the recursion guard, sampler, and any allocation |
| unref'd timers | `setInterval(...).unref()` |
| bounded shutdown | 2 s race |
| self-throttle | `selfCpuPct` counter exists for it (measurement, not yet an act) |

`captureLog` details worth knowing: the message is `String()`-coerced and truncated to
`MAX_LOG_MESSAGE_CHARS` (8 192) with V8's O(1) slice, `fields` is **shallow-copied** (the caller may
mutate it before the flush), and a non-object `fields` becomes `undefined`. Deep work is deferred.

### 17.5 Log hygiene (`worker/sanitize-fields.ts`)

Runs in the deferred pass. Caps:

| Bound | Value |
|---|---|
| depth | 4 (deeper objects become `"[Object]"` / `"[Array]"`) |
| keys per object | 50 (then `_truncatedKeys: n`) |
| array items | 50 (then `"[+n more]"`) |
| string length | 1 024 chars |
| error stack inside fields | 2 048 chars |
| total serialized fields | 16 KB → replaced by `{ _truncated: true, _originalApproxBytes, _keys }` |

It is more than `JSON.stringify` for three reasons the comment spells out:

1. **It must never throw** — circular refs, `BigInt`, `Map`, `Set`, `Date`, `Error`, typed arrays,
   throwing getters, and hostile objects are all expected in real logs.
2. **It is bounded** — one careless `log.info("req", { req })` cannot ship a megabyte per line.
3. **It redacts by key name** as well as by value pattern.

The key-name matcher is more careful than it looks. It splits keys into **segments**
(`camelCase`/`snake_case`/`kebab-case` aware) and matches whole segments, so it redacts `password`,
`apiKey`, `authorization`, `token`, `cookie`, `ssn`, `credential(s)`, `private_key`, `passphrase`,
etc. — without the false positives a substring match would cause (`className` contains "ssn",
`passengers` contains "pass", `maxTokens` contains "token"). `tokens` is deliberately **not** in the
list because as a key it is far more often a count than a credential. Keys are also made
Mongo-safe: `.` → `_`, leading `$` → `_$`.

### 17.6 Transports

| | `UdsTransport` | `HttpTransport` |
|---|---|---|
| When | an Agent socket exists at `init()` | fallback |
| Protocol | newline-delimited JSON over a Unix socket / named pipe | HTTPS POST, `application/x-ndjson` |
| TLS | none — data never leaves the machine; auth is file permissions | yes |
| Compression | none needed | as negotiated |
| Directives | **always `undefined`** (open loop — §12.3) | parsed from response headers and applied |
| Retries | none — the Agent's job | bounded, full jitter |

`isAgentSocketAvailable(path)` is the probe: one `stat`/connect at init, cached in the decision, not
re-checked per flush.

### 17.7 Express integration (`integrations/express.ts`)

```ts
const bb = createExpressIntegration(bugbuster, {
  logRequests: { ignorePaths: ["/healthz"] },
  causeHeader: true,          // default true; needs client.fingerprintOf
});
app.use(bb.requestHandler);   // FIRST, before any route
bb.instrumentConsole();       // console.error(err) → captured error
// bb.instrumentConsole({ logs: true });  // …and ship console.log/info/debug as log lines
```

| Option | Default | Behaviour |
|---|---|---|
| `logRequests` | `false` | one structured access-log line per finished request: `GET /orders/42 200 12ms`, with `method`, `path`, `status`, `durationMs`, `route?`, `requestId?`. **2xx/3xx → info, 4xx → warn, 5xx → error.** Query strings are never logged (they routinely carry tokens). |
| `causeHeader` | `true` | add `X-BB-Cause` on a 5xx answered to a traced caller |

`requestHandler` does four things:

1. **Trace context.** `traceparent` from the caller wins; then an upstream `req.requestId`; then a
   bare `X-Request-Id`; else a fresh 32-hex trace id. Runs the rest of the request inside that
   context.
2. **The 5xx safety net.** On `res.finish`, if the status is ≥ 500 and nothing in the request was
   captured, it records a synthetic `HandledHttpError` — *without* double-counting requests that
   called `captureException` themselves. This runs at `finish`, not `writeHead`, because an error
   handler commonly sends the 500 first and captures after.
3. **Cause header.** Wraps `res.writeHead`; on a 5xx to a traced caller it sets `X-BB-Cause` from
   `client.fingerprintOf(firstError ?? synthetic)`. It skips header arrays it cannot merge, never
   sets a duplicate, and swallows every error — telemetry must not break the response.
4. **Access log**, if enabled.

`instrumentConsole()` semantics are deliberately asymmetric: `console.error(err)` captures `Error`
arguments; `console.warn` captures `Error` **and** bare-string arguments (as a low-fidelity
`captureMessage`); bare strings to `console.error` are **left alone**, so a log label is not
conflated with a real error. `console.debug/log/info` are only touched when `{ logs: true }`. It
returns a restore function.

`captureLog` inside the integration deliberately does **not** mark the request as "captured" — an
`info` line is not a report of failure and must never suppress the 5xx safety net.

### 17.8 Trace propagation (`trace-propagation.ts`)

| Function | Behaviour |
|---|---|
| `newTraceId()` | 32 hex (W3C), so it can go straight into `traceparent` |
| `newSpanId()` | 16 hex |
| `traceFromHeaders(h)` | `traceparent` first (rejecting version `ff` and all-zero ids), then `X-Request-Id` if it looks like an id (`/^[A-Za-z0-9._:-]{1,128}$/`) |
| `traceHeaders()` | `{ traceparent: "00-<32hex>-<16hex>-01" }`, or `{ "x-request-id": … }` for a non-W3C id; `{}` outside a request |
| `instrumentFetch(opts)` | wraps global `fetch` so every in-request call carries the trace; `propagateTo: (string \| RegExp)[]` restricts it. Never replaces an explicitly-set header. Instrumenting twice wraps once (`Symbol.for` guard). Returns a restore function. |
| `noteDownstreamResponse(res, ctx?)` | for axios/got/`http`: if status ≥ 500 and `X-BB-Cause` is well-formed, store it on the context. Never throws. |

Because `traceparent` is the W3C standard, traces also continue through services instrumented with
OpenTelemetry. Use `propagateTo` to keep trace ids from leaking to outside APIs.

### 17.9 Log stream (pino / winston)

```ts
import pino from "pino";
import { createLogStream } from "@bugbusterhq/sdk-node";
const logger = pino(createLogStream(bugbuster));
// winston: new winston.transports.Stream({ stream: createLogStream(bugbuster) })
```

Keep your existing logger calls; add a destination.

### 17.10 What the SDK will never do

Write to your disk, install process-level handlers, open a TLS connection when an Agent is present,
retain your `Error` objects beyond their lifetime, throw from a public method, or keep your process
alive (all timers are unref'd).

---

## 18. Package: `@bugbusterhq/agent`

The required host-local daemon. One per host. Node ≥ 22.15 (zstd).

```text
SDK(s) on this host ──UDS──▶ UdsServer ──merge──▶ AgentHttpClient ──HTTPS/zstd──▶ backend
                                    │
                             cross-process fold
                             (the Agent's reason to exist)
```

### 18.1 What it owns that the SDK deliberately does not

- **Cross-process folding** (§8.6), preserving the highest priority per fingerprint.
- **Log forwarding** — `log` items pass through unchanged, never folded, batched at 512 KB.
- **TLS + one persistent connection per node.**
- **Compression** — `zstdCompressSync` from `node:zlib`, no external dependency. **No trained
  dictionary yet**: there is no representative payload corpus until real traffic has flowed.
- **Bounded jittered retries + circuit breaker.**
- **Disk spool** — survives an Agent restart, bounded by bytes and TTL.

### 18.2 Environment variables (only four, all read in `src/index.ts`)

| Variable | Default | Meaning |
|---|---|---|
| `BUGBUSTER_AGENT_SOCKET` | *(required in practice)* | socket/named-pipe path to listen on |
| `BUGBUSTER_BACKEND_URL` | `http://localhost:8080/ingest` | where to POST |
| `BUGBUSTER_API_KEY` | `""` | the org's key (one Agent → one org in v1) |
| `BUGBUSTER_AGENT_SPOOL_DIR` | unset → **no spool** | directory for batches that failed to send |

Everything else in `AgentConfigSchema` (timeouts, retry count, breaker thresholds, `diskSpoolMaxBytes`)
is **not** read from the environment by the bin entry point — it uses the schema defaults unless you
compose `startAgent()` yourself from code. Worth knowing before you go looking for
`BUGBUSTER_AGENT_TIMEOUT`.

### 18.3 Limits and defaults

| Thing | Value |
|---|---|
| flush interval | 5 000 ms |
| max pending log lines | **50 000** (`maxPendingLogs`), warn/error admitted to **2×** |
| max pending log bytes | **64 MB** (`maxPendingLogBytes`), warn/error to 2× |
| outbound batch size | 512 KB pre-compression |
| disk spool max bytes | 64 MB (`diskSpoolMaxBytes ?? 64 MB`) |
| disk spool TTL | 24 h |
| connect / total timeout | 2 s / 10 s |
| retries | 3 |
| breaker | 5 failures → open; 30 s cooldown |

Both log caps are needed: the line count alone does not bound memory, because one line can carry an
8 K-char message plus ~16 KB of fields — 100 000 such lines would be gigabytes. Whichever cap is
reached first applies.

### 18.4 Installer (`scripts/install.sh`)

```bash
curl -fsSL https://raw.githubusercontent.com/kunal-arora-1411/Debuginator/main/packages/agent/scripts/install.sh \
  | sudo bash -s -- \
    --api-key "$BUGBUSTER_API_KEY" \
    --backend-url https://bugbuster.example.com/ingest
```

Builds from source into `/opt/bugbuster/source` and installs the systemd service
**`bugbuster-agent`**, running as a dedicated `bugbuster` user — deliberately independent of PM2 or
your app's own unit, so it survives app deploys. Config lands in `/etc/bugbuster/agent.env`
(mode 600).

| Flag | Default |
|---|---|
| `--api-key` | (required) |
| `--backend-url` | (required) |
| `--socket-path` | `/var/run/bugbuster/agent.sock` |
| `--spool-dir` | `/var/lib/bugbuster/spool` |
| `--commit` | `main` — **pin a tag or SHA in production** |
| `--install-dir` | `/opt/bugbuster/source` |
| `--user` | `bugbuster` |
| `--repo-url` | this repo |

Safe to re-run for upgrades; `scripts/uninstall.sh` removes it.

Day-2:

```bash
systemctl status bugbuster-agent
journalctl -u bugbuster-agent -f
sudo bash /opt/bugbuster/source/packages/agent/scripts/uninstall.sh
```

### 18.5 Known v1 simplifications (from the package's own README)

- **One Agent serves one organization** — a single `apiKey`, not per-connection. Fine because a
  host's services belong to one org at pilot scale.
- **`FoldDelta.release` merges first-seen, not as a set** — a fingerprint spanning a deploy boundary
  inside one window keeps only one release's identity. The persisted issue's release history comes
  from many deltas over time, so it is unaffected.
- **The disk spool has no dedicated test file** — exercised through `UdsServer.flush()`'s failure
  path, but not covered on its own.
- **Socket permissions and `/var/run` recreation after a reboot are not verified on a production
  host** — the README says to check these first if telemetry stops arriving. Concretely: whether an
  app running as a *different* user than `bugbuster` can connect with default permissions, and
  whether the socket directory is recreated after reboot.

---

## 19. Package: `@bugbusterhq/backend`

Fastify 5 + MongoDB driver 6 + `zod-to-json-schema` (for OpenAPI). Private, never published.

### 19.1 Entry points

| File | Role |
|---|---|
| `src/index.ts` | `startBackend()`; reads env, connects, listens on `0.0.0.0:PORT`, starts the 60 s alert sweep. Runs only when it is the process entry point (`argv[1]` check) so tests can import it. |
| `app.ts` | **Vercel entry point.** Separate because Vercel's zero-config Fastify detection requires a recognised filename that imports fastify and calls `.listen()` in that same file. Also accepts `MONGODB_URI`. |
| `src/build-server.ts` | `registerRoutes()` / `createServer()` / `buildServer()` — all 22 routes, query parsing, directives. |
| `src/create-org-cli.ts` | `pnpm create-org <orgId> "<name>" <dbName> <apiKey>` — no admin token needed |
| `src/openapi-cli.ts` | regenerates `docs/openapi.json` |
| `src/cleanup-events-cli.ts` | deletes exemplary events no issue references (`--dry-run` counts) |

### 19.2 Ingest (`ingest/`)

- `edge.ts` — `resolveOrgForRequest()`, `extractBearerToken()`, `noteKeyUse()`, `forgetOrg()`.
  `AUTH_CACHE_TTL_MS` is why a revoke takes effect immediately on the instance that handled it and
  **within a minute** everywhere else; `lastUsedAt` is written at most about once an hour per key so
  it is not a write on every request.
- `processor.ts` — `processEnvelope()`: the fold upsert, exemplar insert, log insert, meta summing,
  title derivation, place tracking, hourly counts, alert marking. Exemplar refs are capped here at
  **6**.
- Validation policy for `log` items: a malformed line is discarded **without affecting the rest of
  the batch**, and a line whose `logId` was already stored is **skipped, not duplicated**. The
  backend re-applies its own bounds regardless of what the sender claims: message > 8 KB truncated;
  `fields` > 16 KB replaced by `{ "_truncated": true }`; field keys containing `.` or starting with
  `$` rewritten; a timestamp more than **5 minutes in the future** replaced by server time.

### 19.3 Query layer (`query/`)

- `causes.ts` — `getCauseGraph()`, `walkToRootCause()`, `MAX_LINKS_LISTED = 20`,
  `MAX_ROOT_CAUSE_HOPS = 8` (§14.4).
- `fidelity.ts` — `attachFidelity()`; `isExact ⟺ adjustedCount === 1.0`.
- `parseLogQuery()` (in `build-server.ts`) — validates `level`, `from`/`to`, cursor; **400s rather
  than returning a silently wrong page.**

### 19.4 Alerts (`alerts/`)

| File | Role |
|---|---|
| `notifier.ts` | `AlertNotifier` — `runAll()`, `alertScope()`, the per-org lease, the hourly cap. Long-running backends sweep every 60 s; on Vercel a cron calls `/internal/alerts/run`. |
| `spike.ts` | `detectSpike()` — pure functions, constants below |
| `email.ts` | `renderAlertEmail()`, `renderTestEmail()` — HTML emails |
| `brevo.ts` | `BrevoMailer` — the only place Brevo is spoken to |
| `db/maintenance.ts` | orphaned-event counting/cleanup; **never touches events under 10 minutes old** |
| `db/storage-report.ts` | `orgStorageReport()` for `GET /admin/storage` |

Spike constants, exactly:

| Constant | Value | Meaning |
|---|---|---|
| `HOUR_MS` | 3 600 000 | one clock hour |
| `SPIKE_BASELINE_HOURS` | 24 | hours the usual rate is averaged over, **and** how long counts must have been kept first |
| `SPIKE_MIN_EVENTS` | 20 | fewest events in one hour that can be a spike, however quiet the error usually is |
| `SPIKE_FACTOR` | 5 | multiple of the usual hourly rate required |
| `SPIKE_COOLDOWN_MS` | 6 h | the same issue is not flagged again for this long |

So a spike email requires: ≥ 24 h of tracking, ≥ 20 events this hour, ≥ 5× the average of the 24
preceding hours, and ≥ 6 h since the last spike. An issue that was quiet and comes back counts too
(its average is low, so 20 events clears 5× easily).

### 19.5 Tenant isolation (`db/`)

- `control.ts` — `ControlDb`, `hashApiKey()` (SHA-256; **only the hash is stored**),
  `retryWithBackoff()`, `PublicOrg`, `PublicKey`, `AdminEvent`.
- `tenant.ts` — `TenantDbResolver`: resolves `dbName` per request and hands everything downstream a
  `Db` handle bound to **exactly one** database.
- Collections under `db/collections/`: `issues.ts` (773 lines — the hardest file), `issue-links.ts`,
  `events.ts`, `logs.ts`, `deploys.ts`.

The isolation mechanism is structural, not a filter: there is **no shared collection with an
`org_id` field to forget in some future query**. A missed tenant filter is a real and common class
of SaaS data leak, and this removes the class instead of relying on discipline. The cost — dozens to
hundreds of orgs make per-database connection management unwieldy — is acknowledged, with the shared
collection + `org_id` model as the documented next step (§33).

### 19.6 OpenAPI

`src/openapi.ts` builds the 3.1 document and embeds Swagger UI (`SWAGGER_UI_HTML`) for `/docs`.
`docs/openapi.json` is committed for Postman/client generators, and a **unit test fails if it is
stale or if a route is undocumented** — so a new route without docs breaks CI.

### 19.7 Backend scripts

| Script | Runs |
|---|---|
| `pnpm start` | `node dist/index.js` |
| `pnpm create-org` | `node dist/create-org-cli.js` |
| `pnpm openapi` | `node dist/openapi-cli.js` |
| `pnpm cleanup-events` | `node dist/cleanup-events-cli.js` |
| `pnpm test:unit` / `pnpm test:integration` | vitest |

---

## 20. Package: dashboard

A **single HTML file** with no build step: `packages/dashboard/src/index.html` (1 793 lines).
Served either statically or by `pnpm dev`, which is a one-liner `node -e` HTTP server on port 5173
that streams the file.

You enter the backend URL (default `http://localhost:8080`) and your **API key**. The key is kept
only in that browser's `localStorage` and sent only to that backend URL.

| View | What it does |
|---|---|
| **Issues** | every error type with count, users affected, durations, top endpoints, releases, and exemplar events with stack traces. A badge shows whether the count is exact or sampled. With more than one service, a **Service** column and filter appear (the same error in two services is two issues). An issue opens under its row showing the failing request's log lines **from every service it went through**, plus a **Copy issue** button that copies the whole thing as one report for an AI agent. `#issues/<fingerprint>` deep-links to one issue — that is the URL alert emails use. |
| **Cause and effect** | on an issue with links: the likely root cause (one click away), what this issue was caused by, and what it caused, each with count and share. |
| **Logs** | search, filter by level / service / environment / time, **Live** tail, and from any error example: *View logs for this request*. |

It is read-only: every action it takes is a `GET` against the Query API.

---

## 21. Examples

### 21.1 `examples/demo-app`

An instrumented Express 4 app, split into `buildApp(client)` (`src/app.ts`) and a process bootstrap
(`src/index.ts`) so the end-to-end test can mount exactly this app against a real SDK/Agent/backend
without a second server process. It is the living documentation of the integration surface in one
screen.

| Route | Behaviour |
|---|---|
| `/` | a text hint listing the other routes |
| `/healthz` | `ok` (and explicitly excluded from access logs) |
| `/orders/:id` | a normal request: one structured `bb.log.info("order lookup", { orderId, source })` plus the automatic access-log line |
| `/checkout` | logs `checkout started`, throws, logs `payment failed` **with a `password` field that gets redacted**, captures the error, responds 502 |
| `/throw` | throws and captures → 500. Hit it twice and you get **one** issue with count 2 |
| `/throw-slow` | throws after 50 ms with `{ release: "1.0.0" }` |

Its tests are the real E2E: `test/full-pipeline.test.ts` (SDK → Agent → backend → MongoDB, the
automated version of the README walkthrough) and `test/logs-pipeline.test.ts`. Per the package
README, the E2E test is what found the two concurrency bugs in the fold upsert (§23.3).

### 21.2 `examples/root-cause-demo/traffic.mjs`

Three chained services producing a cause chain, no app of your own required:

```bash
pnpm build
BUGBUSTER_API_KEY=<key> node examples/root-cause-demo/traffic.mjs
```

Then open the dashboard and look for *caused by …* on a symptom's row, and the **Cause and effect**
block on the issue.

---

## 22. Wire protocol reference

### 22.1 Framing

**Newline-delimited JSON.** One `EnvelopeItem` per line. A trailing newline is written after the
last item. Decoding drops any partial final line and any unparseable line, and never throws.

A whole envelope's `sentAt` / `sdkVersion` are **not** on the wire per item — `encodeEnvelope()`
serializes the items only, and the receiver reconstructs what it needs. Only the decoded in-memory
`Envelope` shape carries them.

### 22.2 Transport hops

| Hop | Content type | Compression | Auth |
|---|---|---|---|
| SDK → Agent (UDS) | NDJSON over a socket; no HTTP | none | filesystem permissions on the socket |
| Agent → backend (HTTPS) | `application/x-ndjson` | `Content-Encoding: zstd` | `Authorization: Bearer <apiKey>` |
| SDK → backend (direct) | as Agent | none | same bearer |

### 22.3 Item types

| `type` | `payload` | Priority | Folded downstream? |
|---|---|---|---|
| `fold` | `FoldDelta` | 3 (or 9 for a new fingerprint) | merged by the Agent, upserted by the backend |
| `exemplar` | `BugBusterEvent` | 8 (5xx) or 9 (novel) | inserted idempotently |
| `meta` | `DropCounters` | — | summed |
| `log` | `LogEntry` | 0 / 1 / 3 | **never** — inserted idempotently |

### 22.4 Size limits, everywhere

| Limit | Value | Enforced by |
|---|---|---|
| SDK flush batch | 512 KB (configurable) | `splitLogsIntoBatches` |
| Agent outbound batch | 512 KB | `splitIntoBatches` |
| Backend body | **2 MiB** (`ingestMaxBodyBytes = 4 × 512 KB`) | Fastify `bodyLimit` → **413** |
| log message | 8 192 chars | SDK truncates; backend truncates again |
| log fields | 16 KB | SDK replaces with `_truncated`; backend replaces with `_truncated` |

The reason both sides bound the same things is stated in the code: never trust the wire.

### 22.5 Headers

| Header | Direction | Notes |
|---|---|---|
| `Authorization: Bearer <key>` | inbound | org key (ingest/query) or admin token (admin) or cron secret (`/internal/alerts/run`) |
| `Content-Encoding: zstd` | inbound | optional; the Agent always sets it |
| `X-BB-Sample-Directive` | outbound (202) | JSON `{error, log, span}` |
| `X-BB-Suppress-Fingerprints` | outbound (202) | JSON array of fingerprints; 10-minute window |
| `X-BB-Retry-After` | outbound (202) | seconds; only when set |
| `X-BB-Config-Version` | outbound (202) | integer |
| `X-BB-Cause` | response from an instrumented service | `fp_` + 16 hex; only on 5xx to a traced caller |
| `traceparent` | request/response between services | W3C; `00-<32hex>-<16hex>-01` |
| `X-Request-Id` | request between services | adopted as the trace id if it looks like an id |

---

## 23. Data model and MongoDB schema

### 23.1 The control database — `bugbuster_control` (one, shared)

| Collection | Fields | Indexes |
|---|---|---|
| `orgs` | `orgId` (**unique**), `name`, `dbName`, `createdAt`, `logRetentionDays?`, `disabled?`, `disabledAt?`, `alerts?`, `alertState?`, `apiKeyHash?` (legacy) | unique `orgId` |
| `keys` | `keyId`, `orgId`, `name`, `keyHash` (**unique**), `createdAt`, `lastUsedAt?`, `revokedAt?` | unique `keyHash` |
| `admin_events` | `at`, `action`, `orgId?`, `detail?` | newest-first |

`orgs.alerts` = `{enabled, recipients[], services[], environments[], includeStack, spikes?, since}`.
`orgs.alertState` = `{sentAt[], lastSentAt?, lastError?, lastErrorAt?, leaseUntil?}` — the sender's
own bookkeeping, never set by an operator.

`apiKeyHash` is the **legacy single-key** field: at startup each org's existing key is copied into
`keys` as "Original key" and keeps working, including on instances still running the old version
during a rolling deploy.

### 23.2 The tenant database — `bugbuster_org_<orgId>` (one per org)

Five collections: `issues`, `issue_links`, `events`, `deploys`, `logs`.

#### `issues` — one document per (fingerprint, org)

The stored document is **not** the API's `Issue`: it keeps the raw ingredients, and the API derives
`usersAffected`, `duration`, `topEndpoints` at read time.

| Field | Notes |
|---|---|
| `fingerprint` | **unique index** — the key the fold upsert matches on |
| `count` | exact in v1 |
| `userIdSet` | exact dedup set; `usersAffected = length` |
| `endpointCounts` | raw `Record<string, number>` |
| `durationSamplesMs` | capped at the most recent **1 000** (`$push` + `$slice: -1000`) |
| `releases` | string[] |
| `firstSeen` / `lastSeen` | ISO strings |
| `exemplarRefs` | `{eventId, role}[]`, capped at **6** in application code |
| `adjustedCount` | defaults `1.0`; the sampling weight |
| `title?` | `{type, message}` from the first stored example; message ≤ **500** chars |
| `services?` / `environments?` | every place it has been seen |
| `alertPendingAt?` | waiting for its email |
| `alertServices?` / `alertEnvironments?` | what the pending alert is about |
| `placesTracked?` | created with complete `services`/`environments` lists |
| `hourly?` | events per clock hour (hours since epoch), last ~24 h |
| `rateTrackedSince?` | when `hourly` began |
| `lastSpikeAt?` | 6-hour cooldown marker |
| `spike?` | `{hourCount, usualPerHour}` — the pending alert is a spike |

Indexes (**all five**):

1. `fingerprint` — **unique**
2. `(lastSeen -1, fingerprint -1)` — newest-first list
3. `(services, lastSeen -1, fingerprint -1)` — list filtered to one service
4. sparse `alertPendingAt` — only issues whose alert is unresolved
5. `(title.type, title.message)` — the alert sender's search for the same error under an old
   fingerprint

#### `issue_links` — the cause graph's edges

| Field | Notes |
|---|---|
| `cause` | fingerprint that failed **first** (the callee) |
| `effect` | fingerprint it caused (the caller) |
| `count` | occurrences of `effect` that followed a `cause` failure in one request |
| `firstSeen` / `lastSeen` | ISO strings |

Indexes: **unique `(cause, effect)`**; `(effect, count desc)`; `(cause, count desc)`. Written as one
atomic `$inc` upsert per pair, immediately after the fold's own upsert. Self-links and malformed
fingerprints are never stored. Reads `$lookup` into `issues`, so dangling causes are dropped.

#### `events` — the exemplar payloads

`eventId` (**unique**), `fingerprint` (**indexed**), `exemplarRole`, `timestamp`, `type`, `trace`,
`service`, `source`, `error?`. Inserted with `$setOnInsert` + upsert on `eventId`, so a retried send
cannot duplicate an exemplar. Kept at ≤ 6 per fingerprint by application code — and the cap is held
by **one conditional update** (`addExemplarRef` matches only when `exemplarRefs[5]` does not exist
and the `eventId` is not already present), not a read-then-write, because two concurrent sends could
otherwise both see five refs and both push. The event payload itself is stored only when that call
says the issue will actually show it, so an exemplar nobody can display is never written.

#### `deploys` — the git-correlation hook

`version` (**unique**), `commitSha`, `deployedAt`. **Not wired into any API yet** — it is the raw
material for the roadmap's git correlation.

#### `logs` — one document per line

| Field | Notes |
|---|---|
| `logId` | **unique**; time-sortable and hyphen-separated: `<12 hex epoch-ms>-<6 hex per-process sequence>-<8 hex random>`, fixed width so plain string comparison orders by (time, write order) |
| `timestamp` | BSON `Date` — when it **happened** (the app's clock); what users filter/sort by |
| `receivedAt` | BSON `Date`; **TTL index** named `receivedAt_ttl` — when **we** stored it |
| `level` | `debug` / `info` / `warn` / `error` |
| `message` | ≤ 8 KB |
| `fields?` | keys sanitized; ≤ 16 KB |
| `trace?` | `{traceId, spanId?}` — the join to an issue's exemplars |
| `service` | `{name, version, environment}` |

**Why two timestamps:** retention must trust only our clock. Expiring on `timestamp` would let a
wrong client clock write a line dated far in the future that is never deleted — or one dated long
ago that is deleted instantly. A far-future client timestamp (> 5 min ahead) is also clamped at
ingest so it cannot sit at the top of every view forever. Both fields are real BSON `Date`s, unlike
the ISO strings elsewhere, **because TTL indexes require it**.

Indexes (**all six**), each for a specific query:

| Index | Serves |
|---|---|
| `logId` unique | idempotent ingest |
| `(timestamp -1, logId -1)` | default view + cursor paging |
| `(service.name, timestamp -1, logId -1)` | "only this service", index-served sort |
| `(service.environment, timestamp -1, logId -1)` | "only production"; also facets |
| `(trace.traceId, timestamp -1, logId -1)` **partial** | "everything this request did" |
| `receivedAt` **TTL** (`receivedAt_ttl`) | retention, default 7 days |

**Deliberately no index on `level` or `message`:** level filters ride the time range, and message
search is a bounded case-insensitive substring scan over that range. A MongoDB text index only
matches whole stemmed words — useless for `o_1042` or `ECONNRESET 10.0.3`.

**Retention is a setting, not a migration:** the TTL is applied when a tenant DB is first used after
a process start; changing `BUGBUSTER_LOG_RETENTION_DAYS` updates the index in place via `collMod`;
**`0` removes the TTL index entirely** (keep forever). An org can override per-org from the admin
page, applied immediately for every backend process.

**Compression:** a *new* `logs` collection is created with **zstd** block compression. A collection
that already existed keeps whatever compressor it was created with — a compressor is fixed at
creation. `GET /admin/storage` reports which each collection uses.

### 23.3 Two concurrency bugs the fold upsert has already been bitten by

Both are handled, and both are worth knowing if you touch `issues.ts`:

1. **Path conflict.** MongoDB rejects an update that touches both `endpointCounts.checkout` and
   `endpointCounts`. A delta with empty `endpointCounts` must not mention it, so `$setOnInsert`
   defaults it to `{}` **only when this call carries no endpoint keys**.
2. **Duplicate key on a race.** Two concurrent upserts can both observe "no matching document" and
   insert; the unique index makes one fail with **`E11000`**. It is caught and **retried once as a
   plain update** — otherwise that occurrence's count is silently lost.

A third, non-concurrency behaviour: issues stored by older backends get `title` and `services`
backfilled lazily, the first time they are read, written back once.

---

## 24. HTTP API reference

**Global rules.** Every route requires `Authorization: Bearer <key>` except `GET /docs`,
`GET /openapi.json`, and `GET /admin` (the page itself). Auth failure ordering is the isolation
mechanism, not a formality:

- missing / unrecognised / revoked key → **401**
- key belonging to a **disabled** org → **403** `organization is disabled`
- both happen **before any tenant database is touched**

Admin routes take the admin token (≥ 32 chars); when `BUGBUSTER_ADMIN_TOKEN` is unset they answer
**404** as if they did not exist. `/internal/alerts/run` takes the cron secret (≥ 16 chars); unset →
**404**.

That is **22 route registrations over 21 distinct paths**.

### 24.1 Documentation

| Method | Path | Notes |
|---|---|---|
| `GET` | `/openapi.json` | OpenAPI 3.1 document, no auth |
| `GET` | `/docs` | Swagger UI, no auth: *Authorize* → paste key → *Try it out* |

### 24.2 Ingest

| Method | Path | Notes |
|---|---|---|
| `POST` | `/ingest` | NDJSON envelope; **202** with an empty body + directive headers. **401** bad key, **403** disabled org, **413** over 2 MiB |

### 24.3 Issues

| Method | Path | Notes |
|---|---|---|
| `GET` | `/issues` | `limit` (default **50**, max **200**), `service`, `cursor`. Returns `{issues, nextCursor?}` |
| `GET` | `/issues/facets` | `{services: [...]}` sorted, for the filter |
| `GET` | `/issues/:fingerprint` | one issue; **404** if not in *your* org's DB |
| `GET` | `/issues/:fingerprint/causes` | `{rootCause, causedBy, caused}` (§14.4) |
| `GET` | `/issues/:fingerprint/exemplars` | `{exemplars: [...]}` in the issue's own ref order; **`{"exemplars": []}` and 200** when it has none yet, not 404 |

`nextCursor` pins `(lastSeen, fingerprint)` so a page boundary is stable when two issues share a
`lastSeen`. Treat it as opaque. An invalid cursor is a **400**, never a silently wrong page.

An issue object carries: `fingerprint`, `count`, `usersAffected`, `duration {p50,p95,p99}`,
`topEndpoints {top[], other}`, `releases`, `firstSeen`, `lastSeen`, `exemplarRefs [{eventId, role}]`,
`adjustedCount`, `title {type, message}`, `services[]`, `environments[]`, `causedBy? {fingerprint,
count, share}`, `fidelity {isExact, adjustedCount}`.

### 24.4 Logs

| Method | Path | Notes |
|---|---|---|
| `GET` | `/logs` | see parameters below; `{logs, nextCursor?}` newest first |
| `GET` | `/logs/facets` | `{services, environments}`; **cached up to 60 s per org** |

| Param | Type | Default | Notes |
|---|---|---|---|
| `level` | comma-separated | — | `debug,info,warn,error`; **case-insensitive**; `?level=warn,error` |
| `service` | string | — | exact service name |
| `environment` | string | — | exact environment |
| `traceId` | string | — | everything logged during one request, across services |
| `q` | string | — | case-insensitive **substring**, literal (`.` matches `.`), not a regex; **max 200 chars** |
| `from` / `to` | ISO-8601 | — | inclusive bounds on `timestamp` |
| `limit` | int | **100** | max **500** |
| `cursor` | opaque | — | pins `(timestamp, logId)` |

All optional, combined with AND. **400** for an unknown level, unparseable date, `from` after `to`,
or an invalid cursor. Searches are bounded by a server-side time limit so a pathological query
cannot pin the database.

### 24.5 Admin (admin token)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/admin` | the HTML page; **404** when no admin token is configured |
| `GET` | `/admin/orgs` | every org with status, effective retention, keys (names and dates only — **never** a key or hash), alert settings, and `emailAlerts.configured` |
| `POST` | `/admin/orgs` | `{orgId, name, logRetentionDays?, keyName?}` → **201** with the new key, `Cache-Control: no-store`. **400** invalid (orgId must match `^[a-z0-9][a-z0-9_-]{0,39}$`), **401**, **409** orgId *or its dbName* already used |
| `PATCH` | `/admin/orgs/:orgId` | `name?`, `logRetentionDays?` (0–3650, or `null` to revert), `disabled?`. Applied immediately, for every process |
| `PUT` | `/admin/orgs/:orgId/alerts` | replaces the setting; ≤ 20 recipients, ≥ 1 when enabled; `includeStack` default true; `spikes` default true; `since` = now (issues that appeared while alerts were off never email) |
| `POST` | `/admin/orgs/:orgId/alerts/test` | sends a test email. **400** no recipients, **409** no Brevo key, **502** Brevo refused (says why) |
| `POST` | `/admin/orgs/:orgId/keys` | `{name}` → new key, returned **once** |
| `DELETE` | `/admin/orgs/:orgId/keys/:keyId` | revoke one key; that key then gets **401 invalid api key** — at once on the revoking instance, within a minute elsewhere. Others keep working. Revoking twice is harmless |
| `POST` | `/admin/maintenance/cleanup-events` | `{dryRun, orgId?}` → deletes example events no issue references. Never touches events under 10 minutes old |
| `GET` | `/admin/events` | admin change history, `limit` ≤ 200. `action` ∈ `org.created`, `org.renamed`, `org.retention_changed`, `org.disabled`, `org.enabled`, `key.created`, `key.revoked`, `events.cleaned_up` |
| `GET` | `/admin/storage` | per-org storage, largest first; `?orgId=` for one. Read-only — **creates nothing** |

`GET /admin/storage` returns, per org: `documents`, `dataBytes`, `storageBytes`, `indexBytes` and
`compression` for `logs` / `issues` / `events`; `logsPerDay` for the last 7 UTC days (lines and
estimated bytes); `unreferencedEvents`; plus `totalBytes` and `defaultLogRetentionDays`.

### 24.6 Internal

| Method | Path | Notes |
|---|---|---|
| `GET` / `POST` | `/internal/alerts/run` | sends every org's pending alerts. **404** neither secret set, **401** wrong. Returns `{configured, orgs, emails, alerted, errors}` |

`GET` is supported because Vercel Cron sends a `GET` with `CRON_SECRET` as a bearer token.

### 24.7 Documented extensions not built

- searching inside structured `fields` (`?field.orderId=o_1042`) — fields are already stored as
  real sub-documents with Mongo-safe keys, so this is a query addition, not a schema change;
- separate admin accounts — one shared token, and the change history records what/when, **not who**;
- read-only keys — every org key can both send and read;
- more alert kinds (resolved-issue recurrence, daily digests);
- letting teams manage their own alert recipients — the operator does it on `/admin`.

---

## 25. Configuration reference

### 25.1 SDK (`init()` options)

See §17.1 — the table there is the complete list (13 options, each with its default).

Environment variables the SDK does *not* read itself; the convention from the docs:

| Variable | Fed into |
|---|---|
| `BUGBUSTER_API_KEY` | `apiKey` (and the Agent installer) |
| `BUGBUSTER_BACKEND_URL` | `backendUrl` (direct mode only) |
| `BUGBUSTER_AGENT_SOCKET` | `agentSocketPath` |
| `GIT_SHA` (or your CI's commit var) | `release` |
| `NODE_ENV` | `environment` |

### 25.2 Agent

See §18.2 — exactly four variables (`BUGBUSTER_AGENT_SOCKET`, `BUGBUSTER_BACKEND_URL`,
`BUGBUSTER_API_KEY`, `BUGBUSTER_AGENT_SPOOL_DIR`), the rest being schema defaults applied in code.

### 25.3 Backend

| Variable | Default | Meaning |
|---|---|---|
| `BUGBUSTER_CONTROL_DB_URI` | `mongodb://localhost:27017` when run locally | MongoDB URI. Vercel's `app.ts` also accepts `MONGODB_URI` |
| `PORT` | `8080` | HTTP port (ignored on Vercel) |
| `BUGBUSTER_LOG_RETENTION_DAYS` | `7` | default days to keep log lines. `0` = keep forever. **Blank counts as unset** |
| `BUGBUSTER_ADMIN_TOKEN` | unset | enables the admin routes (≥ **32** chars, e.g. `openssl rand -hex 32`). Unset or blank = **404** |
| `BUGBUSTER_BREVO_API_KEY` | unset | turns email alerts on. Unset = no email is ever sent |
| `BUGBUSTER_ALERTS_FROM` | — | sender, verified in Brevo; required with the key |
| `BUGBUSTER_ALERTS_FROM_NAME` | `BugBuster` | sender display name |
| `BUGBUSTER_DASHBOARD_URL` | unset | makes each alert link straight to its issue |
| `BUGBUSTER_ALERTS_MAX_PER_HOUR` | `10` | most alert emails one org gets per hour; the rest wait and go out together |
| `BUGBUSTER_CRON_SECRET` | unset | ≥ **16** chars; enables `/internal/alerts/run`. Vercel's `CRON_SECRET` is accepted instead |
| *(code-only)* `ingestMaxBodyBytes` | `2 MiB` | Fastify body limit; not read from env |

Two deliberate "blank = unset" rules, both for the same reason (`Number("") === 0`):

- `BUGBUSTER_LOG_RETENTION_DAYS=""` would otherwise mean "keep forever" and **drop the TTL index**,
  letting logs grow without bound. Blank falls through to the default.
- `BUGBUSTER_ADMIN_TOKEN=""` would otherwise accept an empty token. Blank disables the routes, which
  is the safe direction.

Anything else non-numeric becomes `NaN`, which the schema rejects **at startup, loudly** — it does
not guess.

A mistake in the *alert* settings (blank or invalid sender, bad `MAX_PER_HOUR`) does **not** stop
the backend: alerts turn off, the reason is logged (and shown on `/admin`), and ingest keeps
working. A too-short cron secret likewise turns only that route off, with a warning.

---

## 26. Deployment

### 26.1 Backend — any Node host

```bash
pnpm install && pnpm build
cd packages/backend
BUGBUSTER_CONTROL_DB_URI="mongodb+srv://…" BUGBUSTER_ADMIN_TOKEN="…" PORT=8080 pnpm start
```

Run it under a process manager (systemd, PM2, a container) and put it behind TLS. **Agents and SDKs
should only ever reach it over HTTPS.**

### 26.2 Backend — Vercel

Point a Vercel project's root at `packages/backend`. `vercel.json` builds the shared types first;
`app.ts` is the entry point (see §19.1 for why it exists). Set the env vars above; Vercel's own
`CRON_SECRET` is honoured for the alerts route.

On Atlas, allowlist the backend's egress IPs — on Vercel that usually means `0.0.0.0/0` plus a
strong database password.

### 26.3 The Agent — where your app runs

| Where your app runs | Use | Why |
|---|---|---|
| VM / bare metal / EC2, one or more Node services | **the Agent** (recommended) | merges every service on the host, compresses, retries, spools |
| Serverless (Vercel, Lambda, Cloud Functions), PaaS dynos | **direct mode** (`backendUrl`) | no long-lived host process for a daemon |
| Containers / Kubernetes | direct mode, or an Agent sidecar | a sidecar works if app and Agent share the socket via a volume |

With an Agent installed, start your app **after** the Agent and omit `backendUrl`.

On serverless, call `await bugbuster.shutdown()` before your handler returns if the platform freezes
the process between invocations — otherwise buffered data may never be sent.

### 26.4 Upgrade notes that change data

- **0.3.0** — the SDK groups errors per service, so **every fingerprint changes once**. After a
  service upgrades, its errors start new issues (same titles); the old ones stop growing. The backend
  accepts both. New trace ids become W3C 32-hex instead of UUIDs. Upgrade prompt:
  `docs/upgrade-to-0.3.md`.
- **0.4.0** — issues know which other service's issue caused them. Both new wire fields are
  optional, so any mix of versions keeps working; links appear once both sides of a call are 0.4.0.
  Synthetic `HandledHttpError`s got a fixed stack, so each starts one new issue after the upgrade.
- **Logs retention era** — after upgrading from a backend older than the retention release, remove
  example events earlier versions stored but never showed: `pnpm cleanup-events --dry-run` then
  `pnpm cleanup-events`. It only deletes events no issue references and is safe to re-run.

---

## 27. Operations runbook

### 27.1 Health check

```bash
API=https://bugbuster.example.com
curl $API/issues                                    # {"error":"missing bearer token"}
curl -o /dev/null -w '%{http_code}\n' $API/logs     # 401 (a 404 means a build older than logs)
```

There is **no `/health` or `/healthz` route** on the backend. The two lines above are the
documented check, and they double as a version check: `404` on `/logs` means the deployment predates
log support.

### 27.2 Order of operations (local)

MongoDB → create org → backend → **Agent** → app. The Agent must be up first because the SDK
probes the socket once, at `init()`. The backend must be up before the Agent flushes (~5 s of grace,
then it spools or drops).

### 27.3 Day-2

```bash
systemctl status bugbuster-agent
journalctl -u bugbuster-agent -f
sudo bash /opt/bugbuster/source/packages/agent/scripts/uninstall.sh
```

Upgrade the Agent by re-running the installer with a newer `--commit`; it rebuilds in place and
restarts the service.

### 27.4 Routine admin tasks

```bash
# create an org + first key (returns the key once)
curl -X POST https://bugbuster.example.com/admin/orgs \
  -H "Authorization: Bearer $BUGBUSTER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"orgId":"acme","name":"Acme Corp","keyName":"checkout-api production"}'

# change one org's log retention (applies immediately, every process); null reverts, 0 = forever
curl -X PATCH https://bugbuster.example.com/admin/orgs/acme \
  -H "Authorization: Bearer $BUGBUSTER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"logRetentionDays":30}'

# see what each org stores, largest first
curl https://bugbuster.example.com/admin/storage -H "Authorization: Bearer $BUGBUSTER_ADMIN_TOKEN"

# drain pending alerts from a scheduler
curl -fsS https://bugbuster.example.com/internal/alerts/run \
  -H "Authorization: Bearer $BUGBUSTER_CRON_SECRET"
```

A long-running Node backend calls the alert sweep itself every 60 s; on Vercel the cron in
`vercel.json` calls it daily, and for more often you point any scheduler at it (every 5 minutes
from cron-job.org or a GitHub Actions schedule, for example).

### 27.5 Alert behaviour, precisely

What **sends** an email:

- a **new issue** — an error never seen in that org (new errors arriving together share one email,
  which lists up to ten);
- an existing issue appearing in an **environment or service it had not been seen in** before — so
  with alerts limited to `production`, an error first seen in staging alerts when it reaches
  production;
- a **spike** (§19.4), on by default, unticked by *Also alert when a known error spikes*.

What **does not**:

- the same error again at its usual rate;
- issues that first appeared **before** alerts were switched on (`since`);
- an error whose fingerprint changed only because a service upgraded its SDK — an older issue with
  the same error, service and code location counts as the same error;
- more than `BUGBUSTER_ALERTS_MAX_PER_HOUR` emails per org per hour (default 10) — past that, new
  errors wait and go out together in the next email the hour allows.

Only issues created **with complete place lists** (`placesTracked`) alert on reaching a new place,
because older issues' lists are incomplete and every other environment would look new. An empty
list (an issue created by a fold with no exemplars) is not news either.

---

## 28. Security and data handling

### 28.1 Authentication and authorization

| Credential | Scope | Storage |
|---|---|---|
| Org API key (`bb_…`) | ingest **and** read, for one org | **SHA-256 only** (`keys.keyHash`, unique index). Shown once, at creation |
| Admin token | all admin routes | env var, ≥ 32 chars |
| Cron secret | `/internal/alerts/run` | env var, ≥ 16 chars |

- **API keys are shown once.** If one is lost, create another and revoke the old one.
- **Multiple named keys per org**, each revocable independently, so you can give each service or
  person its own and revoke one without touching the others. `lastUsedAt` tells you which are still
  needed.
- **Disabling an org** refuses all of its keys for both sending and reading with **403
  `organization is disabled`**. Its data is kept; re-enabling restores access.
- Revocation/disable take effect **immediately on the instance that handled it** and **within a
  minute** everywhere else (that is the auth cache TTL).

### 28.2 Tenant isolation

Structural, not a filter: the org is resolved from the key **before any tenant data is touched**, and
every downstream call gets a `Db` handle bound to exactly one `bugbuster_org_<orgId>` database. There
is no shared collection with an `org_id` to forget. A fingerprint heard from another org's service
simply does not exist in yours, so cross-org cause links cannot leak. Covered by
`test/integration/cross-org-isolation.test.ts`.

### 28.3 Secrets in your logs

Redaction happens **before anything leaves your process**, in the deferred worker pass:

- **by key name**, at any depth: `password`, `passwd`, `passphrase`, `secret(s)`, `token`,
  `authorization`, `apikey`/`api key`, `cookie(s)`, `credential(s)`, `private key`, `ssn` → the value
  becomes `[redacted]`;
- **by value pattern**, inside strings: emails, bearer tokens, and card-like digit sequences
  (`redactString`);
- matching is by **key segment**, so `className`, `passengers`, `bypassCache` and `maxTokens` are
  not redacted, while `dbPassword` and `apiKey` are.

Two honest caveats: this is a best-effort scrubber, not a DLP product, and it works on a field's
**key**, so a secret in a value under an innocuous key name will not be caught by name.

### 28.4 What the backend will not do

- It does not parse untrusted payloads at the front door as a design principle ("parsing at the
  front door is both the latency floor and the security surface — decompression bombs, 200-deep
  nested JSON, pathological regex"). Parsing happens in the processing tier, where a crash is a
  retry rather than an outage.
- It re-applies every bound itself (message length, field size, key safety, future timestamps)
  rather than trusting the SDK.
- It never returns another org's issue — a fingerprint from a different database is
  indistinguishable from one that does not exist (404 by design).

### 28.5 Known exposure to keep in mind

- **One shared admin token**, no per-admin accounts. The change log records what and when, not who.
- **No read-only keys**: every org key can both write and read.
- **No per-org quota** in v1: one org's storm is isolated by *data* (its own database) but not yet
  by *load* (§33).
- **Email alerts share your Brevo quota** across all orgs (~300/day on the free plan).
- **The `X-BB-Cause` header is only sent to traced callers**, so browsers and outside clients never
  see it — but if you disable that assumption (`causeHeader` plus an external caller that sends
  `traceparent`), the header does reveal a stable opaque error id. Use `propagateTo` to keep traces
  internal.

---

## 29. What is deliberately not built

This list is a feature of the project, not an apology: every omission has a **measurement** that
would bring it back (§33).

| Not built | Consequence | Why it waits |
|---|---|---|
| Durable log (Kafka/Redpanda) | no replay of raw events; ingest writes straight to MongoDB | single-process write contention is not measured yet |
| Probabilistic sketches | memory grows with distinct users/samples per issue (samples capped at 1 000) | sketches are *less* accurate than exact counts at low N |
| Per-org quota / rate limiting | one org's storm can slow another on a shared VPS | no measured cross-org slowdown yet |
| Shared-collection multi-tenancy | connection management cost grows with org count | database-per-org is free at a handful of orgs |
| Direct mode as a first-class backend path | serverless loses cross-service merge and the spool | no deployment target that *cannot* run an Agent |
| True tail sampling in a collector | no whole-trace sampling across services | in-process retroactive upgrade covers most of it |
| Trained zstd dictionary | larger payloads than the design's ~1000:1 target | no representative corpus until real traffic flows |
| `deploys` wiring, git correlation, AI debugger | no commit-level attribution | roadmap |
| Slack / webhook alerts | email only | roadmap |
| SDKs beyond Node | Node only | roadmap |
| Field-level log search (`?field.x=`) | substring search over `message` only | query addition, not a schema change |
| Separate admin accounts, read-only keys | one token, full-power keys | roadmap |
| A backend `/health` route | use `/issues` and `/logs` as the probe | not needed yet |

### 29.1 Known gaps and inconsistencies in the current tree

Stated plainly so nobody has to rediscover them:

1. **Version strings lag the code** — §3.1.
2. **`ingest-pipeline.md` still says "pre-implementation"** — stale.
3. **The directive loop is open through the Agent** — UDS mode gets no directives (§12.3).
4. **Agent socket permissions and `/var/run` recreation after reboot are unverified** on a
   production Linux host (§18.5).
5. **The disk spool has no dedicated test** (§18.5).
6. **`release` merges first-seen, not as a set** in the Agent's cross-process merge (§8.6).
7. **The Agent's `bin` reads only four env vars**; timeouts/breakers/spool-size are code-level
   defaults (§18.2). There is no `BUGBUSTER_AGENT_TIMEOUT`.
8. **`adjusted_count` vs `adjustedCount`** — the glossary uses snake_case, the API/schema use
   camelCase.
9. **No quota enforcement**, so the `X-BB-Sample-Directive` numbers are always 1.0.
10. **Scope limitation by design**: one Agent serves one organization (`apiKey` is a single key, not
    per-connection).

---

## 30. Testing

### 30.1 What exists

| Suite | Files | What it covers | Needs |
|---|---|---|---|
| `packages/types` unit | 8 | schemas, codec framing/truncation, issue/log shapes | nothing |
| `packages/agent` unit | 5 | circuit breaker, http client (retries/breaker), fold merge, UDS server over a **real** socket, log forwarding | nothing |
| `packages/sdk-node` unit | 16 | capture, directives, fingerprint, fold, transports, log capture/pipeline/stream, sanitize, trace propagation, root cause, Express integration, benchmarks | nothing |
| `packages/backend` unit | 6 | alerts, control DB, edge/auth, fidelity, openapi freshness, spike | nothing |
| `packages/backend` integration | 13 | ingest endpoint, cross-org isolation, issue titles/services/exemplars/pagination, root cause, logs, alerts, admin console/orgs, storage, mongo writes, CORS | a real `mongod` (via `mongodb-memory-server`) |
| `examples/demo-app` integration | 2 | **the full SDK → Agent → backend pipeline**, and the logs pipeline | same |

Two properties worth noticing:

- The Agent's cross-process fold-merge test runs over a **real** Unix domain socket (or Windows
  named pipe), not a mock.
- `openapi.test.ts` fails if `docs/openapi.json` is stale or a route is undocumented — documentation
  is enforced by CI.

### 30.2 Commands

```bash
pnpm test:unit                                       # every package, no services needed
pnpm --filter @bugbusterhq/backend test:integration  # real mongod via mongodb-memory-server
pnpm --filter @bugbusterhq/demo-app test:integration # the full pipeline
pnpm lint && pnpm typecheck && pnpm format:check
pnpm bench                                           # sdk-node capture benchmarks
```

### 30.3 Verified state (this document)

```text
packages/types     Test Files  8 passed (8)     Tests  34 passed (34)
packages/agent     Test Files  5 passed (5)     Tests  26 passed (26)
packages/backend   Test Files  6 passed (6)     Tests  31 passed (31)
packages/sdk-node  Test Files 16 passed (16)    Tests 140 passed (140)
                                                 ─────────────────────
                                   35 files      231 tests, all passing
```

Integration suites were **not** run to produce this document; they download and run their own
`mongod` and are the slowest part of CI.

### 30.4 CI

`.github/workflows/ci.yml`, on every PR and on `main`:
`pnpm install --frozen-lockfile` → `format:check` → `lint` → `typecheck` → `build` → `test:unit` →
(eager `mongod` download, cached) → `test:integration`.

Two CI details that are really project knowledge:

- `pnpm/action-setup` is given **no** `version:` — it reads `packageManager` from `package.json`,
  and errors if both are set. One source of truth.
- Node is pinned to **22**, not 20, because the Agent and backend need `zstdCompressSync`.

---

## 31. Development workflow

### 31.1 Root scripts

| Script | Does |
|---|---|
| `pnpm build` | `pnpm -r --workspace-concurrency=1 run build` — **serial on purpose**: `types` must build before its consumers |
| `pnpm test` / `test:unit` / `test:integration` | across all packages |
| `pnpm bench` | sdk-node capture benchmarks |
| `pnpm lint` / `lint:fix` | eslint 9 flat config |
| `pnpm format` / `format:check` | prettier |
| `pnpm typecheck` | `tsc -b` per package (project references) |
| `pnpm clean` | rimraf dist + tsbuildinfo |

### 31.2 Conventions

- **ESM everywhere** (`"type": "module"`), TypeScript project references, `tsc -b` builds.
- Every package imports the wire contract from `@bugbusterhq/types`; nothing re-declares shape.
- `workspace:^` (published packages) vs `workspace:*` (private ones).
- **Comments explain *why*.** This codebase's comments cite the design document section they
  enforce. If you change a budget, change the comment that justifies it.
- One implementation of framing (`packages/types/src/codec.ts`) — do not add a second.
- Never rename a header constant without updating every SDK in the field.

### 31.3 If you touch the ingest path

The architecture doc's warning is worth repeating: **the ingest path is the one part that cannot be
refactored later.** The SDK runs inside someone else's process, and the wire format is a contract —
changing it means supporting N old SDK versions forever. Prefer additive changes (the 0.3 and 0.4
fields were both added this way, optional and tolerated by every older reader).

### 31.4 Releasing

1. Bump `version` in `types`, `sdk-node`, `agent` **together**; merge to `main`.
2. From up-to-date `main`, logged in to npm with publish rights:
   `pnpm install && pnpm -r publish --access public` — **pnpm, not `npm publish`**, because only pnpm
   rewrites the inter-package `workspace:^` ranges into real versions. Each package rebuilds itself
   via `prepublishOnly`.
3. `git tag v0.3.0 && git push origin v0.3.0`.

The SDK and Agent report their own `package.json` version to the backend (`sdkVersion`), read via
`createRequire(import.meta.url)("../package.json")` so it can never drift from what was published.

---

## 32. Design decisions and tradeoffs

| Decision | Chosen | Rejected alternative | Cost accepted |
|---|---|---|---|
| Where grouping happens | **client-side fingerprint + fold** | backend grouping (the OTel model) | the algorithm becomes part of the wire contract |
| Storage | **MongoDB, one database per org** | Postgres + `org_id` filter | connection management grows with org count |
| Queue | **none** (edge writes directly) | Kafka/Redpanda | no replay, no per-tenant write isolation |
| Statistics | **exact** counts/percentiles/top-K | HLL/DDSketch/Space-Saving now | memory grows with cardinality/distinct samples |
| Transport | **Agent required** for backend hosts, direct as fallback | fat direct-mode SDK | an extra daemon to deploy |
| Socket | **Unix domain socket** | TCP loopback | same host only (which is the point); Windows needs a named pipe |
| Compression | **zstd, no trained dictionary yet** | gzip; or a dictionary trained on synthetic data | larger payloads than the target |
| Framing | **NDJSON** | explicit length prefixes; one big JSON body | slightly larger (newlines) — buys partial-batch salvage |
| Retries | **bounded, jittered, 5xx/network only** | retry everything | some data loss on 4xx (which would fail identically anyway) |
| Drop handling | **drop and count** | block, or grow the buffer | honest data loss instead of crashing the host |
| Spool location | **Agent only**, never the SDK | spool in the customer's process | loss on Agent-less deployments |
| Shutdown | **hard-capped 2 s** | flush everything | up to ~5 s of telemetry lost per deploy (the documented tradeoff) |
| Fingerprint identity | includes **service** (0.3+) | error+stack only | every fingerprint changes once, on upgrade |
| Root cause | **`X-BB-Cause` headers folded in the SDK** | keep every trace id and join after the fact | both sides must run the SDK |
| Admin auth | **one shared token** | per-admin accounts | no attribution in the change log |

The tradeoff table is the actual intellectual content of the project, and the docs are unusually
candid about the costs — the 0.3 fingerprint change is documented as a thing that "happened once
already", with the mitigation designed and not built.

---

## 33. Roadmap: growth triggers

Each item comes back on a **measurement**, not a date. Building ahead of the trigger was evaluated
and rejected: single-broker Kafka gives no real durability gain, and sketches are less accurate than
exact counts at pilot volume — each is a cost paid for a benefit that does not exist yet.

| Deferred piece | Comes back when |
|---|---|
| **Durable log (Kafka/Redpanda)** | the single Mongo-writing process shows measured write contention; **or** a fingerprinting-algorithm change needs full-history replay (not just stored exemplars); **or** a second independent consumer needs the same event stream |
| **HyperLogLog / DDSketch** | exact-count aggregation queries are measurably slow, or the fold table's raw-value memory footprint is measurably large |
| **Per-org quota / rate limiting** | one org's test traffic is measured to cause a slowdown for another org sharing the VPS |
| **Shared-collection multi-tenancy** (retiring database-per-org) | the org count makes per-database connection management measurably unwieldy — likely dozens, not the current few |
| **Direct mode promoted to first-class for backend SDKs** | a concrete backend deployment target cannot run a host-local Agent for a reason other than "we haven't built the installer" |

Other roadmap items already named in the docs: Slack/webhook alerts, more alert kinds
(resolved-issue recurrence, daily digests), git/commit correlation via `deploys`, an AI debugger, and
SDKs beyond Node. The dashboard's **Copy issue** button is the current, manual version of the AI
story: it copies the issue plus its request's log lines as one report you paste into an agent.

### 33.1 The volume math behind the design

A mid-size customer at 500 req/s and a 1% error rate produces **432 000 errors/day**:

| Approach | Bytes/day |
|---|---|
| naive, 5 KB per event | **2.2 GB** |
| + edge fold (~50:1 — storms are bursty and repetitive) | **44 MB** |
| + zstd with a trained dictionary | **~15 MB** |

"That is the gap between *unit economics work* and *we are an S3 bill with a dashboard*." And the
conclusion: **the fold is not an optimisation to add later — it is the architecture.**

---

## 34. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `{"error":"missing bearer token"}` on `/issues` | you did not send the key | `Authorization: Bearer <key>` |
| **404** on `/logs` | backend build predates log support | rebuild/redeploy |
| **404** on `/admin*` | `BUGBUSTER_ADMIN_TOKEN` unset or shorter than 32 chars | env, then restart |
| **404** on `/internal/alerts/run` | no cron secret, or it is under 16 chars | `BUGBUSTER_CRON_SECRET` / `CRON_SECRET` |
| **401 invalid api key** right after a revoke | expected | immediate on the revoking instance, ≤ 1 min elsewhere |
| **403 organization is disabled** | the org is disabled | re-enable via `PATCH /admin/orgs/:orgId` |
| **413** on ingest | batch over 2 MiB | check `ingestMaxBodyBytes`; the SDK/Agent batch at 512 KB, so this usually means a custom sender |
| No telemetry at all, app healthy | SDK chose direct mode and has no `backendUrl`, or the Agent started *after* the app | the SDK probes the socket **once**, at `init()` — start the Agent first, or set `backendUrl` |
| Telemetry stops after a reboot | the socket dir may not be recreated; permissions may block a different user | §18.5 — first thing to check |
| `zstdCompressSync is not a function` | Node < 22.15 | upgrade Node; CI pins 22 |
| Logs collection growing without bound | retention set to `0`, or an empty string was treated as "keep forever" | `GET /admin/storage`, then `PATCH … {"logRetentionDays": n}` |
| A newly deployed service missing from the logs filter | `/logs/facets` is cached up to 60 s | wait a minute |
| No alert emails | no Brevo key (`emailAlerts.configured: false`), alerts disabled, or a bad sender | `GET /admin/orgs` → `alerts.lastError`; try `POST /admin/orgs/:orgId/alerts/test` |
| Duplicate issues for one error | service upgraded to 0.3 (fingerprints changed once) — or the same error genuinely in two services, which is correct | §9.3 |
| An issue's exemplars look inconsistent | the issue has no exemplars yet (`{"exemplars": []}` and 200 is normal), or an older backend left orphans | `pnpm cleanup-events --dry-run` |
| A `caused by` link is missing | only one side runs the SDK, the failure was non-HTTP (queue/gRPC), the caller swallowed it, or the 500 was sent before `captureException` | §14.6 |
| Counts look "wrong" after sampling was enabled | `adjustedCount ≠ 1.0`; the count is a weighted estimate | the `fidelity` block |
| Tests fail with `ENOENT … rename …tgz.downloading` | parallel `mongodb-memory-server` downloads on a cold cache | pre-download once (§30.4) |

---

## 35. Glossary

**Core vocabulary of this project**

| Term | Meaning |
|---|---|
| **Issue** | one kind of error in one service, with a count and up to 6 example events |
| **Fold** | collapsing many same-fingerprint events into one counted aggregate plus a few exemplars, **before** transmission |
| **Fingerprint** | the stable hash meaning "this is the same bug" — `fp_` + 16 hex, computed in the SDK |
| **Exemplar** | one full-fidelity event kept as the representative of a folded group; role is one of first / last / slowest / one-per-release / one-novel-stack |
| **FoldDelta** | the raw per-window ingredients sent for one fingerprint (counts, ids, samples, endpoint counts) |
| **Coarsening** | deliberately weakening a fingerprint (stripping frames) or routing to an overflow bucket, to cap cardinality |
| **adjustedCount** | the sampling weight; the multiplier that recovers the true population count (glossary spells it `adjusted_count`) |
| **Fidelity** | how much of the true signal survived capture, sampling and shedding — "you are seeing 12% of your errors" |
| **Priority byte** | the shed-ladder value stamped on every envelope item: 0/1/2/3 shed, 8/9 never |
| **Direct mode** | the SDK talks to the ingest API over HTTPS itself, no Agent — the fallback for browser/mobile/serverless |
| **Agent mode** | the SDK talks to a host-local Agent over a Unix domain socket — required for backend-hosted services |
| **Cause / effect** | an issue in one service that failed first, and the issue it caused in its caller |
| **Share** | `link.count / effect.count` — how much of an issue a given cause explains |
| **Root cause** | the issue at the end of the strongest-cause walk (share ≥ 0.5, ≤ 8 hops) |

**Costs and units**

| Term | Meaning |
|---|---|
| **Hot path** | code that runs on every single request |
| **Cold path** | startup, config reload, once-an-hour error handling |
| **p50 / p95 / p99** | percentiles: 50% / 95% / 99% of values were faster; the tail is what users feel |
| **Why never averages** | a mean hides a tail outage — 99 × 10 ms + 1 × 5 000 ms averages 60 ms and hides the 5 s case |
| **Tail amplification** | with a 1% per-call tail hit, a page making 20 calls hits it `1 − 0.99²⁰ ≈ 18%` of the time |
| **Syscall** | a call into the kernel (~100 ns–1 µs, may block); "zero syscalls on the hot path" means never touch the OS while a user waits |
| **Unref'd timer** | Node's `.unref()`: do not count me as a reason to keep the process open |
| **Fork-safe** | `fork()` copies memory but only one thread, so a flush thread dies in the child and telemetry silently drops forever |
| **AsyncLocalStorage** | Node's ambient "which request am I in?" store that follows the value across `await` |

**Data shapes**

| Term | Meaning |
|---|---|
| **Cardinality** | number of distinct values a field can take; **cardinality kills**, volume compresses |
| **Sketch** | an approximate answer in tiny fixed memory (HLL counts distinct, DDSketch gives percentiles, Space-Saving finds top-K) |
| **Mergeable** | two sketches combine into a correct union, auto-deduplicating overlap; plain counters cannot |
| **Span / trace / traceparent** | one operation in a request / the request's whole journey / the W3C header carrying its ids |
| **Head vs tail sampling** | decide at the start (cheap, blind) vs at the end (correct, needs buffering) |

**Flow control**

| Term | Meaning |
|---|---|
| **Backpressure** | a downstream stage that cannot keep up makes the producer produce less |
| **Circuit breaker** | CLOSED → 5 failures → OPEN (fail instantly) → 30 s → HALF-OPEN (one probe) → success → CLOSED |
| **Full jitter** | pick a delay uniformly in `[0, ceiling]`; without it, recovery becomes a self-inflicted DDoS |
| **Load shedding** | deliberately dropping work when overloaded; the skill is choosing *what* to drop |
| **Thundering herd** | a synchronised retry wave |

**Infrastructure**

| Term | Meaning |
|---|---|
| **UDS** | Unix Domain Socket — addressed by a file path, same host only, ~10–50 µs, no TLS (auth is file permissions) |
| **Named pipe** | Windows' equivalent (`\\.\pipe\bugbuster`) |
| **Durable log** | append-only and replayable (Kafka/Redpanda); unlike a queue, reading does not consume |
| **Multi-tenancy / noisy neighbour** | many customers on one set of servers / one customer degrading everyone else |
| **Token bucket** | a rate limiter refilling at N tokens/sec, allowing bursts while capping the sustained rate |
| **zstd / trained dictionary** | fast modern compression / a shared sample of typical data so you send "entry #4 182" instead of `"TypeError: Cannot read…"` |
| **stateless** | holds nothing between requests, so servers can be added or killed freely — why the ingest edge must be stateless |

---

## 36. FAQ

**Do I have to run the Agent?**
For a long-lived backend host, yes — it is the required v1 path and the reason the SDK stays small.
Serverless/PaaS/containers should use direct mode with `backendUrl`. The SDK decides by itself at
`init()`, so getting it wrong is a startup-order problem, not a code change.

**What happens when the backend is down?**
The SDK keeps capturing until its byte cap, then drops and counts. With an Agent, batches spool to
disk (64 MB / 24 h) and replay on recovery. The circuit breaker stops the Agent hammering a dead
backend. Your app is never blocked and never crashed.

**How much memory does the SDK use?**
8 MB for errors + 4 MB for logs by default, both hard caps. They are separate rings so a log flood
cannot evict an exception.

**Will this slow my service down?**
The design target is < 5 µs per log and < 50 µs per exception, with zero syscalls and zero JSON on
the hot path. It is a target with CI benchmarks, not a measurement of *your* app — measure it.

**Why did my 50 000-error storm become one issue?**
That is the fold working. You get one issue with `count: 50000` and up to 6 full examples.

**Why do I have duplicate issues after upgrading the SDK?**
0.3 put the service name into the fingerprint, so every error's fingerprint changed once. Old issues
stop growing; new ones start with the same titles. Nothing is lost, and the backend accepts both.

**Can I search inside structured log fields?**
Not yet. `q` is a case-insensitive substring match on `message`. Fields are stored as real
sub-documents with Mongo-safe keys, so this is a query addition, not a schema change.

**Why does `?q=a.b` not match `axb`?**
Because `q` is a literal substring, not a regex — deliberately, so searching for `o_1042` or
`ECONNRESET 10.0.3` works.

**Why is there no index on `level` or `message`?**
Level filters ride the time range, and message search is a bounded scan over that range. A MongoDB
text index would only match whole stemmed words, which is useless for ids and error codes.

**How long are logs kept?**
7 days by default (`BUGBUSTER_LOG_RETENTION_DAYS`), overridable per org from 0 (forever) to 3650
days via `PATCH /admin/orgs/:orgId`.

**Can two orgs share a database?**
No, and that is enforced: `POST /admin/orgs` returns **409** if the `orgId` *or* its database name
is already used.

**Do I lose data on deploy?**
Up to ~5 s of telemetry if you never call `shutdown()`. Call it on `SIGTERM`; it never takes longer
than ~2 s.

**Is it OpenTelemetry-compatible?**
No — its own wire format. It interoperates at `traceparent`, so traces continue across OTel services.

**Why is the product called BugBuster in a repo called Debuginator?**
History. See §3.

**Is `doc.md` documentation?**
No. It is an AI-generated brainstorm. See §3.2.

**Can I use this in production?**
It is self-hosted and functional, and the omissions are documented rather than hidden. Read §29
first, and note the unverified items in §18.5 before you rely on the installer on a production host.

---

## 37. Documentation index

| Document | Lines | Read it for |
|---|---|---|
| `README.md` | 784 | the primary guide: self-hosting, SDK usage, deployment, releasing |
| **`DEBUGINATOR.md`** | this file | the whole system in one place |
| `docs/architecture/ingest-pipeline.md` | 587 | **the design document** — budgets, the fold's reasoning, backpressure, tenant isolation, §10 growth triggers |
| `docs/architecture/root-cause-graph.md` | 173 | the cause graph, `X-BB-Cause`, share/hops, what it cannot see |
| `docs/architecture/bugbuster-blueprint.html` | — | the same architecture as eight drawn plates (open in a browser); contains the canonical "Budgets" table |
| `docs/architecture/error-telemetry-architecture.png` | — | the one-page diagram |
| `docs/api.md` | 399 | the HTTP contract in prose, including "not yet built" |
| `docs/schema.md` | 245 | collections, fields and every index, with the reasoning |
| `docs/glossary.md` | 572 | plain-English definitions, and the best explanation of percentiles here |
| `docs/runbook.md` | 129 | the local walkthrough, step by step |
| `docs/ai-agent-integration.md` | 202 | a ready-made prompt for Claude Code / Cursor / Codex / Copilot |
| `docs/upgrade-to-0.3.md` | 201 | the upgrade prompt (fingerprints change once) |
| `docs/openapi.json` | — | machine-readable OpenAPI 3.1 (a test fails if stale) |
| `packages/sdk-node/README.md` | 177 | the SDK reference |
| `packages/agent/README.md` | 70 | the Agent's responsibilities and **its v1 simplifications** |
| `packages/backend/README.md` | 80 | backend specifics |
| `packages/dashboard/README.md` | 72 | the dashboard's views |
| `examples/demo-app/README.md` | 74 | the demo and the E2E test |
| `CONTRIBUTING.md` · `CODE_OF_CONDUCT.md` · `SECURITY.md` | — | process; report security issues privately |
| `doc.md` | 789 | **not documentation** (§3.2) |

Note on the blueprint: the numerical **"Budgets" table** (hot-path µs, memory, batch sizes,
timeouts, retries, edge p99) lives in `bugbuster-blueprint.html`, not in the markdown design doc.
The same numbers are reproduced in §16.1 of this document from their source of truth,
`packages/types/src/config.ts`.

---

## 38. Appendix: file inventory and provenance

### 38.1 Every source file, by package

**`packages/types/src`** — `config.ts`, `envelope.ts`, `event.ts`, `issue.ts`, `log.ts`, `org.ts`,
`headers.ts`, `codec.ts`, `index.ts`

**`packages/sdk-node/src`** — `index.ts`, `capture.ts`, `context.ts`, `directives.ts`,
`drop-counters.ts`, `logger.ts`, `raw-capture.ts`, `ring-buffer.ts`, `sampler.ts`,
`trace-propagation.ts`, `transport/{transport,http-transport,uds-transport}.ts`,
`worker/{fingerprint,fold,log,pipeline,redact,sanitize-fields,serialize,stack}.ts`,
`integrations/{express,log-stream}.ts`, `test/bench/capture.bench.ts`

**`packages/agent/src`** — `index.ts`, `uds-server.ts`, `merge-fold-deltas.ts`,
`build-outgoing-envelope.ts`, `http-client.ts`, `circuit-breaker.ts`, `spool.ts`;
`scripts/{install,uninstall}.sh`

**`packages/backend/src`** — `index.ts`, `build-server.ts`, `env.ts`, `directives.ts`,
`openapi.ts`, `admin-page.ts`, `create-org-cli.ts`, `openapi-cli.ts`, `cleanup-events-cli.ts`,
`ingest/{edge,processor}.ts`, `query/{causes,fidelity}.ts`,
`alerts/{notifier,spike,email,brevo}.ts`,
`db/{control,tenant,maintenance,storage-report}.ts`,
`db/collections/{issues,issue-links,events,logs,deploys}.ts`; plus `app.ts` and `vercel.json`

**`packages/dashboard`** — `src/index.html` (1 793 lines, no build step)

**`examples`** — `demo-app/src/{app,index}.ts`, `demo-app/test/{full-pipeline,logs-pipeline}.test.ts`,
`root-cause-demo/traffic.mjs`

### 38.2 The documents this one was built from

Written from the source tree, cross-checked against `README.md`, `docs/api.md`, `docs/schema.md`,
`docs/glossary.md`, `docs/runbook.md`, `docs/architecture/ingest-pipeline.md`,
`docs/architecture/root-cause-graph.md`, the five package READMEs, `.github/workflows/ci.yml`,
`infra/docker-compose.yml`, and every `package.json` in the workspace.

**Verified during authoring** (not assumed): the unit test suite was executed —
231 tests across 35 files, all passing; the route table was read out of `build-server.ts` (22
registrations, 21 paths); every constant quoted in §8–§14 and §16 was read from its defining file.

**Not verified** (and therefore not claimed): the integration suites (need a `mongod` binary), any
timing number in the docs (`< 5 µs`, p99 < 15 ms — those are design targets, and the blueprint says
so explicitly: *"until the hot path is measured under load in a host application, '< 5 µs' is an
intention"*), and the Agent installer on a real production Linux host (§18.5).

**Deliberate omissions from this document:** none of the design reasoning in
`docs/architecture/ingest-pipeline.md` is reproduced here in full — that document is worth reading
directly, and §37 tells you which sections to read for what.
