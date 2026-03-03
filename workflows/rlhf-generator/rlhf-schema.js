"use strict";

const crypto = require("node:crypto");
const { z } = require("zod");

const RLHF_DRAFT_STATUSES = Object.freeze([
  "draft",
  "reviewed",
  "approved_for_manual_submission",
  "archived"
]);

const RLHF_REVIEW_QUEUE_STATUSES = Object.freeze([
  "pending_review",
  "reviewed",
  "approved_for_manual_submission",
  "archived"
]);

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

function normalizeSourceHash(value) {
  return String(value || "").trim().toLowerCase();
}

const RlhfDraftRecordSchema = z.object({
  sequence: z.number().int().min(1),
  sourcePaperId: z.string().min(1).max(256),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  domainTag: z.string().min(1).max(128),
  complexityScore: z.number().int().min(0).max(100),
  monetizationScore: z.number().int().min(0).max(100),
  generatedAt: z.string().min(1).max(64),
  generatorVersion: z.string().min(1).max(32),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(RLHF_DRAFT_STATUSES),
  aiAssisted: z.literal(true),
  reviewedBy: z.string().min(1).max(128).nullable(),
  reviewedAt: z.string().min(1).max(64).nullable(),
  notes: z.string().max(2000),
  manualSubmissionRequired: z.literal(true)
}).strict();

const RlhfDraftRecordWithoutHashSchema = RlhfDraftRecordSchema.omit({ contentHash: true });

const RlhfCandidateQueueSchema = z.object({
  queueSequence: z.number().int().min(1),
  sourcePaperId: z.string().min(1).max(256),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  domainTag: z.string().min(1).max(128),
  complexityScore: z.number().int().min(0).max(100),
  monetizationScore: z.number().int().min(0).max(100),
  rankingScore: z.number().int().min(0).max(100),
  enqueuedAt: z.string().min(1).max(64),
  status: z.string().min(1).max(64),
  draftSequence: z.number().int().min(0).nullable()
}).strict();

const RlhfReviewQueueSchema = z.object({
  queueSequence: z.number().int().min(1),
  draftSequence: z.number().int().min(1),
  status: z.enum(RLHF_REVIEW_QUEUE_STATUSES),
  enqueuedAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  notes: z.string().max(2000)
}).strict();

function computeDraftContentHash(draftWithoutHash) {
  const parsed = RlhfDraftRecordWithoutHashSchema.parse(draftWithoutHash);
  return sha256(`rlhf-draft-v1|${canonicalStringify(parsed)}`);
}

function verifyDraftContentHash(draft) {
  const parsed = RlhfDraftRecordSchema.parse(draft);
  const expected = computeDraftContentHash({
    sequence: parsed.sequence,
    sourcePaperId: parsed.sourcePaperId,
    sourceHash: parsed.sourceHash,
    domainTag: parsed.domainTag,
    complexityScore: parsed.complexityScore,
    monetizationScore: parsed.monetizationScore,
    generatedAt: parsed.generatedAt,
    generatorVersion: parsed.generatorVersion,
    status: parsed.status,
    aiAssisted: parsed.aiAssisted,
    reviewedBy: parsed.reviewedBy,
    reviewedAt: parsed.reviewedAt,
    notes: parsed.notes,
    manualSubmissionRequired: parsed.manualSubmissionRequired
  });
  if (parsed.contentHash !== expected) {
    const error = new Error("RLHF draft content hash mismatch");
    error.code = "RLHF_DRAFT_HASH_MISMATCH";
    error.details = {
      sequence: parsed.sequence,
      expected,
      actual: parsed.contentHash
    };
    throw error;
  }
  return true;
}

function sourceKeyFromPaper(sourcePaperId, sourceHash) {
  return `${String(sourcePaperId || "").trim()}|${normalizeSourceHash(sourceHash)}`;
}

module.exports = {
  RLHF_DRAFT_STATUSES,
  RLHF_REVIEW_QUEUE_STATUSES,
  RlhfDraftRecordSchema,
  RlhfDraftRecordWithoutHashSchema,
  RlhfCandidateQueueSchema,
  RlhfReviewQueueSchema,
  canonicalize,
  canonicalStringify,
  computeDraftContentHash,
  verifyDraftContentHash,
  sourceKeyFromPaper,
  normalizeSourceHash
};
