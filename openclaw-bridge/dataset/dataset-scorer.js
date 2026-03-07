"use strict";

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createDatasetScorer(options = {}) {
  const schemaEngine = options.schemaEngine;
  if (!schemaEngine || typeof schemaEngine.getQualityRules !== "function") {
    throw new Error("schemaEngine.getQualityRules is required");
  }

  function getQualityRules(datasetType) {
    return canonicalize(schemaEngine.getQualityRules(datasetType));
  }

  function normalizeWeights(weightsInput) {
    const weights = asPlainObject(weightsInput);
    const normalized = {};
    for (const [key, value] of Object.entries(weights)) {
      const numeric = asNumber(value, 0);
      if (numeric > 0) {
        normalized[key] = numeric;
      }
    }
    return canonicalize(normalized);
  }

  function weightedScore(valuesInput, weightsInput) {
    const values = asPlainObject(valuesInput);
    const weights = normalizeWeights(weightsInput);
    let numerator = 0;
    let denominator = 0;
    for (const [metric, weight] of Object.entries(weights)) {
      numerator += asNumber(values[metric], 0) * weight;
      denominator += weight;
    }
    if (denominator <= 0) {
      return 0;
    }
    return Math.round((numerator / denominator) * 100) / 100;
  }

  function scoreBuild(input = {}) {
    const datasetType = safeString(input.dataset_type || input.datasetType);
    const metadata = asPlainObject(input.metadata);
    const validationResult = asPlainObject(input.validation_result);
    const provenanceResult = asPlainObject(input.provenance_result);
    const dedupeResult = asPlainObject(input.dedupe_result);
    const qualityRules = getQualityRules(datasetType);
    const scoring = asPlainObject(qualityRules.scoring);
    const rowWeights = normalizeWeights(scoring.row_weights);
    const buildWeights = normalizeWeights(scoring.build_weights);
    const rowThreshold = asNumber(scoring.row_min_score, 70);
    const buildThreshold = Math.max(0, asNumber(metadata.quality_threshold, 0)) > 0
      ? Math.max(0, asNumber(metadata.quality_threshold, 0))
      : asNumber(scoring.build_min_score, 75);
    const minBuildSourceDiversity = Math.max(1, Math.trunc(asNumber(scoring.min_build_source_diversity, 1)));
    const minRowSourceDiversity = Math.max(1, Math.trunc(asNumber(scoring.min_row_source_diversity, 1)));

    if (Object.keys(rowWeights).length === 0 || Object.keys(buildWeights).length === 0) {
      const error = new Error("Quality scoring config is malformed");
      error.code = "PHASE20_QUALITY_RULE_INVALID";
      throw error;
    }

    const validationByRowHash = new Map((Array.isArray(validationResult.row_results) ? validationResult.row_results : []).map((entry) => [safeString(entry.row_hash), canonicalize(entry)]));
    const provenanceByRowHash = new Map((Array.isArray(provenanceResult.row_records) ? provenanceResult.row_records : []).map((entry) => [safeString(entry.row_hash), canonicalize(entry)]));
    const dedupedRows = Array.isArray(dedupeResult.rows) ? dedupeResult.rows.map((entry) => canonicalize(entry)) : [];
    const rowScores = [];
    const buildTaskIds = new Set();

    for (const dedupedRow of dedupedRows) {
      const rowHash = safeString(dedupedRow.row_hash);
      const validation = validationByRowHash.get(rowHash) || {};
      const provenance = provenanceByRowHash.get(rowHash) || {};
      const sourceTaskIds = Array.isArray(provenance.source_task_ids) ? provenance.source_task_ids.slice().sort() : [];
      for (const taskId of sourceTaskIds) {
        buildTaskIds.add(taskId);
      }
      const completeness = Math.round(asNumber(validation.completeness_ratio, 0) * 10000) / 100;
      const citationCoverage = Array.isArray(provenance.source_artifacts) && provenance.source_artifacts.length > 0 ? 100 : 0;
      const sourceDiversity = Math.round((Math.min(sourceTaskIds.length / minRowSourceDiversity, 1)) * 10000) / 100;
      const confidence = Math.round((((validation.ok ? 1 : 0)
        + (provenance.ok ? 1 : 0)
        + asNumber(validation.completeness_ratio, 0)
        + (citationCoverage > 0 ? 1 : 0)) / 4) * 10000) / 100;
      const metrics = canonicalize({
        citation_coverage: citationCoverage,
        completeness,
        confidence,
        source_diversity: sourceDiversity
      });
      const rowScore = weightedScore(metrics, rowWeights);
      rowScores.push(canonicalize({
        metrics,
        passes_threshold: Boolean(rowScore >= rowThreshold && validation.ok === true && provenance.ok === true),
        row_hash: rowHash,
        row_number: Number(dedupedRow.row_number || 0),
        score: rowScore,
        threshold: rowThreshold
      }));
    }

    const average = (items, pick) => {
      if (!Array.isArray(items) || items.length === 0) {
        return 0;
      }
      const total = items.reduce((sum, entry) => sum + asNumber(pick(entry), 0), 0);
      return Math.round((total / items.length) * 100) / 100;
    };

    const buildMetrics = canonicalize({
      citation_coverage: average(rowScores, (entry) => entry.metrics.citation_coverage),
      completeness: average(rowScores, (entry) => entry.metrics.completeness),
      confidence: average(rowScores, (entry) => entry.metrics.confidence),
      source_diversity: Math.round((Math.min(buildTaskIds.size / minBuildSourceDiversity, 1)) * 10000) / 100
    });
    const buildScore = weightedScore(buildMetrics, buildWeights);
    const rowFailures = rowScores.filter((entry) => entry.passes_threshold !== true).map((entry) => canonicalize({
      code: "PHASE20_QUALITY_ROW_THRESHOLD",
      row_hash: safeString(entry.row_hash),
      row_number: Number(entry.row_number || 0),
      score: asNumber(entry.score, 0),
      threshold: rowThreshold
    }));
    const buildFailures = [];
    if (buildScore < buildThreshold) {
      buildFailures.push(canonicalize({
        code: "PHASE20_QUALITY_BUILD_THRESHOLD",
        score: buildScore,
        threshold: buildThreshold
      }));
    }

    const report = canonicalize({
      build_summary: {
        build_score: buildScore,
        metrics: buildMetrics,
        quality_status: rowFailures.length === 0 && buildFailures.length === 0 ? "passed" : "failed",
        reason_codes: Array.from(new Set([...rowFailures, ...buildFailures].map((entry) => safeString(entry.code)).filter(Boolean))).sort((left, right) => left.localeCompare(right)),
        row_threshold: rowThreshold,
        threshold: buildThreshold
      },
      build_threshold_evaluation: {
        build_passes_threshold: buildFailures.length === 0,
        row_failures: rowFailures,
        threshold: buildThreshold
      },
      row_scores: rowScores
    });

    return canonicalize({
      build_score: buildScore,
      ok: true,
      quality_report: report,
      quality_status: report.build_summary.quality_status,
      row_scores: rowScores
    });
  }

  function getConfigSnapshotHash(datasetType) {
    return sha256(JSON.stringify(canonicalize({
      quality_rules: getQualityRules(datasetType),
      version: "phase20-dataset-scorer-v1"
    })));
  }

  return Object.freeze({
    getConfigSnapshotHash,
    scoreBuild
  });
}

module.exports = {
  createDatasetScorer
};
