"use strict";

const path = require("node:path");

const { asArray, canonicalize, safeString } = require("../governance-automation/common.js");
const {
  ACCESS_CONTROL_SCHEMA_VERSION,
  canonicalHash,
  normalizeIso,
  readJsonFileIfExists,
  roleAlias,
  writeCanonicalJsonFile
} = require("./access-control-common.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 13 access decision ledger error"));
  error.code = String(code || "PHASE13_ACCESS_LEDGER_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeEntry(entry = {}) {
  return canonicalize({
    sequence: Math.max(1, Number.parseInt(String(entry.sequence || 1), 10) || 1),
    decision_id: safeString(entry.decision_id),
    timestamp: normalizeIso(entry.timestamp),
    actor: safeString(entry.actor),
    role: roleAlias(entry.role),
    action: safeString(entry.action),
    resource: safeString(entry.resource),
    scope: safeString(entry.scope),
    result: safeString(entry.result),
    reason: safeString(entry.reason),
    scopes_evaluated: asArray(entry.scopes_evaluated).map((item) => safeString(item)).filter(Boolean).sort((l, r) => l.localeCompare(r)),
    metadata: entry.metadata && typeof entry.metadata === "object" ? canonicalize(entry.metadata) : {},
    prev_chain_hash: safeString(entry.prev_chain_hash),
    entry_hash: safeString(entry.entry_hash),
    chain_hash: safeString(entry.chain_hash)
  });
}

function computeEntryHash(recordWithoutHashes) {
  return canonicalHash(recordWithoutHashes);
}

function computeChainHash(prevChainHash, entryHash) {
  return canonicalHash({ prev_chain_hash: safeString(prevChainHash), entry_hash: safeString(entryHash) });
}

function normalizeState(state = {}) {
  const source = state && typeof state === "object" ? state : {};
  const decisions = asArray(source.decisions)
    .map((entry) => normalizeEntry(entry))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

  return {
    schema_version: safeString(source.schema_version) || ACCESS_CONTROL_SCHEMA_VERSION,
    next_sequence: Math.max(0, Number.parseInt(String(source.next_sequence || 0), 10) || 0),
    chain_head: safeString(source.chain_head),
    decisions
  };
}

function verifyChainFromState(state) {
  const normalized = normalizeState(state);
  const decisions = normalized.decisions;
  let previousChainHash = "";

  for (let index = 0; index < decisions.length; index += 1) {
    const entry = decisions[index];
    const expectedSequence = index + 1;
    if (Number(entry.sequence) !== expectedSequence) {
      return { valid: false, broken_at: expectedSequence, total_entries: decisions.length };
    }

    const withoutHashes = canonicalize({
      sequence: expectedSequence,
      decision_id: entry.decision_id,
      timestamp: normalizeIso(entry.timestamp),
      actor: entry.actor,
      role: entry.role,
      action: entry.action,
      resource: entry.resource,
      scope: entry.scope,
      result: entry.result,
      reason: entry.reason,
      scopes_evaluated: entry.scopes_evaluated,
      metadata: entry.metadata,
      prev_chain_hash: entry.prev_chain_hash
    });

    const expectedEntryHash = computeEntryHash(withoutHashes);
    const expectedChainHash = computeChainHash(withoutHashes.prev_chain_hash, expectedEntryHash);

    if (entry.prev_chain_hash !== previousChainHash) {
      return { valid: false, broken_at: expectedSequence, total_entries: decisions.length };
    }
    if (entry.entry_hash !== expectedEntryHash) {
      return { valid: false, broken_at: expectedSequence, total_entries: decisions.length };
    }
    if (entry.chain_hash !== expectedChainHash) {
      return { valid: false, broken_at: expectedSequence, total_entries: decisions.length };
    }

    previousChainHash = expectedChainHash;
  }

  if (normalized.chain_head !== previousChainHash) {
    return { valid: false, broken_at: decisions.length || 1, total_entries: decisions.length };
  }

  return { valid: true, broken_at: null, total_entries: decisions.length };
}

function createAccessDecisionLedger(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const storePath = path.resolve(safeString(options.storePath) || path.join(process.cwd(), "security", "access-decision-ledger.json"));

  let appendQueue = Promise.resolve();

  function readState() {
    return normalizeState(readJsonFileIfExists(storePath, {
      schema_version: ACCESS_CONTROL_SCHEMA_VERSION,
      next_sequence: 0,
      chain_head: "",
      decisions: []
    }));
  }

  function persistState(state) {
    writeCanonicalJsonFile(storePath, canonicalize(state));
  }

  async function recordDecision(input = {}) {
    appendQueue = appendQueue.then(async () => {
      const state = readState();
      const integrity = verifyChainFromState(state);
      if (!integrity.valid) {
        throw makeError("PHASE13_ACCESS_LEDGER_CHAIN_INVALID", "cannot append to broken access ledger", integrity);
      }

      const sequence = Number(state.next_sequence || state.decisions.length) + 1;
      const prevChainHash = safeString(state.chain_head);
      const baseRecord = canonicalize({
        sequence,
        decision_id: safeString(input.decision_id) || `acd-${sequence}`,
        timestamp: normalizeIso(input.timestamp || timeProvider.nowIso()),
        actor: safeString(input.actor),
        role: roleAlias(input.role),
        action: safeString(input.action),
        resource: safeString(input.resource),
        scope: safeString(input.scope),
        result: safeString(input.result) || "deny",
        reason: safeString(input.reason) || "unspecified",
        scopes_evaluated: asArray(input.scopes_evaluated).map((item) => safeString(item)).filter(Boolean).sort((l, r) => l.localeCompare(r)),
        metadata: input.metadata && typeof input.metadata === "object" ? canonicalize(input.metadata) : {},
        prev_chain_hash: prevChainHash
      });

      const entryHash = computeEntryHash(baseRecord);
      const chainHash = computeChainHash(prevChainHash, entryHash);
      const entry = canonicalize({
        ...baseRecord,
        entry_hash: entryHash,
        chain_hash: chainHash
      });

      state.decisions.push(entry);
      state.next_sequence = sequence;
      state.chain_head = chainHash;

      persistState(state);

      logger.info({
        event: "phase13_access_decision_recorded",
        decision_id: entry.decision_id,
        result: entry.result,
        chain_hash: chainHash
      });

      return { entry, chain_hash: chainHash };
    });

    return appendQueue;
  }

  function verifyChainIntegrity() {
    return verifyChainFromState(readState());
  }

  function getDecisions(filter = {}) {
    const state = readState();
    const actor = safeString(filter.actor);
    const result = safeString(filter.result);
    const action = safeString(filter.action);
    const scope = safeString(filter.scope);

    return canonicalize(state.decisions.filter((entry) => {
      if (actor && entry.actor !== actor) {
        return false;
      }
      if (result && entry.result !== result) {
        return false;
      }
      if (action && entry.action !== action) {
        return false;
      }
      if (scope && entry.scope !== scope) {
        return false;
      }
      return true;
    }));
  }

  return Object.freeze({
    storePath,
    recordDecision,
    verifyChainIntegrity,
    getDecisions,
    _debug_readState: readState,
    _debug_computeEntryHash: computeEntryHash,
    _debug_computeChainHash: computeChainHash
  });
}

module.exports = {
  createAccessDecisionLedger,
  computeEntryHash,
  computeChainHash
};
