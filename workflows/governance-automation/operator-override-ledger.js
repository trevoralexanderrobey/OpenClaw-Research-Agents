"use strict";

const {
  assertKillSwitchOpen,
  assertOperatorRole,
  consumeScopedApprovalToken,
  ensureComplianceGovernanceState,
  safeString
} = require("../compliance-governance/compliance-validator.js");
const {
  canonicalize,
  sha256
} = require("./common.js");

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 9 override ledger error"));
  error.code = String(code || "PHASE9_OVERRIDE_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeLedgerState(complianceGovernance) {
  const state = complianceGovernance;
  if (!state.operatorOverrideLedger || typeof state.operatorOverrideLedger !== "object") {
    state.operatorOverrideLedger = {
      records: [],
      nextSequence: 0,
      chainHead: ""
    };
  }
  if (!Array.isArray(state.operatorOverrideLedger.records)) {
    state.operatorOverrideLedger.records = [];
  }
  state.operatorOverrideLedger.nextSequence = Math.max(0, Number.parseInt(String(state.operatorOverrideLedger.nextSequence || 0), 10) || 0);
  state.operatorOverrideLedger.chainHead = safeString(state.operatorOverrideLedger.chainHead);
  state.operatorOverrideLedger.records.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  return state.operatorOverrideLedger;
}

function computeOverrideEntryHash(recordWithoutHashes) {
  return sha256(`phase9-override-v1|${canonicalStringify(recordWithoutHashes)}`);
}

function computeOverrideChainHash(prevChainHash, entryHash) {
  return sha256(`${safeString(prevChainHash)}|${safeString(entryHash)}`);
}

