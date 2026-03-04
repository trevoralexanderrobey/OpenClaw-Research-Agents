"use strict";

const {
  CHAIN_ZERO_HASH,
  OutcomeRecordSchema,
  canonicalStringify,
  normalizeOutcomeInput,
  verifyOutcomeRecord,
  makeError
} = require("./outcome-schema.js");

function parseNdjson(raw, options = {}) {
  const lines = String(raw || "").split("\n");
  const records = [];
  const nonEmpty = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().length > 0) {
      nonEmpty.push(index);
    }
  }
  const lastNonEmpty = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1] : -1;
  const allowRecoverTrailingLine = Boolean(options.allowRecoverTrailingLine);
  let recoveredTrailingLine = false;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      if (allowRecoverTrailingLine && index === lastNonEmpty) {
        recoveredTrailingLine = true;
        break;
      }
      throw makeError("RLHF_OUTCOME_ARTIFACT_CORRUPTED", `Invalid outcome NDJSON at line ${index + 1}`, {
        line: index + 1
      });
    }
  }

  return { records, recoveredTrailingLine };
}

function idempotencyFingerprint(input = {}) {
  return canonicalStringify(normalizeOutcomeInput(input));
}

function assertIdempotencyReplay(existingRecord, input = {}) {
  const existing = OutcomeRecordSchema.parse(existingRecord);
  const expected = idempotencyFingerprint(input);
  const existingComparable = idempotencyFingerprint({
    draftSequence: existing.draftSequence,
    idempotencyKey: existing.idempotencyKey,
    manualSubmissionConfirmed: existing.manualSubmissionConfirmed,
    result: existing.result,
    score: existing.score,
    feedbackTags: existing.feedbackTags,
    notes: existing.notes,
    evidenceHash: existing.evidenceHash
  });
  if (expected !== existingComparable) {
    throw makeError("RLHF_OUTCOME_IDEMPOTENCY_CONFLICT", "Idempotency key reused with divergent payload", {
      idempotencyKey: existing.idempotencyKey
    });
  }
  return true;
}

function verifyOutcomeChain(records) {
  const list = Array.isArray(records) ? records : [];
  let prevChainHash = CHAIN_ZERO_HASH;
  let maxSequence = 0;

  for (const [index, record] of list.entries()) {
    const parsed = OutcomeRecordSchema.parse(record);
    verifyOutcomeRecord(parsed);
    if (parsed.sequence <= maxSequence) {
      throw makeError("RLHF_OUTCOME_SEQUENCE_INVALID", "Outcome sequence must be strictly increasing", {
        index,
        sequence: parsed.sequence,
        previous: maxSequence
      });
    }
    if (parsed.prevChainHash !== prevChainHash) {
      throw makeError("RLHF_OUTCOME_CHAIN_CONTINUITY_INVALID", "Outcome chain continuity mismatch", {
        index,
        expectedPrevChainHash: prevChainHash,
        actualPrevChainHash: parsed.prevChainHash
      });
    }
    prevChainHash = parsed.chainHash;
    maxSequence = parsed.sequence;
  }

  return {
    ok: true,
    headHash: prevChainHash,
    headSequence: maxSequence,
    count: list.length
  };
}

function verifyStateChainAnchor(records, stateAnchor = {}) {
  const chain = verifyOutcomeChain(records);
  const anchorHash = typeof stateAnchor.chainHeadHash === "string" ? stateAnchor.chainHeadHash.trim().toLowerCase() : CHAIN_ZERO_HASH;
  const anchorSequence = Number.parseInt(String(stateAnchor.chainHeadSequence ?? "0"), 10) || 0;
  if (chain.headHash !== anchorHash || chain.headSequence !== anchorSequence) {
    throw makeError("RLHF_OUTCOME_CHAIN_ANCHOR_MISMATCH", "State chain anchor does not match outcome artifact chain head", {
      expectedHash: chain.headHash,
      actualHash: anchorHash,
      expectedSequence: chain.headSequence,
      actualSequence: anchorSequence
    });
  }
  return chain;
}

module.exports = {
  parseNdjson,
  idempotencyFingerprint,
  assertIdempotencyReplay,
  verifyOutcomeChain,
  verifyStateChainAnchor
};
