"use strict";

const {
  RolloutDecisionRecordSchema,
  RolloutDecisionRecordWithoutHashSchema,
  DecisionLedgerRecordSchema,
  computeDecisionHash,
  computeDecisionChainHash,
  makeError
} = require("./experiment-schema.js");

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeDecisionForHash(decision = {}) {
  return {
    sequence: Number(decision.sequence || 0),
    experimentSequence: Number(decision.experimentSequence || 0),
    decidedAt: safeString(decision.decidedAt),
    decidedBy: safeString(decision.decidedBy),
    decision: safeString(decision.decision),
    reasonCode: safeString(decision.reasonCode),
    approvalToken: safeString(decision.approvalToken),
    idempotencyKey: safeString(decision.idempotencyKey),
    prevDecisionHash: safeString(decision.prevDecisionHash)
  };
}

function verifyRolloutDecisionHashChain(decisionsInput) {
  const decisions = asArray(decisionsInput)
    .map((entry) => RolloutDecisionRecordSchema.parse(entry))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

  let expectedPrevDecisionHash = "";
  let previousSequence = 0;

  for (const decision of decisions) {
    if (Number(decision.sequence) <= previousSequence) {
      throw makeError("PHASE7_ROLLOUT_SEQUENCE_INVALID", "Rollout decision sequence must be strictly increasing", {
        sequence: decision.sequence,
        previousSequence
      });
    }

    const withoutHash = RolloutDecisionRecordWithoutHashSchema.parse(normalizeDecisionForHash(decision));
    const expectedDecisionHash = computeDecisionHash(withoutHash);

    if (safeString(decision.prevDecisionHash) !== expectedPrevDecisionHash) {
      throw makeError("PHASE7_DECISION_PREV_HASH_MISMATCH", "Rollout decision prevDecisionHash mismatch", {
        sequence: decision.sequence,
        expectedPrevDecisionHash,
        actualPrevDecisionHash: safeString(decision.prevDecisionHash)
      });
    }

    if (safeString(decision.decisionHash) !== expectedDecisionHash) {
      throw makeError("PHASE7_DECISION_HASH_MISMATCH", "Rollout decision hash mismatch", {
        sequence: decision.sequence,
        expectedDecisionHash,
        actualDecisionHash: safeString(decision.decisionHash)
      });
    }

    expectedPrevDecisionHash = expectedDecisionHash;
    previousSequence = Number(decision.sequence);
  }

  return {
    ok: true,
    count: decisions.length,
    decisions
  };
}

function buildExpectedLedgerFromDecisions(decisionsInput) {
  const verified = verifyRolloutDecisionHashChain(decisionsInput);
  let previousChainHash = "";

  const records = verified.decisions.map((decision, index) => {
    const sequence = index + 1;
    const entry = DecisionLedgerRecordSchema.parse({
      sequence,
      decisionSequence: Number(decision.sequence),
      recordedAt: safeString(decision.decidedAt),
      prevDecisionHash: safeString(decision.prevDecisionHash),
      decisionHash: safeString(decision.decisionHash),
      chainHash: computeDecisionChainHash(safeString(decision.prevDecisionHash), safeString(decision.decisionHash))
    });

    if (sequence > 1 && safeString(entry.prevDecisionHash) !== safeString(verified.decisions[index - 1].decisionHash)) {
      throw makeError("PHASE7_LEDGER_DECISION_CHAIN_INVALID", "Ledger decision chain link mismatch", {
        sequence,
        prevDecisionHash: entry.prevDecisionHash
      });
    }

    previousChainHash = safeString(entry.chainHash);
    return entry;
  });

  return {
    records,
    chainHead: previousChainHash,
    nextSequence: records.length
  };
}

function verifyDecisionLedgerChain(recordsInput, chainHeadInput = "") {
  const records = asArray(recordsInput)
    .map((entry) => DecisionLedgerRecordSchema.parse(entry))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

  let previousSequence = 0;
  let lastChainHash = "";

  for (const record of records) {
    if (Number(record.sequence) !== previousSequence + 1) {
      throw makeError("PHASE7_LEDGER_SEQUENCE_INVALID", "Ledger sequence must be contiguous starting at 1", {
        sequence: record.sequence,
        previousSequence
      });
    }
    const expectedChainHash = computeDecisionChainHash(record.prevDecisionHash, record.decisionHash);
    if (safeString(record.chainHash) !== expectedChainHash) {
      throw makeError("PHASE7_LEDGER_CHAIN_HASH_MISMATCH", "Ledger chain hash mismatch", {
        sequence: record.sequence,
        expectedChainHash,
        actualChainHash: safeString(record.chainHash)
      });
    }
    previousSequence = Number(record.sequence);
    lastChainHash = safeString(record.chainHash);
  }

  const chainHead = safeString(chainHeadInput);
  if (chainHead !== lastChainHash) {
    throw makeError("PHASE7_LEDGER_CHAIN_HEAD_MISMATCH", "Decision ledger chain head mismatch", {
      expectedChainHead: lastChainHash,
      actualChainHead: chainHead
    });
  }

  return {
    ok: true,
    count: records.length,
    chainHead: lastChainHash,
    records
  };
}

