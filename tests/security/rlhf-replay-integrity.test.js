"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDraftContentHash,
  verifyDraftContentHash
} = require("../../workflows/rlhf-generator/rlhf-schema.js");

function draftWithoutHash() {
  return {
    sequence: 1,
    sourcePaperId: "paper-replay",
    sourceHash: "a".repeat(64),
    domainTag: "security",
    complexityScore: 64,
    monetizationScore: 44,
    generatedAt: "2026-03-03T00:00:00.000Z",
    generatorVersion: "v1",
    status: "draft",
    aiAssisted: true,
    reviewedBy: null,
    reviewedAt: null,
    notes: "",
    manualSubmissionRequired: true
  };
}

test("draft content hash remains stable across repeated runs", () => {
  const first = computeDraftContentHash(draftWithoutHash());
  const second = computeDraftContentHash(draftWithoutHash());
  assert.equal(first, second);
});

test("replay integrity rejects tampered draft content hash", () => {
  const draft = draftWithoutHash();
  const record = {
    ...draft,
    contentHash: computeDraftContentHash(draft)
  };

  verifyDraftContentHash(record);

  const tampered = {
    ...record,
    notes: "tampered"
  };

  assert.throws(() => verifyDraftContentHash(tampered), (error) => error && error.code === "RLHF_DRAFT_HASH_MISMATCH");
});
