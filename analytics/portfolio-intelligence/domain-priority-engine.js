"use strict";

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!isObject(value)) {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeWeights(weights) {
  const fallback = { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 };
  if (!weights || typeof weights !== "object") {
    return fallback;
  }
  const complexity = Number(weights.complexity);
  const monetization = Number(weights.monetization);
  const qualitySignal = Number(weights.qualitySignal);
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

function complexityBand(value) {
  const score = Number(value || 0);
  if (score >= 67) return "high";
  if (score >= 34) return "medium";
  return "low";
}

function rankDomainPriorities(input = {}) {
  const templateRegistry = input.templateRegistry && typeof input.templateRegistry === "object"
    ? input.templateRegistry
    : { records: [] };
  const qualitySignals = input.qualitySignals && typeof input.qualitySignals === "object"
    ? input.qualitySignals
    : { perDraft: [] };
  const calibrationWeights = normalizeWeights(input.calibrationWeights);

  const domainAcc = new Map();
  for (const draft of toArray(qualitySignals.perDraft)) {
    const domainTag = typeof draft.domainTag === "string" && draft.domainTag.trim() ? draft.domainTag.trim() : "general-research";
    const next = domainAcc.get(domainTag) || {
      domainTag,
      draftCount: 0,
      complexityTotal: 0,
      monetizationTotal: 0,
      qualitySignalTotal: 0,
      pendingCount: 0
    };
    next.draftCount += 1;
    next.complexityTotal += Number(draft.complexityScore || 0);
    next.monetizationTotal += Number(draft.monetizationScore || 0);
    next.qualitySignalTotal += Number(draft.qualitySignal || 0);
    if (draft.result === "pending") {
      next.pendingCount += 1;
    }
    domainAcc.set(domainTag, next);
  }

  for (const record of toArray(templateRegistry.records)) {
    const domainTag = typeof record.domainTag === "string" && record.domainTag.trim() ? record.domainTag.trim() : "general-research";
    if (!domainAcc.has(domainTag)) {
      domainAcc.set(domainTag, {
        domainTag,
        draftCount: 0,
        complexityTotal: 0,
        monetizationTotal: 0,
        qualitySignalTotal: 0,
        pendingCount: Number(record.pendingCount || 0)
      });
      continue;
    }
    const next = domainAcc.get(domainTag);
    next.pendingCount += Number(record.pendingCount || 0);
    domainAcc.set(domainTag, next);
  }

  const ranked = [...domainAcc.values()]
    .map((item) => {
      const draftCount = item.draftCount;
      const averageComplexity = draftCount === 0 ? 0 : Math.floor(item.complexityTotal / draftCount);
      const averageMonetization = draftCount === 0 ? 0 : Math.floor(item.monetizationTotal / draftCount);
      const averageQualitySignal = draftCount === 0 ? 0 : Math.floor(item.qualitySignalTotal / draftCount);
      const priorityScore = Math.floor(
        (averageComplexity * calibrationWeights.complexity)
        + (averageMonetization * calibrationWeights.monetization)
        + (averageQualitySignal * calibrationWeights.qualitySignal)
      );
      return canonicalize({
        domainTag: item.domainTag,
        draftCount,
        pendingCount: item.pendingCount,
        averageComplexity,
        averageMonetization,
        averageQualitySignal,
        complexityBand: complexityBand(averageComplexity),
        expectedValueScore: Math.max(0, Math.min(100, priorityScore)),
        recommendedReviewSlots: Math.max(1, Math.min(20, 1 + item.pendingCount))
      });
    })
    .sort((left, right) => {
      const byScore = Number(right.expectedValueScore || 0) - Number(left.expectedValueScore || 0);
      if (byScore !== 0) return byScore;
      return left.domainTag.localeCompare(right.domainTag);
    })
    .map((entry, index) => ({
      ...entry,
      priorityRank: index + 1
    }));

  return canonicalize({
    ok: true,
    domains: ranked
  });
}

module.exports = {
  rankDomainPriorities
};
