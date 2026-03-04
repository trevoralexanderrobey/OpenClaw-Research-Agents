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

function latestOutcomeByDraft(outcomes) {
  const map = new Map();
  for (const outcome of toArray(outcomes)) {
    const draftSequence = Number(outcome && outcome.draftSequence ? outcome.draftSequence : 0);
    if (draftSequence <= 0) {
      continue;
    }
    const current = map.get(draftSequence);
    if (!current || Number(outcome.sequence || 0) > Number(current.sequence || 0)) {
      map.set(draftSequence, outcome);
    }
  }
  return map;
}

function buildTemplatePerformanceRegistry(input = {}) {
  const drafts = toArray(input.drafts)
    .slice()
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  const outcomes = latestOutcomeByDraft(toArray(input.outcomes));
  const qualityByDraft = new Map(
    toArray(input.qualitySnapshot && input.qualitySnapshot.perDraft)
      .map((entry) => [Number(entry.draftSequence || 0), entry])
  );

  const registry = new Map();
  for (const draft of drafts) {
    const generatorVersion = typeof draft.generatorVersion === "string" && draft.generatorVersion.trim()
      ? draft.generatorVersion.trim()
      : "v1";
    const templateVersion = typeof draft.templateVersion === "string" && draft.templateVersion.trim()
      ? draft.templateVersion.trim()
      : "v1";
    const domainTag = typeof draft.domainTag === "string" && draft.domainTag.trim()
      ? draft.domainTag.trim()
      : "general-research";
    const key = `${generatorVersion}|${templateVersion}|${domainTag}`;
    const next = registry.get(key) || {
      generatorVersion,
      templateVersion,
      domainTag,
      draftCount: 0,
      finalizedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      reviseRequestedCount: 0,
      pendingCount: 0,
      qualitySignalTotal: 0
    };

    next.draftCount += 1;
    const outcome = outcomes.get(Number(draft.sequence || 0)) || null;
    const result = outcome && typeof outcome.result === "string" ? outcome.result.trim() : "pending";
    if (result === "pending") {
      next.pendingCount += 1;
    } else {
      next.finalizedCount += 1;
    }
    if (result === "accepted") next.acceptedCount += 1;
    if (result === "rejected") next.rejectedCount += 1;
    if (result === "revise_requested") next.reviseRequestedCount += 1;

    const quality = qualityByDraft.get(Number(draft.sequence || 0));
    next.qualitySignalTotal += Number(quality && quality.qualitySignal ? quality.qualitySignal : 0);
    registry.set(key, next);
  }

  const records = [...registry.values()]
    .map((item) => canonicalize({
      generatorVersion: item.generatorVersion,
      templateVersion: item.templateVersion,
      domainTag: item.domainTag,
      draftCount: item.draftCount,
      finalizedCount: item.finalizedCount,
      acceptedCount: item.acceptedCount,
      rejectedCount: item.rejectedCount,
      reviseRequestedCount: item.reviseRequestedCount,
      pendingCount: item.pendingCount,
      averageQualitySignal: item.draftCount === 0 ? 0 : Math.floor(item.qualitySignalTotal / item.draftCount),
      acceptanceRatePct: item.finalizedCount === 0 ? 0 : Math.floor((item.acceptedCount * 100) / item.finalizedCount)
    }))
    .sort((left, right) => {
      const byGenerator = left.generatorVersion.localeCompare(right.generatorVersion);
      if (byGenerator !== 0) return byGenerator;
      const byTemplate = left.templateVersion.localeCompare(right.templateVersion);
      if (byTemplate !== 0) return byTemplate;
      return left.domainTag.localeCompare(right.domainTag);
    });

  return {
    ok: true,
    records
  };
}

module.exports = {
  buildTemplatePerformanceRegistry,
  canonicalize
};
