"use strict";

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function normalizeMissingChecks(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => safeString(entry))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function buildRankedFactors(evaluation = {}) {
  const decision = safeString(evaluation.decision) || "hold";
  const reasonCode = safeString(evaluation.reasonCode) || "policy_violation";
  const missingChecks = normalizeMissingChecks(evaluation.missingChecks);
  const freshnessHours = Number(evaluation.freshnessHours);
  const factors = [];

  factors.push({
    key: "decision",
    label: "Gate Decision",
    value: decision,
    impact: decision === "allow" ? 10 : (decision === "hold" ? 60 : 90)
  });

  factors.push({
    key: "reasonCode",
    label: "Reason Code",
    value: reasonCode,
    impact: reasonCode === "all_checks_passed" ? 10 : 80
  });

  factors.push({
    key: "missingChecks",
    label: "Missing Required Checks",
    value: missingChecks.length,
    impact: missingChecks.length === 0 ? 0 : Math.min(100, missingChecks.length * 25)
  });

  factors.push({
    key: "freshnessHours",
    label: "Evidence Freshness Hours",
    value: Number.isFinite(freshnessHours) ? Number.parseFloat(freshnessHours.toFixed(6)) : null,
    impact: Number.isFinite(freshnessHours) ? Math.min(100, Math.floor(freshnessHours)) : 50
  });

  factors.sort((left, right) => {
    if (right.impact !== left.impact) {
      return right.impact - left.impact;
    }
    return left.key.localeCompare(right.key);
  });

  return factors.map((entry, index) => ({
    rank: index + 1,
    ...entry
  }));
}

function buildGateRationale(input = {}) {
  const evaluation = input.evaluation && typeof input.evaluation === "object" ? input.evaluation : {};
  const factors = buildRankedFactors(evaluation);
  const missingChecks = normalizeMissingChecks(evaluation.missingChecks);

  return {
    ok: true,
    decision: safeString(evaluation.decision) || "hold",
    reasonCode: safeString(evaluation.reasonCode) || "policy_violation",
    targetRef: safeString(evaluation.targetRef),
    targetSha: safeString(evaluation.targetSha).toLowerCase(),
    asOfIso: safeString(evaluation.asOfIso),
    policySnapshotHash: safeString(evaluation.policySnapshotHash).toLowerCase(),
    missingChecks,
    factors: canonicalize(factors)
  };
}

module.exports = {
  buildGateRationale,
  buildRankedFactors,
  canonicalize
};
