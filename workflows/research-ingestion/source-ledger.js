"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../governance-automation/common.js");

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

function readLedger(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { schema_version: "phase16-source-ledger-v1", next_sequence: 0, chain_head: ZERO_HASH, entries: [] };
    }
    throw error;
  }
}

function writeLedger(filePath, ledger) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(canonicalize(ledger)), "utf8");
}

function createSourceLedger(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const ledgerPath = path.resolve(safeString(options.ledgerPath) || path.join(process.cwd(), "workspace", "research-index", "source-ledger.json"));

  function appendSourceEntry(entry = {}) {
    const ledger = readLedger(ledgerPath);
    const sequence = Math.max(0, Number(ledger.next_sequence || 0)) + 1;
    const prev = safeString(ledger.chain_head) || ZERO_HASH;

    const base = canonicalize({
      sequence,
      timestamp: safeString(entry.timestamp) || "1970-01-01T00:00:00.000Z",
      source: safeString(entry.source),
      canonical_key: safeString(entry.canonical_key),
      input_hash: safeString(entry.input_hash),
      prev_chain_hash: prev,
      metadata: entry.metadata && typeof entry.metadata === "object" ? canonicalize(entry.metadata) : {}
    });

    const entryHash = sha256(`phase16-source-entry-v1|${JSON.stringify(base)}`);
    const chainHash = sha256(`${prev}|${entryHash}`);
    const persisted = canonicalize({ ...base, entry_hash: entryHash, chain_hash: chainHash });

    ledger.entries.push(persisted);
    ledger.entries.sort((left, right) => Number(left.sequence) - Number(right.sequence));
    ledger.next_sequence = sequence;
    ledger.chain_head = chainHash;
    writeLedger(ledgerPath, ledger);

    logger.info({ event: "phase16_source_ledger_append", sequence, source: persisted.source });
    return persisted;
  }

  function verifyChainIntegrity() {
    const ledger = readLedger(ledgerPath);
    let prev = ZERO_HASH;
    let expectedSequence = 1;

    for (const entry of Array.isArray(ledger.entries) ? ledger.entries : []) {
      if (Number(entry.sequence) !== expectedSequence) {
        return { valid: false, reason: "sequence_non_contiguous", broken_at: expectedSequence };
      }
      if (safeString(entry.prev_chain_hash) !== prev) {
        return { valid: false, reason: "prev_chain_hash_mismatch", broken_at: expectedSequence };
      }

      const base = canonicalize({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        source: entry.source,
        canonical_key: entry.canonical_key,
        input_hash: entry.input_hash,
        prev_chain_hash: entry.prev_chain_hash,
        metadata: entry.metadata || {}
      });
      const expectedEntryHash = sha256(`phase16-source-entry-v1|${JSON.stringify(base)}`);
      const expectedChainHash = sha256(`${entry.prev_chain_hash}|${expectedEntryHash}`);
      if (safeString(entry.entry_hash) !== expectedEntryHash) {
        return { valid: false, reason: "entry_hash_mismatch", broken_at: expectedSequence };
      }
      if (safeString(entry.chain_hash) !== expectedChainHash) {
        return { valid: false, reason: "chain_hash_mismatch", broken_at: expectedSequence };
      }

      prev = expectedChainHash;
      expectedSequence += 1;
    }

    if (safeString(ledger.chain_head) !== prev) {
      return { valid: false, reason: "chain_head_mismatch", broken_at: expectedSequence - 1 };
    }

    return { valid: true, reason: "ok", count: expectedSequence - 1 };
  }

  return Object.freeze({
    appendSourceEntry,
    verifyChainIntegrity,
    ledgerPath
  });
}

module.exports = {
  createSourceLedger
};
