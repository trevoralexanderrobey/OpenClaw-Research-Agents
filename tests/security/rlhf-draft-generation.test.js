"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDraftFromCandidate } = require("../../workflows/rlhf-generator/rlhf-generator.js");
const { formatDraftMarkdown } = require("../../workflows/rlhf-generator/formatting-engine.js");

function fixedTimeProvider() {
  return {
    nowIso() {
      return "2026-03-03T00:00:00.000Z";
    },
    nowMs() {
      return 1772496000000;
    }
  };
}

function candidateFixture() {
  return {
    sourcePaperId: "paper-123",
    sourceHash: "a".repeat(64),
    domainTag: "security",
    complexityScore: 73,
    monetizationScore: 61,
    sourceTitle: "Deterministic security analysis for RLHF quality control",
    sourceAbstract: "A deterministic method for safety-preserving rubric construction.",
    sourceAuthors: ["Alice", "Bob"],
    sourcePublishedAt: "2025-01-01T00:00:00.000Z",
    sourceRetrievedAt: "2026-03-03T00:00:00.000Z"
  };
}

test("draft generation is byte-identical for identical input", () => {
  const payloadA = buildDraftFromCandidate(candidateFixture(), {
    timeProvider: fixedTimeProvider(),
    generatorVersion: "v1"
  });
  const payloadB = buildDraftFromCandidate(candidateFixture(), {
    timeProvider: fixedTimeProvider(),
    generatorVersion: "v1"
  });

  const markdownA = formatDraftMarkdown(payloadA, { templateVersion: "v1" });
  const markdownB = formatDraftMarkdown(payloadB, { templateVersion: "v1" });

  assert.equal(markdownA, markdownB);
});

test("draft includes required AI-assisted disclosure header", () => {
  const payload = buildDraftFromCandidate(candidateFixture(), {
    timeProvider: fixedTimeProvider(),
    generatorVersion: "v1"
  });

  const markdown = formatDraftMarkdown(payload, { templateVersion: "v1" });
  assert.match(markdown, /AI-Assisted RLHF Draft/i);
  assert.match(markdown, /requires human editorial review/i);
});
