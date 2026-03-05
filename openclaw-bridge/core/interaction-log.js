"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

const INTERACTION_LOG_SCHEMA_VERSION = "phase14-interaction-log-v1";
const CHAIN_ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeTimestamp(value, fallback) {
  const text = safeString(value) || safeString(fallback);
  if (!text) {
    return "1970-01-01T00:00:00.000Z";
  }
  if (!Number.isFinite(Date.parse(text))) {
    return "1970-01-01T00:00:00.000Z";
  }
  return text;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeEntry(entry = {}) {
  return canonicalize({
    sequence: Math.max(1, Number.parseInt(String(entry.sequence || 1), 10) || 1),
    interaction_id: safeString(entry.interaction_id),
    task_id: safeString(entry.task_id),
    timestamp: normalizeTimestamp(entry.timestamp, "1970-01-01T00:00:00.000Z"),
    provider: safeString(entry.provider),
    model: safeString(entry.model),
    prompt_hash: safeString(entry.prompt_hash),
    prompt_preview: safeString(entry.prompt_preview),
    response_hash: safeString(entry.response_hash),
    response_preview: safeString(entry.response_preview),
    duration_ms: Math.max(0, Number.parseInt(String(entry.duration_ms || 0), 10) || 0),
    token_count: Math.max(0, Number.parseInt(String(entry.token_count || 0), 10) || 0),
    metadata: isPlainObject(entry.metadata) ? canonicalize(entry.metadata) : {},
    prev_chain_hash: safeString(entry.prev_chain_hash),
    entry_hash: safeString(entry.entry_hash),
    chain_hash: safeString(entry.chain_hash)
  });
}

function normalizeState(state = {}) {
  const source = isPlainObject(state) ? state : {};
  const entries = Array.isArray(source.entries)
    ? source.entries.map((entry) => normalizeEntry(entry)).sort((left, right) => Number(left.sequence) - Number(right.sequence))
    : [];

  return {
    schema_version: safeString(source.schema_version) || INTERACTION_LOG_SCHEMA_VERSION,
    next_sequence: Math.max(0, Number.parseInt(String(source.next_sequence || 0), 10) || 0),
    chain_head: safeString(source.chain_head) || CHAIN_ZERO_HASH,
    entries
  };
}

function computeEntryHash(entryWithoutHashes) {
  return sha256(`interaction-entry-v1|${JSON.stringify(canonicalize(entryWithoutHashes))}`);
}

function computeChainHash(prevChainHash, entryHash) {
  const prev = safeString(prevChainHash) || CHAIN_ZERO_HASH;
  return sha256(`${prev}|${safeString(entryHash)}`);
}

function verifyChainIntegrity(state) {
  const normalized = normalizeState(state);
  let prev = CHAIN_ZERO_HASH;
  let expectedSequence = 1;
  for (const entry of normalized.entries) {
    if (Number(entry.sequence) !== expectedSequence) {
      return { valid: false, broken_at: expectedSequence, reason: "sequence_non_contiguous" };
    }
    if (entry.prev_chain_hash !== prev) {
      return { valid: false, broken_at: expectedSequence, reason: "prev_chain_hash_mismatch" };
    }

    const withoutHashes = {
      sequence: entry.sequence,
      interaction_id: entry.interaction_id,
      task_id: entry.task_id,
      timestamp: entry.timestamp,
      provider: entry.provider,
      model: entry.model,
      prompt_hash: entry.prompt_hash,
      prompt_preview: entry.prompt_preview,
      response_hash: entry.response_hash,
      response_preview: entry.response_preview,
      duration_ms: entry.duration_ms,
      token_count: entry.token_count,
      metadata: entry.metadata,
      prev_chain_hash: entry.prev_chain_hash
    };

    const expectedEntryHash = computeEntryHash(withoutHashes);
    const expectedChainHash = computeChainHash(entry.prev_chain_hash, expectedEntryHash);

    if (entry.entry_hash !== expectedEntryHash) {
      return { valid: false, broken_at: expectedSequence, reason: "entry_hash_mismatch" };
    }
    if (entry.chain_hash !== expectedChainHash) {
      return { valid: false, broken_at: expectedSequence, reason: "chain_hash_mismatch" };
    }

    prev = expectedChainHash;
    expectedSequence += 1;
  }

  if (normalized.chain_head !== prev) {
    return { valid: false, broken_at: expectedSequence - 1, reason: "chain_head_mismatch" };
  }

  return { valid: true, broken_at: null, reason: "ok", total_entries: normalized.entries.length };
}

function createInteractionLog(options = {}) {
  const logger = isPlainObject(options.logger) ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const storePath = path.resolve(safeString(options.storePath) || path.join(process.cwd(), "security", "interaction-log.json"));

  let appendChain = Promise.resolve();

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
      return normalizeState(parsed);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return normalizeState({
          schema_version: INTERACTION_LOG_SCHEMA_VERSION,
          next_sequence: 0,
          chain_head: CHAIN_ZERO_HASH,
          entries: []
        });
      }
      throw error;
    }
  }

  function writeState(state) {
    ensureParent(storePath);
    fs.writeFileSync(storePath, canonicalJson(canonicalize(state)), "utf8");
  }

  async function recordInteraction(input = {}) {
    appendChain = appendChain.then(async () => {
      const state = readState();
      const integrity = verifyChainIntegrity(state);
      if (!integrity.valid) {
        const error = new Error("interaction log chain integrity check failed");
        error.code = "PHASE14_INTERACTION_CHAIN_INVALID";
        error.details = integrity;
        throw error;
      }

      const sequence = Number(state.next_sequence || state.entries.length) + 1;
      const prompt = safeString(input.prompt);
      const response = safeString(input.response);
      const timestamp = normalizeTimestamp(input.timestamp, timeProvider.nowIso());
      const taskId = safeString(input.taskId);
      const provider = safeString(input.provider) || "mock";
      const model = safeString(input.model) || "mock-v1";
      const prev = safeString(state.chain_head) || CHAIN_ZERO_HASH;

      const entryWithoutHashes = canonicalize({
        sequence,
        interaction_id: safeString(input.interactionId) || `int-${sequence}`,
        task_id: taskId,
        timestamp,
        provider,
        model,
        prompt_hash: sha256(prompt),
        prompt_preview: prompt.slice(0, 256),
        response_hash: sha256(response),
        response_preview: response.slice(0, 256),
        duration_ms: Math.max(0, Number.parseInt(String(input.duration || input.duration_ms || 0), 10) || 0),
        token_count: Math.max(0, Number.parseInt(String(input.tokenCount || input.token_count || 0), 10) || 0),
        metadata: isPlainObject(input.metadata) ? canonicalize(input.metadata) : {},
        prev_chain_hash: prev
      });

      const entryHash = computeEntryHash(entryWithoutHashes);
      const chainHash = computeChainHash(prev, entryHash);
      const entry = canonicalize({
        ...entryWithoutHashes,
        entry_hash: entryHash,
        chain_hash: chainHash
      });

      state.entries.push(entry);
      state.entries.sort((left, right) => Number(left.sequence) - Number(right.sequence));
      state.next_sequence = sequence;
      state.chain_head = chainHash;

      writeState(state);
      logger.info({ event: "phase14_interaction_recorded", interaction_id: entry.interaction_id, task_id: entry.task_id });
      return entry;
    });

    return appendChain;
  }

  function getInteractions(filter = {}) {
    const state = readState();
    const taskId = safeString(filter.taskId);
    const provider = safeString(filter.provider);
    const fromIso = safeString(filter.from);
    const toIso = safeString(filter.to);

    const fromMs = fromIso ? Date.parse(fromIso) : Number.NEGATIVE_INFINITY;
    const toMs = toIso ? Date.parse(toIso) : Number.POSITIVE_INFINITY;

    return canonicalize(state.entries.filter((entry) => {
      if (taskId && entry.task_id !== taskId) return false;
      if (provider && entry.provider !== provider) return false;
      const tsMs = Date.parse(entry.timestamp);
      if (Number.isFinite(fromMs) && tsMs < fromMs) return false;
      if (Number.isFinite(toMs) && tsMs > toMs) return false;
      return true;
    }));
  }

  function getInteractionCount() {
    const state = readState();
    return state.entries.length;
  }

  return Object.freeze({
    storePath,
    recordInteraction,
    getInteractions,
    getInteractionCount,
    verifyChainIntegrity: () => verifyChainIntegrity(readState())
  });
}

module.exports = {
  INTERACTION_LOG_SCHEMA_VERSION,
  CHAIN_ZERO_HASH,
  createInteractionLog,
  computeEntryHash,
  computeChainHash,
  verifyChainIntegrity
};
