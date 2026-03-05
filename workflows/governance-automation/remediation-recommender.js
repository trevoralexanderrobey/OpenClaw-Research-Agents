"use strict";

const path = require("node:path");
const {
  asArray,
  canonicalize,
  safeString,
  writeCanonicalJson
} = require("./common.js");

function toMinimalEdit(drift) {
  const file = safeString(drift && drift.file);
  const clause = safeString(drift && (drift.violation_clause || drift.clause));
  const recommendedFix = safeString(drift && drift.recommended_fix);
  return canonicalize({
    drift_id: safeString(drift && (drift.id || "drift")),
    severity: safeString(drift && drift.severity) || "high",
    file,
    line: Number(drift && drift.line ? drift.line : 1),
    recommended_edits: [
      {
        type: "restore_contract_clause",
        target_file: file,
        violation_clause: clause,
        patch_hint: recommendedFix || `Restore ${clause} baseline language`
      }
    ],
    rationale: clause,
    acceptance_criteria: [
      "Re-run compliance monitor and expect compliant=true",
      "Re-run drift detector and expect drifts=[]",
      "Re-run phase9 policy gate and expect pass"
    ],
    operator_approval_token_required: true,
    governance_transaction_wrapper_required: true
  });
}

function createRemediationRecommender(options = {}) {
  const driftDetectionOutput = options.driftDetectionOutput && typeof options.driftDetectionOutput === "object"
    ? options.driftDetectionOutput
    : {};
  const phaseContracts = options.phaseContracts && typeof options.phaseContracts === "object" ? options.phaseContracts : {};
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  function recommendRemediationDelta(input = {}) {
    const rootDir = path.resolve(safeString(input.rootDir) || process.cwd());
    const drifts = asArray(input.driftDetectionOutput && input.driftDetectionOutput.drifts)
      .concat(asArray(driftDetectionOutput.drifts));

    const deduped = new Map();
    for (const drift of drifts) {
      const id = `${safeString(drift && drift.id)}|${safeString(drift && drift.file)}|${Number(drift && drift.line ? drift.line : 1)}`;
      if (!deduped.has(id)) {
        deduped.set(id, drift);
      }
    }

    const orderedDrifts = [...deduped.values()].sort((left, right) => {
      const leftFile = safeString(left && left.file);
      const rightFile = safeString(right && right.file);
      if (leftFile !== rightFile) {
        return leftFile.localeCompare(rightFile);
      }
      return Number(left && left.line ? left.line : 1) - Number(right && right.line ? right.line : 1);
    });

    const recommendations = orderedDrifts.map((drift) => toMinimalEdit(drift));

    const request = canonicalize({
      schema_version: "phase9-remediation-request-v1",
      baseline_commit: safeString(phaseContracts.baselineCommit),
      recommendations,
      operator_approval_token_required: true,
      governance_transaction_wrapper_required: true,
      generated_without_autonomous_execution: true
    });

    const outputPath = path.resolve(
      safeString(input.outputPath)
      || path.join(rootDir, "audit", "evidence", "governance-automation", "remediation-request.json")
    );

    writeCanonicalJson(outputPath, request);

    const result = canonicalize({
      recommendation: request,
      operator_approval_required: true,
      output_path: outputPath
    });

    logger.info({
      event: "phase9_remediation_recommendation_generated",
      recommendations: recommendations.length,
      outputPath
    });

    return result;
  }

  return Object.freeze({
    recommendRemediationDelta
  });
}

module.exports = {
  createRemediationRecommender,
  toMinimalEdit
};
