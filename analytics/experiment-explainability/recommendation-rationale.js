"use strict";

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function rankFactors(metrics = {}, guardrailBreaches = []) {
  const factors = [
    {
      key: "acceptanceRateDelta",
      label: "Acceptance rate delta",
      value: asNumber(metrics.acceptanceRateDelta),
      impact: asNumber(metrics.acceptanceRateDelta)
    },
    {
      key: "reviseRequestRateDelta",
      label: "Revise-request rate delta",
      value: asNumber(metrics.reviseRequestRateDelta),
      impact: -Math.abs(asNumber(metrics.reviseRequestRateDelta))
    },
    {
      key: "meanQualityScoreDelta",
      label: "Mean quality score delta",
      value: asNumber(metrics.meanQualityScoreDelta),
      impact: asNumber(metrics.meanQualityScoreDelta)
    },
    {
      key: "medianQualityScoreDelta",
      label: "Median quality score delta",
      value: asNumber(metrics.medianQualityScoreDelta),
      impact: asNumber(metrics.medianQualityScoreDelta)
    }
  ];

  const breachSet = new Set(Array.isArray(guardrailBreaches) ? guardrailBreaches : []);
  if (breachSet.size > 0) {
    factors.push({
      key: "guardrails",
      label: "Guardrail breaches",
      value: breachSet.size,
      impact: -100
    });
  }

  return factors
    .sort((left, right) => {
      const delta = Number(right.impact) - Number(left.impact);
      if (delta !== 0) return delta;
      return left.key.localeCompare(right.key);
    })
    .map((entry, index) => ({
      rank: index + 1,
      key: entry.key,
      label: entry.label,
      value: entry.value,
      impact: Number(entry.impact)
    }));
}

function buildRecommendationRationale(input = {}) {
  const recommendation = safeString(input.recommendation) || "hold";
  const reasonCode = safeString(input.reasonCode) || "insufficient_power";
  const metrics = input.metrics && typeof input.metrics === "object" ? input.metrics : {};
  const guardrailBreaches = Array.isArray(input.guardrailBreaches) ? input.guardrailBreaches : [];

  return {
    recommendation,
    reasonCode,
    summary: `Recommendation '${recommendation}' generated with reason '${reasonCode}'.`,
    factors: rankFactors(metrics, guardrailBreaches),
    guardrailBreaches
  };
}

module.exports = {
  buildRecommendationRationale,
  rankFactors
};
