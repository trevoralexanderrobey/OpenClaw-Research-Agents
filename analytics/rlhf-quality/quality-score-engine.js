"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const {
  DraftQualityRecordSchema,
  DomainQualityRecordSchema,
  TemplateQualityRecordSchema,
  QualitySnapshotSchema,
  canonicalize
} = require("./quality-schema.js");
const {
  clampInt,
  latestOutcomeMap,
  computeDraftQualitySignal
} = require("./quality-signals.js");

function ensureDependencies(apiGovernance) {
  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    const error = new Error("apiGovernance.readState is required");
    error.code = "RLHF_QUALITY_CONFIG_INVALID";
    throw error;
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function createQualityScoreEngine(options = {}) {
  const apiGovernance = options.apiGovernance;
  const monetizationEngine = options.monetizationEngine;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  ensureDependencies(apiGovernance);

  async function computeQualitySnapshot(input = {}) {
    const asOfIso = typeof input.asOfIso === "string" && input.asOfIso.trim()
      ? input.asOfIso.trim()
      : String(timeProvider.nowIso());

    const state = await apiGovernance.readState();
    const drafts = toArray(state && state.rlhfWorkflows && state.rlhfWorkflows.drafts)
      .slice()
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    const outcomes = toArray(state && state.rlhfOutcomes && state.rlhfOutcomes.records)
      .slice()
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    const latestByDraft = latestOutcomeMap(outcomes);

    const monetizationSnapshot = monetizationEngine && typeof monetizationEngine.computeMonetizationScore === "function"
      ? await monetizationEngine.computeMonetizationScore({})
      : { score: 0 };
    const monetizationSnapshotScore = clampInt(monetizationSnapshot && monetizationSnapshot.score ? monetizationSnapshot.score : 0, 0, 100);

    const perDraft = drafts.map((draft) => {
      const signal = computeDraftQualitySignal({
        draft,
        outcome: latestByDraft.get(Number(draft.sequence || 0)) || null
      });

      return DraftQualityRecordSchema.parse({
        draftSequence: Number(draft.sequence || 0),
        domainTag: typeof draft.domainTag === "string" && draft.domainTag.trim() ? draft.domainTag.trim() : "general-research",
        generatorVersion: typeof draft.generatorVersion === "string" && draft.generatorVersion.trim() ? draft.generatorVersion.trim() : "v1",
        templateVersion: typeof draft.templateVersion === "string" && draft.templateVersion.trim() ? draft.templateVersion.trim() : "v1",
        result: signal.result,
        score: signal.score,
        qualitySignal: signal.qualitySignal,
        complexityScore: clampInt(draft.complexityScore, 0, 100),
        monetizationScore: clampInt(draft.monetizationScore, 0, 100),
        outcomeSequence: signal.outcomeSequence
      });
    });

    const domainAcc = new Map();
    const templateAcc = new Map();

    for (const draft of perDraft) {
      const domainKey = draft.domainTag;
      const domain = domainAcc.get(domainKey) || {
        domainTag: domainKey,
        draftCount: 0,
        finalizedCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        reviseRequestedCount: 0,
        pendingCount: 0,
        qualitySignalTotal: 0
      };
      domain.draftCount += 1;
      domain.qualitySignalTotal += draft.qualitySignal;
      if (draft.result === "pending") {
        domain.pendingCount += 1;
      } else {
        domain.finalizedCount += 1;
      }
      if (draft.result === "accepted") domain.acceptedCount += 1;
      if (draft.result === "rejected") domain.rejectedCount += 1;
      if (draft.result === "revise_requested") domain.reviseRequestedCount += 1;
      domainAcc.set(domainKey, domain);

      const templateKey = `${draft.generatorVersion}|${draft.templateVersion}|${draft.domainTag}`;
      const template = templateAcc.get(templateKey) || {
        generatorVersion: draft.generatorVersion,
        templateVersion: draft.templateVersion,
        domainTag: draft.domainTag,
        draftCount: 0,
        finalizedCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        reviseRequestedCount: 0,
        pendingCount: 0,
        qualitySignalTotal: 0
      };
      template.draftCount += 1;
      template.qualitySignalTotal += draft.qualitySignal;
      if (draft.result === "pending") {
        template.pendingCount += 1;
      } else {
        template.finalizedCount += 1;
      }
      if (draft.result === "accepted") template.acceptedCount += 1;
      if (draft.result === "rejected") template.rejectedCount += 1;
      if (draft.result === "revise_requested") template.reviseRequestedCount += 1;
      templateAcc.set(templateKey, template);
    }

    const perDomain = [...domainAcc.values()]
      .map((item) => DomainQualityRecordSchema.parse({
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
      .sort((left, right) => left.domainTag.localeCompare(right.domainTag));

    const perTemplate = [...templateAcc.values()]
      .map((item) => TemplateQualityRecordSchema.parse({
        generatorVersion: item.generatorVersion,
        templateVersion: item.templateVersion,
        domainTag: item.domainTag,
        draftCount: item.draftCount,
        finalizedCount: item.finalizedCount,
        averageQualitySignal: item.draftCount === 0 ? 0 : Math.floor(item.qualitySignalTotal / item.draftCount),
        acceptedCount: item.acceptedCount,
        rejectedCount: item.rejectedCount,
        reviseRequestedCount: item.reviseRequestedCount,
        pendingCount: item.pendingCount
      }))
      .sort((left, right) => {
        const byGenerator = left.generatorVersion.localeCompare(right.generatorVersion);
        if (byGenerator !== 0) return byGenerator;
        const byTemplate = left.templateVersion.localeCompare(right.templateVersion);
        if (byTemplate !== 0) return byTemplate;
        return left.domainTag.localeCompare(right.domainTag);
      });

    const qualityPriorByDomain = Object.fromEntries(
      perDomain
        .map((entry) => [entry.domainTag, entry.averageQualitySignal])
        .sort((left, right) => left[0].localeCompare(right[0]))
    );

    const finalizedCount = perDraft.filter((entry) => entry.result !== "pending").length;
    const pendingCount = perDraft.length - finalizedCount;

    const snapshot = QualitySnapshotSchema.parse({
      ok: true,
      asOfIso,
      totals: {
        draftCount: perDraft.length,
        outcomeCount: outcomes.length,
        finalizedCount,
        pendingCount
      },
      monetizationSnapshotScore,
      perDraft,
      perDomain,
      perTemplate,
      qualityPriorByDomain
    });

    return canonicalize(snapshot);
  }

  return Object.freeze({
    computeQualitySnapshot
  });
}

module.exports = {
  createQualityScoreEngine
};