function verifyOverrideRecordsChain(recordsInput, chainHead) {
  const records = Array.isArray(recordsInput) ? recordsInput.slice() : [];
  records.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

  let expectedSequence = 1;
  let previousChainHash = "";
  for (const record of records) {
    const sequence = Number(record.sequence || 0);
    if (sequence !== expectedSequence) {
      throw makeError("PHASE9_OVERRIDE_LEDGER_SEQUENCE_INVALID", "Override ledger sequence must be contiguous", {
        expectedSequence,
        sequence
      });
    }

    const withoutHashes = {
      sequence,
      override_id: safeString(record.override_id),
      scope: safeString(record.scope),
      timestamp: safeString(record.timestamp),
      operator: {
        role: safeString(record.operator && record.operator.role),
        id: safeString(record.operator && record.operator.id)
      },
      approval_token_scope: safeString(record.approval_token_scope),
      reason: safeString(record.reason),
      phase_impact: safeString(record.phase_impact),
      override_policy: safeString(record.override_policy),
      governance_transaction_id: safeString(record.governance_transaction_id),
      prev_chain_hash: safeString(record.prev_chain_hash)
    };

    const expectedEntryHash = computeOverrideEntryHash(withoutHashes);
    const expectedChainHash = computeOverrideChainHash(withoutHashes.prev_chain_hash, expectedEntryHash);

    if (safeString(record.entry_hash) !== expectedEntryHash) {
      throw makeError("PHASE9_OVERRIDE_LEDGER_ENTRY_HASH_MISMATCH", "Override ledger entry hash mismatch", { sequence });
    }
    if (safeString(record.chain_hash) !== expectedChainHash) {
      throw makeError("PHASE9_OVERRIDE_LEDGER_CHAIN_HASH_MISMATCH", "Override ledger chain hash mismatch", { sequence });
    }
    if (safeString(record.prev_chain_hash) !== previousChainHash) {
      throw makeError("PHASE9_OVERRIDE_LEDGER_PREV_HASH_MISMATCH", "Override ledger prev chain hash mismatch", { sequence });
    }

    previousChainHash = expectedChainHash;
    expectedSequence += 1;
  }

  if (safeString(chainHead) !== previousChainHash) {
    throw makeError("PHASE9_OVERRIDE_LEDGER_CHAIN_HEAD_MISMATCH", "Override ledger chain head mismatch", {
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

function createOperatorOverrideLedger(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const fallbackNowIso = "1970-01-01T00:00:00.000Z";
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => fallbackNowIso };
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE9_OVERRIDE_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("PHASE9_OVERRIDE_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required");
  }

  async function recordOverride(input = {}, context = {}) {
    assertOperatorRole(context);

    const scope = safeString(input.approval_scope) || "governance.override.apply";
    const reason = safeString(input.reason);
    const phaseImpact = safeString(input.phase_impact);
    const overridePolicy = safeString(input.override_policy);
    const operatorId = safeString(input.operator_id) || safeString(context.requester) || "operator";

    if (!reason) {
      throw makeError("PHASE9_OVERRIDE_REASON_REQUIRED", "Override reason is required");
    }
    if (!phaseImpact) {
      throw makeError("PHASE9_OVERRIDE_PHASE_IMPACT_REQUIRED", "Override phase impact statement is required");
    }
    if (!overridePolicy) {
      throw makeError("PHASE9_OVERRIDE_POLICY_REQUIRED", "Override policy clause is required");
    }

    consumeScopedApprovalToken(operatorAuthorization, input.approvalToken, scope, {
      correlationId: safeString(context.correlationId)
    });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureComplianceGovernanceState(state);
      assertKillSwitchOpen(state);
      const ledger = normalizeLedgerState(state.complianceGovernance);

      const sequence = Math.max(
        Number(ledger.nextSequence || 0),
        ledger.records.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0)
      ) + 1;

      const prevChainHash = ledger.records.length > 0
        ? safeString(ledger.records[ledger.records.length - 1].chain_hash)
        : "";

      const timestamp = String(timeProvider.nowIso());
      const overrideId = `override-${sequence}`;
      const governanceTransactionId = safeString(input.governance_transaction_id) || safeString(context.correlationId) || `phase9-governance-tx-${sequence}`;

      const baseRecord = canonicalize({
        sequence,
        override_id: overrideId,
        scope: safeString(input.scope) || "phase9",
        timestamp,
        operator: {
          role: "operator",
          id: operatorId
        },
        approval_token_scope: scope,
        reason,
        phase_impact: phaseImpact,
        override_policy: overridePolicy,
        governance_transaction_id: governanceTransactionId,
        prev_chain_hash: prevChainHash
      });

      const entryHash = computeOverrideEntryHash(baseRecord);
      const chainHash = computeOverrideChainHash(prevChainHash, entryHash);
      const persisted = canonicalize({
        ...baseRecord,
        entry_hash: entryHash,
        chain_hash: chainHash
      });

      ledger.records.push(persisted);
      ledger.records.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
      ledger.nextSequence = Number(sequence);
      ledger.chainHead = chainHash;

      verifyOverrideRecordsChain(ledger.records, ledger.chainHead);

      logger.info({
        event: "phase9_operator_override_recorded",
        sequence,
        overrideId,
        chainHash
      });

      return {
        ledgerHash: chainHash,
        timestamp,
        operator: operatorId,
        override_id: overrideId
      };
    }, { correlationId: safeString(context.correlationId) });
  }

  async function verifyOverrideLedgerIntegrity(input = {}) {
    try {
      const state = input.state && typeof input.state === "object"
        ? input.state
        : await apiGovernance.readState();
      ensureComplianceGovernanceState(state);
      const ledger = normalizeLedgerState(state.complianceGovernance);
      verifyOverrideRecordsChain(ledger.records, ledger.chainHead);
      return {
        valid: true,
        tamper_detected: false
      };
    } catch (error) {
      logger.warn({
        event: "phase9_override_ledger_tamper_detected",
        code: error && error.code ? error.code : "PHASE9_OVERRIDE_LEDGER_INVALID",
        message: error && error.message ? error.message : String(error)
      });
      return {
        valid: false,
        tamper_detected: true
      };
    }
  }

  return Object.freeze({
    recordOverride,
    verifyOverrideLedgerIntegrity
  });
}

module.exports = {
  createOperatorOverrideLedger,
  normalizeLedgerState,
  computeOverrideEntryHash,
  computeOverrideChainHash,
  verifyOverrideRecordsChain
};
