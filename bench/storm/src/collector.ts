import { createServer, type Server } from "node:http";
import { gunzipSync, gzipSync, zstdDecompressSync } from "node:zlib";
import { decodeEnvelopeItems } from "@bugbusterhq/types";

/**
 * Stands in for both backends: a BugBuster `/ingest` and an OTLP/HTTP `/v1/traces` endpoint on
 * one local server, so neither SDK has a network advantage. It counts what arrives — bytes as
 * sent, bytes once decompressed, and the same bytes gzipped here, so every row can be compared at
 * the same compression — and decodes what it can to count records.
 */
export interface CollectorStats {
  requests: number;
  /** Bytes of request bodies exactly as sent (compressed when the sender compressed). */
  wireBytes: number;
  /** Bytes once decompressed: what the sender serialized. */
  rawBytes: number;
  /** Each body gzipped here (level 6): the size at equal compression for every SDK. */
  gzipBytes: number;
  // BugBuster
  folds: number;
  exemplars: number;
  /** Example events a real backend would store: at most 6 per issue (ingest-pipeline.md §4.1). */
  exemplarsStored: number;
  /** Errors the received fold records account for (the sum of their counts). */
  eventsAccounted: number;
  /** Errors the SDK reported dropping (its drop counters: buffer full + sampled out + quota). */
  bugbusterDropped: number;
  fingerprints: Set<string>;
  // OpenTelemetry (counted only for OTLP/JSON; protobuf bodies are measured, not decoded)
  spans: number;
}

const MAX_EXEMPLARS_PER_ISSUE = 6;

function emptyStats(): CollectorStats {
  return {
    requests: 0,
    wireBytes: 0,
    rawBytes: 0,
    gzipBytes: 0,
    folds: 0,
    exemplars: 0,
    exemplarsStored: 0,
    eventsAccounted: 0,
    bugbusterDropped: 0,
    fingerprints: new Set(),
    spans: 0,
  };
}

export class Collector {
  private server: Server;
  private stats = emptyStats();
  private exemplarsPerIssue = new Map<string, number>();
  url = "";

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const wire = Buffer.concat(chunks);
        let raw = wire;
        const encoding = req.headers["content-encoding"];
        if (encoding === "zstd") raw = zstdDecompressSync(wire);
        else if (encoding === "gzip") raw = gunzipSync(wire);

        this.stats.requests++;
        this.stats.wireBytes += wire.length;
        this.stats.rawBytes += raw.length;
        this.stats.gzipBytes += gzipSync(raw).length;

        if (req.url?.startsWith("/ingest")) {
          this.countBugBuster(raw);
          res.writeHead(202).end();
        } else if (req.url?.startsWith("/v1/traces")) {
          if (String(req.headers["content-type"]).includes("json")) this.countOtlpJson(raw);
          res.writeHead(200, { "content-type": String(req.headers["content-type"]) }).end();
        } else {
          res.writeHead(404).end();
        }
      });
    });
  }

  private countBugBuster(raw: Buffer): void {
    for (const item of decodeEnvelopeItems(raw)) {
      if (item.type === "fold") {
        this.stats.folds++;
        this.stats.eventsAccounted += item.payload.count;
        this.stats.fingerprints.add(item.payload.fingerprint);
      } else if (item.type === "exemplar") {
        this.stats.exemplars++;
        const fp = item.payload.fingerprint;
        const kept = this.exemplarsPerIssue.get(fp) ?? 0;
        if (kept < MAX_EXEMPLARS_PER_ISSUE) {
          this.exemplarsPerIssue.set(fp, kept + 1);
          this.stats.exemplarsStored++;
        }
      } else if (item.type === "meta") {
        const m = item.payload;
        this.stats.bugbusterDropped += m.droppedBufferFull + m.droppedQuota + m.sampledOut;
      }
    }
  }

  private countOtlpJson(raw: Buffer): void {
    try {
      const body = JSON.parse(raw.toString("utf8")) as {
        resourceSpans?: { scopeSpans?: { spans?: unknown[] }[] }[];
      };
      for (const rs of body.resourceSpans ?? []) {
        for (const ss of rs.scopeSpans ?? []) this.stats.spans += ss.spans?.length ?? 0;
      }
    } catch {
      // not ours to judge; bytes are still counted
    }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${port}`;
  }

  /** Returns everything counted since the last call, and starts counting afresh. */
  take(): CollectorStats {
    const s = this.stats;
    this.stats = emptyStats();
    this.exemplarsPerIssue.clear();
    return s;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
