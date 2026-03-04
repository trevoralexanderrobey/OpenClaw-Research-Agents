"use strict";

const crypto = require("node:crypto");
const { z } = require("zod");

const OUTCOME_VERSION = "v1";
const OUTCOME_HASH_PREFIX = "rlhf-outcome-v1|";
const CHAIN_ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const OUTCOME_RESULTS = Object.freeze(["accepted", "rejected", "revise_requested", "pending"]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function makeError(code, message, details) {
  const error = new Error(String(message || "Outcome validation error"));
  error.code = String(code || "RLHF_OUTCOME_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

const OutcomeRecordWithoutHashesSchema = z.object({
  sequence: z.number().int().min(1),
  draftSequence: z.number().int().min(1),
  idempotencyKey: z.string().min(1).max(256),
  enteredAt: z.string().min(1).max(64),
  enteredBy: z.string().min(1).max(128),
  aiAssisted: z.literal(true),
  manualSubmissionConfirmed: z.boolean(),
  result: z.enum(OUTCOME_RESULTS),
  score: z.number().int().min(0).max(100),
  feedbackTags: z.array(z.string().min(1).max(128)).max(128),
  notes: z.string().max(8000),
  evidenceHash: z.string().regex(/^$|^[a-f0-9]{64}$/),
  outcomeVersion: z.literal(OUTCOME_VERSION)
}).strict();

const OutcomeRecordSchema = OutcomeRecordWithoutHashesSchema.extend({
  outcomeHash: z.string().regex(/^[a-f0-9]{64}$/),
  prevChainHash: z.string().regex(/^[a-f0-9]{64}$/),
  chainHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

function normalizeFeedbackTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const deduped = new Set(
    list
      .map((tag) => String(tag || "").trim())
      .filter(Boolean)
  );
  return [...deduped].sort((left, right) => left.localeCompare(right));
}

function assertOutcomeSemantics(record) {
  const source = OutcomeRecordWithoutHashesSchema.parse({
    sequence: record && record.sequence,
    draftSequence: record && record.draftSequence,
    idempotencyKey: record && record.idempotencyKey,
    enteredAt: record && record.enteredAt,
    enteredBy: record && record.enteredBy,
    aiAssisted: record && record.aiAssisted,
    manualSubmissionConfirmed: record && record.manualSubmissionConfirmed,
    result: record && record.result,
    score: record && record.score,
    feedbackTags: record && record.feedbackTags,
    notes: record && record.notes,
    evidenceHash: record && record.evidenceHash,
    outcomeVersion: record && record.outcomeVersion
  });
  if (source.result === "pending") {
    if (source.score !== 0) {
      throw makeError("RLHF_OUTCOME_PENDING_SCORE_INVALID", "Pending outcomes must use score=0");
    }
    return true;
  }
  if (source.manualSubmissionConfirmed !== true) {
    throw makeError(
      "RLHF_OUTCOME_MANUAL_CONFIRMATION_REQUIRED",
      "Finalized outcomes require manualSubmissionConfirmed=true"
    );
  }
  if (!Number.isInteger(source.score) || source.score < 0 || source.score > 100) {
    throw makeError("RLHF_OUTCOME_SCORE_INVALID", "Finalized outcomes require score in range 0..100");
  }
  return true;
}

function computeOutcomeHash(outcomeWithoutHashes) {
  const parsed = OutcomeRecordWithoutHashesSchema.parse(outcomeWithoutHashes);
  assertOutcomeSemantics(parsed);
  return sha256(`${OUTCOME_HASH_PREFIX}${canonicalStringify(parsed)}`);
}

function computeOutcomeChainHash(prevChainHash, outcomeHash) {
  const prev = /^[a-f0-9]{64}$/.test(String(prevChainHash || "")) ? String(prevChainHash) : CHAIN_ZERO_HASH;
  const current = /^[a-f0-9]{64}$/.test(String(outcomeHash || "")) ? String(outcomeHash) : null;
  if (!current) {
    throw makeError("RLHF_OUTCOME_HASH_INVALID", "outcomeHash must be a valid sha256 digest");
  }
  return sha256(`${prev}|${current}`);
}

function attachOutcomeHashes(outcomeWithoutHashes, prevChainHash = CHAIN_ZERO_HASH) {
  const parsed = OutcomeRecordWithoutHashesSchema.parse(outcomeWithoutHashes);
  assertOutcomeSemantics(parsed);
  const outcomeHash = computeOutcomeHash(parsed);
  const prev = /^[a-f0-9]{64}$/.test(String(prevChainHash || "")) ? String(prevChainHash) : CHAIN_ZERO_HASH;
  const chainHash = computeOutcomeChainHash(prev, outcomeHash);
  return OutcomeRecordSchema.parse({
    ...parsed,
    outcomeHash,
    prevChainHash: prev,
    chainHash
  });
}

function verifyOutcomeRecord(record) {
  const parsed = OutcomeRecordSchema.parse(record);
  assertOutcomeSemantics(parsed);
  const expectedOutcomeHash = computeOutcomeHash({
    sequence: parsed.sequence,
    draftSequence: parsed.draftSequence,
    idempotencyKey: parsed.idempotencyKey,
    enteredAt: parsed.enteredAt,
    enteredBy: parsed.enteredBy,
    aiAssisted: parsed.aiAssisted,
    manualSubmissionConfirmed: parsed.manualSubmissionConfirmed,
    result: parsed.result,
    score: parsed.score,
    feedbackTags: parsed.feedbackTags,
    notes: parsed.notes,
    evidenceHash: parsed.evidenceHash,
    outcomeVersion: parsed.outcomeVersion
  });
  if (expectedOutcomeHash !== parsed.outcomeHash) {
    throw makeError("RLHF_OUTCOME_HASH_MISMATCH", "Outcome hash mismatch", {
      expected: expectedOutcomeHash,
      actual: parsed.outcomeHash,
      sequence: parsed.sequence
    });
  }
  const expectedChainHash = computeOutcomeChainHash(parsed.prevChainHash, parsed.outcomeHash);
  if (expectedChainHash !== parsed.chainHash) {
    throw makeError("RLHF_OUTCOME_CHAIN_HASH_MISMATCH", "Outcome chain hash mismatch", {
      expected: expectedChainHash,
      actual: parsed.chainHash,
      sequence: parsed.sequence
    });
  }
  return true;
}

function normalizeOutcomeInput(input = {}) {
  const result = OUTCOME_RESULTS.includes(String(input.result || "").trim())
    ? String(input.result).trim()
    : "pending";
  const scoreRaw = Number.parseInt(String(input.score ?? "0"), 10);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, scoreRaw)) : 0;
  return canonicalize({
    draftSequence: Math.max(1, Number.parseInt(String(input.draftSequence || "0"), 10) || 1),
    idempotencyKey: String(input.idempotencyKey || "").trim(),
    manualSubmissionConfirmed: Boolean(input.manualSubmissionConfirmed),
    result,
    score: result === "pending" ? 0 : score,
    feedbackTags: normalizeFeedbackTags(input.feedbackTags),
    notes: typeof input.notes === "string" ? input.notes : "",
    evidenceHash: String(input.evidenceHash || "").trim().toLowerCase()
  });
}

module.exports = {
  OUTCOME_VERSION,
  OUTCOME_HASH_PREFIX,
  CHAIN_ZERO_HASH,
  OUTCOME_RESULTS,
  OutcomeRecordSchema,
  OutcomeRecordWithoutHashesSchema,
  canonicalize,
  canonicalStringify,
  normalizeFeedbackTags,
  normalizeOutcomeInput,
  assertOutcomeSemantics,
  computeOutcomeHash,
  computeOutcomeChainHash,
  attachOutcomeHashes,
  verifyOutcomeRecord,
  makeError
};