function verifyRolloutDecisionIntegrity(state) {
  const governance = state && state.experimentGovernance && typeof state.experimentGovernance === "object"
    ? state.experimentGovernance
    : null;
  if (!governance) {
    throw makeError("PHASE7_LEDGER_STATE_INVALID", "experimentGovernance block is required");
  }

  const decisions = asArray(governance.rolloutDecisions);
  const ledger = governance.decisionLedger && typeof governance.decisionLedger === "object"
    ? governance.decisionLedger
    : { records: [], chainHead: "", nextSequence: 0 };

  const expected = buildExpectedLedgerFromDecisions(decisions);
  const actual = verifyDecisionLedgerChain(asArray(ledger.records), safeString(ledger.chainHead));

  if (actual.count !== expected.records.length) {
    throw makeError("PHASE7_LEDGER_LENGTH_MISMATCH", "Decision ledger length does not match rollout decisions", {
      expected: expected.records.length,
      actual: actual.count
    });
  }

  for (let index = 0; index < expected.records.length; index += 1) {
    const expectedRecord = expected.records[index];
    const actualRecord = actual.records[index];
    if (
      Number(expectedRecord.sequence) !== Number(actualRecord.sequence)
      || Number(expectedRecord.decisionSequence) !== Number(actualRecord.decisionSequence)
      || safeString(expectedRecord.decisionHash) !== safeString(actualRecord.decisionHash)
      || safeString(expectedRecord.prevDecisionHash) !== safeString(actualRecord.prevDecisionHash)
      || safeString(expectedRecord.chainHash) !== safeString(actualRecord.chainHash)
    ) {
      throw makeError("PHASE7_LEDGER_RECORD_MISMATCH", "Decision ledger record differs from expected deterministic projection", {
        sequence: Number(expectedRecord.sequence)
      });
    }
  }

  const expectedNextSequence = expected.records.length;
  const actualNextSequence = Math.max(0, Number.parseInt(String(ledger.nextSequence ?? "0"), 10) || 0);
  if (actualNextSequence < expectedNextSequence) {
    throw makeError("PHASE7_LEDGER_NEXT_SEQUENCE_INVALID", "Decision ledger nextSequence is behind observed records", {
      expectedNextSequence,
      actualNextSequence
    });
  }

  return {
    ok: true,
    expected,
    actual,
    nextSequence: actualNextSequence
  };
}

function repairTruncatedLedgerTail(state) {
  const governance = state && state.experimentGovernance && typeof state.experimentGovernance === "object"
    ? state.experimentGovernance
    : null;
  if (!governance) {
    throw makeError("PHASE7_LEDGER_STATE_INVALID", "experimentGovernance block is required");
  }

  const decisions = asArray(governance.rolloutDecisions);
  const expected = buildExpectedLedgerFromDecisions(decisions);
  const actualRecords = asArray(governance.decisionLedger && governance.decisionLedger.records);

  if (actualRecords.length > expected.records.length) {
    throw makeError("PHASE7_LEDGER_REPAIR_NOT_TRUNCATED", "Ledger has extra records; truncated-tail repair is not allowed");
  }

  for (let index = 0; index < actualRecords.length; index += 1) {
    const actual = DecisionLedgerRecordSchema.parse(actualRecords[index]);
    const wanted = expected.records[index];
    if (
      Number(actual.sequence) !== Number(wanted.sequence)
      || Number(actual.decisionSequence) !== Number(wanted.decisionSequence)
      || safeString(actual.decisionHash) !== safeString(wanted.decisionHash)
      || safeString(actual.prevDecisionHash) !== safeString(wanted.prevDecisionHash)
      || safeString(actual.chainHash) !== safeString(wanted.chainHash)
    ) {
      throw makeError("PHASE7_LEDGER_REPAIR_NOT_TRUNCATED", "Ledger diverges before tail; truncated-tail repair is not allowed", {
        sequence: Number(wanted.sequence)
      });
    }
  }

  governance.decisionLedger = {
    records: expected.records,
    nextSequence: expected.nextSequence,
    chainHead: expected.chainHead
  };

  return {
    ok: true,
    repaired: true,
    restoredRecords: expected.records.length,
    chainHead: expected.chainHead
  };
}

module.exports = {
  verifyRolloutDecisionHashChain,
  buildExpectedLedgerFromDecisions,
  verifyDecisionLedgerChain,
  verifyRolloutDecisionIntegrity,
  repairTruncatedLedgerTail
};
