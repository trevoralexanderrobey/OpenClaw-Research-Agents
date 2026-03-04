"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const { buildTemplatePerformanceRegistry } = require("../../workflows/rlhf-generator/template-performance.js");
const { rankDomainPriorities } = require("./domain-priority-engine.js");

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

function ensureDependencies(apiGovernance, qualityScoreEngine) {
  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    const error = new Error("apiGovernance.readState is required");
    error.code = "RLHF_PORTFOLIO_CONFIG_INVALID";
    throw error;
  }
  if (!qualityScoreEngine || typeof qualityScoreEngine.computeQualitySnapshot !== "function") {
    const error = new Error("qualityScoreEngine.computeQualitySnapshot is required");
    error.code = "RLHF_PORTFOLIO_CONFIG_INVALID";
    throw error;
  }
}

function createPortfolioPlanner(options = {}) {
  const apiGovernance = options.apiGovernance;
  const qualityScoreEngine = options.qualityScoreEngine;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  ensureDependencies(apiGovernance, qualityScoreEngine);

  async function buildPortfolioPlan(input = {}) {
    const asOfIso = typeof input.asOfIso === "string" && input.asOfIso.trim() ? input.asOfIso.trim() : String(timeProvider.nowIso());
    const state = await apiGovernance.readState();
    const drafts = toArray(state && state.rlhfWorkflows && state.rlhfWorkflows.drafts)
      .slice()
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    const outcomes = toArray(state && state.rlhfOutcomes && state.rlhfOutcomes.records)
      .slice()
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    const calibration = state && state.rlhfOutcomes && state.rlhfOutcomes.calibration && isObject(state.rlhfOutcomes.calibration.weights)
      ? state.rlhfOutcomes.calibration
      : {
          version: "v1",
          lastCalibratedAt: "",
          weights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 }
        };

    if (drafts.length === 0 && outcomes.length === 0) {
      return canonicalize({
        ok: true,
        noOp: true,
        reason: "empty_window",
        asOfIso,
        calibrationVersion: calibration.version,
        priorities: [],
        workloadBalancing: {
          totalPending: 0,
          recommendedReviewerLoad: 0
        }
      });
    }

    const qualitySnapshot = await qualityScoreEngine.computeQualitySnapshot({ asOfIso });
    const templateRegistry = buildTemplatePerformanceRegistry({
      drafts,
      outcomes,
      qualitySnapshot
    });
    const priorities = rankDomainPriorities({
      templateRegistry,
      qualitySignals: qualitySnapshot,
      calibrationWeights: calibration.weights
    });
    const totalPending = priorities.domains.reduce((sum, domain) => sum + Number(domain.pendingCount || 0), 0);
    const recommendedReviewerLoad = priorities.domains.length === 0
      ? 0
      : Math.ceil(totalPending / priorities.domains.length);

    return canonicalize({
      ok: true,
      noOp: false,
      asOfIso,
      calibrationVersion: calibration.version,
      calibrationWeights: calibration.weights,
      templatePerformance: templateRegistry.records,
      priorities: priorities.domains,
      workloadBalancing: {
        totalPending,
        recommendedReviewerLoad
      }
    });
  }

  return Object.freeze({
    buildPortfolioPlan
  });
}

module.exports = {
  createPortfolioPlanner
};
