"use strict";

const {
  assertOperatorRole,
  ensureComplianceGovernanceState,
  safeString
} = require("../compliance-governance/compliance-validator.js");
const {
  canonicalize,
  sha256
} = require("../governance-automation/common.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 10 operational decision ledger error"));
  error.code = String(code || "PHASE10_OPERATIONAL_LEDGER_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeOperationalDecisionLedgerState(complianceGovernance) {
  const source = complianceGovernance && typeof complianceGovernance === "object"
    ? complianceGovernance
    : {};

  if (!source.operationalDecisionLedger || typeof source.operationalDecisionLedger !== "object") {
    source.operationalDecisionLedger = {
      records: [],
      nextSequence: 0,
      chainHead: ""
    };
  }

  const ledger = source.operationalDecisionLedger;
  if (!Array.isArray(ledger.records)) {
    ledger.records = [];
  }
  ledger.nextSequence = Math.max(0, Number.parseInt(String(ledger.nextSequence || 0), 10) || 0);
  ledger.chainHead = safeString(ledger.chainHead);
  ledger.records.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

  return ledger;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function computeOperationalEntryHash(recordWithoutHashes) {
  return sha256(`phase10-operational-decision-v1|${canonicalStringify(recordWithoutHashes)}`);
}

function computeOperationalChainHash(prevChainHash, entryHash) {
  return sha256(`${safeString(prevChainHash)}|${safeString(entryHash)}`);
}

function verifyOperationalDecisionLedgerChain(recordsInput, chainHead) {
  const records = Array.isArray(recordsInput) ? recordsInput.slice() : [];
  records.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

  let expectedSequence = 1;
  let previousChainHash = "";

  for (const record of records) {
    const sequence = Number(record.sequence || 0);
    if (sequence !== expectedSequence) {
      throw makeError("PHASE10_OPERATIONAL_LEDGER_SEQUENCE_INVALID", "Operational decision ledger sequence must be contiguous", {
        expectedSequence,
        sequence
      });
    }

    const withoutHashes = {
      sequence,
      decision_id: safeString(record.decision_id),
      timestamp: safeString(record.timestamp),
      event_type: safeString(record.event_type),
      actor: safeString(record.actor),
      action: safeString(record.action),
      result: safeString(record.result),
      scope: safeString(record.scope),
      details: canonicalize(record.details && typeof record.details === "object" ? record.details : {}),
      prev_chain_hash: safeString(record.prev_chain_hash)
    };

    const expectedEntryHash = computeOperationalEntryHash(withoutHashes);
    const expectedChainHash = computeOperationalChainHash(withoutHashes.prev_chain_hash, expectedEntryHash);

    if (safeString(record.entry_hash) !== expectedEntryHash) {
      throw makeError("PHASE10_OPERATIONAL_LEDGER_ENTRY_HASH_MISMATCH", "Operational decision ledger entry hash mismatch", { sequence });
    }
    if (safeString(record.chain_hash) !== expectedChainHash) {
      throw makeError("PHASE10_OPERATIONAL_LEDGER_CHAIN_HASH_MISMATCH", "Operational decision ledger chain hash mismatch", { sequence });
    }
    if (safeString(record.prev_chain_hash) !== previousChainHash) {
      throw makeError("PHASE10_OPERATIONAL_LEDGER_PREV_HASH_MISMATCH", "Operational decision ledger prev hash mismatch", { sequence });
    }

    previousChainHash = expectedChainHash;
    expectedSequence += 1;
  }

  if (safeString(chainHead) !== previousChainHash) {
    throw makeError("PHASE10_OPERATIONAL_LEDGER_CHAIN_HEAD_MISMATCH", "Operational decision ledger chain head mismatch", {
      expected: previousChainHash,
      actual: safeString(chainHead)
    });
  }

  return {
    ok: true,
    count: records.length,
    chainHead: previousChainHash
  };
}

function createOperationalDecisionLedger(options = {}) {
  const apiGovernance = options.apiGovernance;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const fallbackNowIso = "1970-01-01T00:00:00.000Z";
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => fallbackNowIso };

  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE10_OPERATIONAL_LEDGER_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }

  async function recordDecision(input = {}, context = {}) {
    const requireOperatorRole = context && context.requireOperatorRole === true;
    if (requireOperatorRole) {
      assertOperatorRole(context);
    }

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureComplianceGovernanceState(state);
      const ledger = normalizeOperationalDecisionLedgerState(state.complianceGovernance);

      const sequence = Math.max(
        Number(ledger.nextSequence || 0),
        ledger.records.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0)
      ) + 1;

      const prevChainHash = ledger.records.length > 0
        ? safeString(ledger.records[ledger.records.length - 1].chain_hash)
        : "";

      const baseRecord = canonicalize({
        sequence,
        decision_id: `opd-${sequence}`,
        timestamp: safeString(input.timestamp) || String(timeProvider.nowIso()),
        event_type: safeString(input.event_type) || "phase10.event",
        actor: safeString(input.actor) || safeString(context.requester) || "system",
        action: safeString(input.action) || "observe",
        result: safeString(input.result) || "recorded",
        scope: safeString(input.scope) || "phase10",
        details: canonicalize(input.details && typeof input.details === "object" ? input.details : {}),
        prev_chain_hash: prevChainHash
      });

      const entryHash = computeOperationalEntryHash(baseRecord);
      const chainHash = computeOperationalChainHash(prevChainHash, entryHash);
      const persisted = canonicalize({
        ...baseRecord,
        entry_hash: entryHash,
        chain_hash: chainHash
      });

      ledger.records.push(persisted);
      ledger.records.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
      ledger.nextSequence = Number(sequence);
      ledger.chainHead = chainHash;

      verifyOperationalDecisionLedgerChain(ledger.records, ledger.chainHead);

      logger.info({
        event: "phase10_operational_decision_recorded",
        sequence,
        decisionId: persisted.decision_id,
        chainHash
      });

      return {
        decision_id: persisted.decision_id,
        sequence,
        chain_hash: chainHash,
        timestamp: persisted.timestamp
      };
    }, {
      correlationId: safeString(context.correlationId)
    });
  }

  async function verifyOperationalDecisionLedgerIntegrity(input = {}) {
    try {
      const state = input.state && typeof input.state === "object"
        ? input.state
        : await apiGovernance.readState();
      ensureComplianceGovernanceState(state);
      const ledger = normalizeOperationalDecisionLedgerState(state.complianceGovernance);
      verifyOperationalDecisionLedgerChain(ledger.records, ledger.chainHead);
      return { valid: true, tamper_detected: false };
    } catch (error) {
      logger.warn({
        event: "phase10_operational_decision_tamper_detected",
        code: error && error.code ? error.code : "PHASE10_OPERATIONAL_LEDGER_INVALID",
        message: error && error.message ? error.message : String(error)
      });
      return { valid: false, tamper_detected: true };
    }
  }

  return Object.freeze({
    recordDecision,
    verifyOperationalDecisionLedgerIntegrity
  });
}

module.exports = {
  createOperationalDecisionLedger,
  normalizeOperationalDecisionLedgerState,
  computeOperationalEntryHash,
  computeOperationalChainHash,
  verifyOperationalDecisionLedgerChain
};
