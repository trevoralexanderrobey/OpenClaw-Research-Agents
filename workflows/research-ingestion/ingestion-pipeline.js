"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../governance-automation/common.js");
const { normalizeRecord, canonicalPaperKey } = require("./normalizer.js");
const { computeNormalizedScore } = require("./citation-metrics.js");
const { createSourceLedger } = require("./source-ledger.js");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, canonicalJson(canonicalize(value)), "utf8");
}

function createIngestionPipeline(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  const connectors = options.connectors && typeof options.connectors === "object" ? options.connectors : {};
  const rawDir = path.resolve(safeString(options.rawDir) || path.join(process.cwd(), "workspace", "research-raw"));
  const normalizedDir = path.resolve(safeString(options.normalizedDir) || path.join(process.cwd(), "workspace", "research-normalized"));
  const indexDir = path.resolve(safeString(options.indexDir) || path.join(process.cwd(), "workspace", "research-index"));
  const sourceLedger = options.sourceLedger || createSourceLedger({ logger, ledgerPath: path.join(indexDir, "source-ledger.json") });

  async function ingestFromSources(sourceSpec = {}) {
    const source = safeString(sourceSpec.source);
    const query = safeString(sourceSpec.query);
    const limit = Math.max(1, Number(sourceSpec.limit || 10));

    const connector = connectors[source];
    if (!connector || typeof connector.searchPapers !== "function") {
      const error = new Error(`No connector configured for source '${source}'`);
      error.code = "PHASE16_CONNECTOR_MISSING";
      throw error;
    }

    const records = await connector.searchPapers(query, { limit });
    const normalized = records.map((record) => normalizeRecord(record));

    const dedupedMap = new Map();
    for (const record of normalized) {
      const key = canonicalPaperKey(record);
      if (!dedupedMap.has(key)) {
        dedupedMap.set(key, canonicalize({ ...record, canonicalKey: key }));
      }
    }

    const deduped = Array.from(dedupedMap.values()).sort((left, right) => safeString(left.canonicalKey).localeCompare(safeString(right.canonicalKey)));
    const digest = sha256(JSON.stringify(deduped));

    const timestamp = safeString(timeProvider.nowIso());
    const rawPath = path.join(rawDir, `${source}-${digest.slice(0, 12)}.json`);
    const normalizedPath = path.join(normalizedDir, `${source}-${digest.slice(0, 12)}.json`);

    writeJson(rawPath, { source, query, fetched_at: timestamp, records: canonicalize(records) });
    writeJson(normalizedPath, { source, query, normalized_at: timestamp, records: deduped });

    for (const record of deduped) {
      sourceLedger.appendSourceEntry({
        timestamp,
        source,
        canonical_key: safeString(record.canonicalKey),
        input_hash: sha256(JSON.stringify(record)),
        metadata: { query, normalized_path: normalizedPath }
      });
    }

    const metrics = computeNormalizedScore(deduped);
    return canonicalize({
      source,
      query,
      fetched_at: timestamp,
      raw_path: rawPath,
      normalized_path: normalizedPath,
      record_count: deduped.length,
      metrics,
      digest
    });
  }

  async function runIngestionJob(jobSpec = {}, context = {}) {
    const sources = Array.isArray(jobSpec.sources) ? jobSpec.sources : [];
    const results = [];
    for (const sourceSpec of sources) {
      const result = await ingestFromSources(sourceSpec);
      results.push(result);
    }

    const jobSummary = canonicalize({
      job_id: safeString(jobSpec.jobId) || `ingest-${sha256(JSON.stringify(sources)).slice(0, 12)}`,
      started_at: safeString(context.startedAt) || safeString(timeProvider.nowIso()),
      completed_at: safeString(timeProvider.nowIso()),
      result_count: results.length,
      results
    });

    const outPath = path.join(indexDir, `${jobSummary.job_id}.json`);
    writeJson(outPath, jobSummary);
    logger.info({ event: "phase16_ingestion_job_completed", job_id: jobSummary.job_id, result_count: results.length });

    return canonicalize({ ...jobSummary, summary_path: outPath });
  }

  return Object.freeze({
    runIngestionJob,
    ingestFromSources
  });
}

module.exports = {
  createIngestionPipeline
};
