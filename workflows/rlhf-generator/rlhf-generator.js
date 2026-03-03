"use strict";

const { buildRubric } = require("./rubric-builder.js");

function compactText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!maxChars || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function buildTargetPrompt(candidate) {
  return [
    "You are preparing a high-quality RLHF answer draft.",
    `Domain: ${candidate.domainTag}.`,
    `Source title: ${candidate.sourceTitle || "Untitled"}.`,
    "Produce a concise response that is accurate, policy-safe, and explicit about assumptions.",
    "Do not include any autonomous submission or platform login instructions."
  ].join(" ");
}

function buildGoldenResponse(candidate) {
  const abstract = compactText(candidate.sourceAbstract, 700);
  return [
    `This AI-assisted draft summarizes '${candidate.sourceTitle || "the source paper"}' for human review.`,
    `Key context: ${abstract || "No abstract was provided in the normalized record."}`,
    "The response emphasizes deterministic reasoning, clear constraints, and reviewability.",
    "Final publication or submission decisions remain manual and operator-controlled."
  ].join(" ");
}

function buildReviewerChecklist(candidate) {
  return [
    "Confirm target prompt accurately reflects source scope.",
    "Validate the golden response for factual consistency.",
    `Check domain framing (${candidate.domainTag}) for correctness and relevance.`,
    "Verify the draft includes AI-assistance and human-review-required disclosure.",
    "Confirm no autonomous submission, credential handling, or evasion language exists."
  ];
}

function buildDraftFromCandidate(candidate = {}, options = {}) {
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const generatorVersion = typeof options.generatorVersion === "string" && options.generatorVersion.trim()
    ? options.generatorVersion.trim()
    : "v1";

  const draftPayload = {
    sourcePaperId: String(candidate.sourcePaperId || "").trim(),
    sourceHash: String(candidate.sourceHash || "").trim().toLowerCase(),
    domainTag: String(candidate.domainTag || "general-research").trim(),
    complexityScore: Number.isFinite(Number(candidate.complexityScore))
      ? Math.max(0, Math.min(100, Math.floor(Number(candidate.complexityScore))))
      : 0,
    monetizationScore: Number.isFinite(Number(candidate.monetizationScore))
      ? Math.max(0, Math.min(100, Math.floor(Number(candidate.monetizationScore))))
      : 0,
    generatedAt: String(timeProvider.nowIso()),
    generatorVersion,
    targetPrompt: buildTargetPrompt(candidate),
    goldenResponse: buildGoldenResponse(candidate),
    reviewerChecklist: buildReviewerChecklist(candidate),
    sourceTitle: String(candidate.sourceTitle || "").trim(),
    sourcePublishedAt: String(candidate.sourcePublishedAt || "").trim(),
    sourceRetrievedAt: String(candidate.sourceRetrievedAt || "").trim(),
    sourceAuthors: Array.isArray(candidate.sourceAuthors) ? candidate.sourceAuthors.slice() : []
  };

  return {
    ...draftPayload,
    rubric: buildRubric(candidate)
  };
}

module.exports = {
  buildDraftFromCandidate
};
