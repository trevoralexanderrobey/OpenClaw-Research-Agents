"use strict";

const {
  sourceKeyFromPaper,
  normalizeSourceHash,
} = require("./rlhf-schema.js");
const {
  classifyDomainTag,
  computeComplexityScore,
  computeMonetizationScore
} = require("./complexity-analyzer.js");

function normalizeList(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function toSourcePaperId(record = {}) {
  return String(record.paper_id || "").trim();
}

function toSourceHash(record = {}) {
  return normalizeSourceHash(record.hash);
}

function normalizeCalibrationWeights(value) {
  const fallback = { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 };
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const complexity = Number(value.complexity);
  const monetization = Number(value.monetization);
  const qualitySignal = Number(value.qualitySignal);
  const sum = complexity + monetization + qualitySignal;
  if (
    !Number.isFinite(complexity) || !Number.isFinite(monetization) || !Number.isFinite(qualitySignal)
    || complexity < 0 || monetization < 0 || qualitySignal < 0
    || Math.abs(sum - 1) > 0.000001
  ) {
    return fallback;
  }
  return { complexity, monetization, qualitySignal };
}

function rankingScoreForCandidate(candidate, input = {}) {
  const complexity = Number(candidate.complexityScore || 0);
  const monetization = Number(candidate.monetizationScore || 0);
  const weights = normalizeCalibrationWeights(input.calibrationWeights);
  const qualityPriorByDomain = input.qualityPriorByDomain && typeof input.qualityPriorByDomain === "object"
    ? input.qualityPriorByDomain
    : {};
  const domainTag = String(candidate.domainTag || "");
  const qualityPrior = Number.isFinite(Number(qualityPriorByDomain[domainTag]))
    ? Math.max(0, Math.min(100, Math.floor(Number(qualityPriorByDomain[domainTag]))))
    : 0;

  const score = Math.floor(
    (complexity * weights.complexity)
    + (monetization * weights.monetization)
    + (qualityPrior * weights.qualitySignal)
  );
  return Math.max(0, Math.min(100, score));
}

function byDeterministicOrder(left, right) {
  const fields = [
    [right.rankingScore, left.rankingScore],
    [right.complexityScore, left.complexityScore],
    [right.monetizationScore, left.monetizationScore]
  ];

  for (const [a, b] of fields) {
    const delta = Number(a) - Number(b);
    if (delta !== 0) {
      return delta;
    }
  }

  const tieBreakers = [
    [left.sourcePaperId, right.sourcePaperId],
    [left.sourceHash, right.sourceHash],
    [Number(left.sourceSequence || 0), Number(right.sourceSequence || 0)]
  ];

  for (const [a, b] of tieBreakers) {
    if (typeof a === "number" && typeof b === "number") {
      if (a !== b) return a - b;
      continue;
    }
    const aa = String(a || "");
    const bb = String(b || "");
    if (aa < bb) return -1;
    if (aa > bb) return 1;
  }

  return 0;
}

function selectCandidates(input = {}) {
  const records = Array.isArray(input.records) ? input.records : [];
  const existingDrafts = Array.isArray(input.existingDrafts) ? input.existingDrafts : [];
  const domainAllowlist = normalizeList(input.domainAllowlist);
  const monetizationSnapshot = input.monetizationSnapshot && typeof input.monetizationSnapshot === "object"
    ? input.monetizationSnapshot
    : {};
  const calibrationWeights = normalizeCalibrationWeights(input.calibrationWeights);
  const qualityPriorByDomain = input.qualityPriorByDomain && typeof input.qualityPriorByDomain === "object"
    ? input.qualityPriorByDomain
    : {};
  const limit = Number.isFinite(Number(input.limit))
    ? Math.max(1, Math.min(200, Math.floor(Number(input.limit))))
    : 20;

  const draftedSourceKeys = new Set(
    existingDrafts.map((draft) => sourceKeyFromPaper(draft.sourcePaperId, draft.sourceHash))
  );
  const seen = new Set();
  const candidates = [];

  for (const record of records) {
    const sourcePaperId = toSourcePaperId(record);
    const sourceHash = toSourceHash(record);
    if (!sourcePaperId || !/^[a-f0-9]{64}$/.test(sourceHash)) {
      continue;
    }

    const domainTag = classifyDomainTag(record);
    if (domainAllowlist.length > 0 && !domainAllowlist.includes(domainTag)) {
      continue;
    }

    const sourceKey = sourceKeyFromPaper(sourcePaperId, sourceHash);
    if (seen.has(sourceKey) || draftedSourceKeys.has(sourceKey)) {
      continue;
    }
    seen.add(sourceKey);

    const complexityScore = computeComplexityScore(record);
    const monetizationScore = computeMonetizationScore(record, monetizationSnapshot);

    const candidate = {
      sourcePaperId,
      sourceHash,
      sourceSequence: Number(record.sequence || 0),
      sourceTitle: String(record.title || "").trim(),
      sourceAbstract: String(record.abstract || "").trim(),
      sourceAuthors: Array.isArray(record.authors) ? record.authors.slice() : [],
      sourcePublishedAt: String(record.published_at || "").trim(),
      sourceRetrievedAt: String(record.retrieved_at || "").trim(),
      domainTag,
      complexityScore,
      monetizationScore,
      rankingScore: 0
    };
    candidate.rankingScore = rankingScoreForCandidate(candidate, {
      calibrationWeights,
      qualityPriorByDomain
    });
    candidates.push(candidate);
  }

  return candidates
    .sort(byDeterministicOrder)
    .slice(0, limit)
    .map((candidate) => ({ ...candidate }));
}

module.exports = {
  selectCandidates,
  rankingScoreFor: rankingScoreForCandidate,
  byDeterministicOrder
};
