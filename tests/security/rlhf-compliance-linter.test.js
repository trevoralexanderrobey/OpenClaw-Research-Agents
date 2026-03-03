"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { lintDraft } = require("../../workflows/rlhf-generator/compliance-linter.js");
const { buildDraftFromCandidate } = require("../../workflows/rlhf-generator/rlhf-generator.js");
const { formatDraftMarkdown } = require("../../workflows/rlhf-generator/formatting-engine.js");

function buildPayload() {
  return buildDraftFromCandidate({
    sourcePaperId: "paper-xyz",
    sourceHash: "b".repeat(64),
    domainTag: "machine-learning",
    complexityScore: 67,
    monetizationScore: 52,
    sourceTitle: "Safe RLHF alignment evaluation",
    sourceAbstract: "A study of deterministic RLHF evaluation constraints.",
    sourceAuthors: ["Alice"],
    sourcePublishedAt: "2025-01-01T00:00:00.000Z",
    sourceRetrievedAt: "2026-03-03T00:00:00.000Z"
  }, {
    timeProvider: {
      nowIso() {
        return "2026-03-03T00:00:00.000Z";
      }
    },
    generatorVersion: "v1"
  });
}

function draftRecordFixture() {
  return {
    sequence: 1,
    sourcePaperId: "paper-xyz",
    sourceHash: "b".repeat(64),
    domainTag: "machine-learning",
    complexityScore: 67,
    monetizationScore: 52,
    generatedAt: "2026-03-03T00:00:00.000Z",
    generatorVersion: "v1",
    contentHash: "c".repeat(64),
    status: "draft",
    aiAssisted: true,
    reviewedBy: null,
    reviewedAt: null,
    notes: "",
    manualSubmissionRequired: true
  };
}

test("linter rejects forbidden concealment/evasion phrases", () => {
  const payload = buildPayload();
  const markdown = `${formatDraftMarkdown(payload, { templateVersion: "v1" })}\nDo this to evade detection.`;
  const result = lintDraft({
    markdown,
    payload,
    draftRecord: draftRecordFixture(),
    templateVersion: "v1"
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "RLHF_LINT_FORBIDDEN_LANGUAGE"), true);
});

test("linter rejects missing required sections", () => {
  const payload = buildPayload();
  const markdown = "# AI-Assisted RLHF Draft (Human Review Required)\n\nOnly a header exists.\n";
  const result = lintDraft({
    markdown,
    payload,
    draftRecord: draftRecordFixture(),
    templateVersion: "v1"
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "RLHF_LINT_MISSING_REQUIRED_SECTION"), true);
});
