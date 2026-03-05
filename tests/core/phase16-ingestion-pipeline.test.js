"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const { createIngestionPipeline } = require("../../workflows/research-ingestion/ingestion-pipeline.js");
const { createSourceLedger } = require("../../workflows/research-ingestion/source-ledger.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase16-"));
}

test("phase16 ingestion pipeline dedupes deterministically and writes source ledger", async () => {
  const dir = await makeTmpDir();
  const sourceLedger = createSourceLedger({ ledgerPath: path.join(dir, "source-ledger.json") });

  const pipeline = createIngestionPipeline({
    rawDir: path.join(dir, "raw"),
    normalizedDir: path.join(dir, "normalized"),
    indexDir: path.join(dir, "index"),
    sourceLedger,
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" },
    connectors: {
      arxiv: {
        searchPapers: async () => [
          { source: "arxiv", arxivId: "a1", title: "Paper A", abstract: "A", publishedAt: "2024-01-01T00:00:00.000Z", citationCount: 10 },
          { source: "arxiv", arxivId: "a1", title: "Paper A", abstract: "A", publishedAt: "2024-01-01T00:00:00.000Z", citationCount: 10 }
        ]
      }
    }
  });

  const first = await pipeline.ingestFromSources({ source: "arxiv", query: "test", limit: 10 });
  const second = await pipeline.ingestFromSources({ source: "arxiv", query: "test", limit: 10 });

  assert.equal(first.record_count, 1);
  assert.equal(second.record_count, 1);
  assert.equal(first.digest, second.digest);
  assert.equal(sourceLedger.verifyChainIntegrity().valid, true);
});

test("phase16 source ledger chain integrity detects tamper", async () => {
  const dir = await makeTmpDir();
  const ledgerPath = path.join(dir, "source-ledger.json");
  const sourceLedger = createSourceLedger({ ledgerPath });
  sourceLedger.appendSourceEntry({
    timestamp: "2026-03-05T00:00:00.000Z",
    source: "arxiv",
    canonical_key: "paper-1",
    input_hash: "abc123",
    metadata: {}
  });

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  ledger.entries[0].entry_hash = "tampered";
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

  const integrity = sourceLedger.verifyChainIntegrity();
  assert.equal(integrity.valid, false);
  assert.equal(integrity.reason, "entry_hash_mismatch");
});
