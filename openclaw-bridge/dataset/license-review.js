"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function normalizeDomain(value) {
  const text = safeString(value).toLowerCase();
  if (!text) {
    return "";
  }
  if (!text.includes("://")) {
    return text.replace(/^\.+|\.+$/g, "");
  }
  try {
    return new URL(text).hostname.toLowerCase();
  } catch (error) {
    return "";
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stableReasonCodes(items) {
  return Array.from(new Set((Array.isArray(items) ? items : [])
    .map((entry) => safeString(entry.reason_code || entry.code))
    .filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function createLicenseReview(options = {}) {
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const licenseRulesPath = path.resolve(safeString(options.licenseRulesPath) || path.join(rootDir, "config", "dataset-license-rules.json"));
  const licenseRules = canonicalize(readJson(licenseRulesPath));

  function validateConfig() {
    const source = asPlainObject(licenseRules);
    const allowedStates = new Set(["allowed", "blocked", "review_required"]);
    if (safeString(source.schema_version) !== "phase20-dataset-license-rules-v1") {
      const error = new Error("dataset-license-rules.json must declare phase20-dataset-license-rules-v1");
      error.code = "PHASE20_LICENSE_CONFIG_INVALID";
      throw error;
    }
    if (!allowedStates.has(safeString(source.default_unknown_state))) {
      const error = new Error("dataset-license-rules.json requires a valid default_unknown_state");
      error.code = "PHASE20_LICENSE_CONFIG_INVALID";
      throw error;
    }
  }

  function buildDecision(state, reasonCode, extras = {}) {
    return canonicalize({
      reason_code: safeString(reasonCode),
      state: safeString(state),
      ...canonicalize(extras)
    });
  }

  function classifySource(sourceArtifact = {}) {
    const artifact = canonicalize(sourceArtifact);
    const metadata = asPlainObject(artifact.metadata);
    const taskId = safeString(artifact.task_id);
    const sourceOverride = asPlainObject(asPlainObject(licenseRules.source_overrides)[`task:${taskId}`]);
    if (sourceOverride.state) {
      return buildDecision(sourceOverride.state, safeString(sourceOverride.reason_code) || safeString(licenseRules.reason_codes.source_override), {
        source_key: `task:${taskId}`
      });
    }

    const explicitState = safeString(metadata.license_state || metadata.rights_state);
    if (explicitState === "allowed") {
      return buildDecision("allowed", safeString(licenseRules.reason_codes.explicit_allowed), { source_key: `task:${taskId}` });
    }
    if (explicitState === "review_required") {
      return buildDecision("review_required", safeString(licenseRules.reason_codes.explicit_review_required), { source_key: `task:${taskId}` });
    }
    if (explicitState === "blocked") {
      return buildDecision("blocked", safeString(licenseRules.reason_codes.explicit_blocked), { source_key: `task:${taskId}` });
    }

    const rights = asPlainObject(metadata.rights);
    if (rights.commercial_use_allowed === true && rights.redistribution_allowed === true) {
      return buildDecision("allowed", safeString(licenseRules.reason_codes.rights_allowed), { source_key: `task:${taskId}` });
    }
    if (rights.commercial_use_allowed === false || rights.redistribution_allowed === false) {
      return buildDecision("blocked", safeString(licenseRules.reason_codes.rights_blocked), { source_key: `task:${taskId}` });
    }

    const domain = normalizeDomain(metadata.source_domain || metadata.domain || metadata.source_url || metadata.url);
    const domainRule = asPlainObject(asPlainObject(licenseRules.domain_rules)[domain]);
    if (domainRule.state) {
      return buildDecision(domainRule.state, safeString(domainRule.reason_code), {
        domain,
        source_key: `task:${taskId}`
      });
    }

    const licenseName = safeString(metadata.license || metadata.license_name).toLowerCase();
    const licenseRule = asPlainObject(asPlainObject(licenseRules.license_rules)[licenseName]);
    if (licenseRule.state) {
      return buildDecision(licenseRule.state, safeString(licenseRule.reason_code), {
        license: licenseName,
        source_key: `task:${taskId}`
      });
    }

    return buildDecision(safeString(licenseRules.default_unknown_state), safeString(licenseRules.reason_codes.default_unknown), {
      source_key: `task:${taskId}`
    });
  }

  function classifyBuild(input = {}) {
    validateConfig();
    const sourceArtifacts = Array.isArray(input.source_artifacts)
      ? input.source_artifacts.map((entry) => canonicalize(entry))
      : [];
    const provenanceResult = asPlainObject(input.provenance_result);
    const rowRecords = Array.isArray(provenanceResult.row_records)
      ? provenanceResult.row_records.map((entry) => canonicalize(entry))
      : [];
    const sourceReviews = new Map();
    for (const sourceArtifact of sourceArtifacts) {
      const taskId = safeString(sourceArtifact.task_id);
      sourceReviews.set(taskId, canonicalize({
        review: classifySource(sourceArtifact),
        task_id: taskId
      }));
    }

    const rowReviews = [];
    for (const rowRecord of rowRecords) {
      const taskReviews = asStringArray(rowRecord.source_task_ids)
        .map((taskId) => sourceReviews.get(taskId))
        .filter(Boolean)
        .sort((left, right) => safeString(left.task_id).localeCompare(safeString(right.task_id)));
      let licenseState = "allowed";
      if (taskReviews.length === 0) {
        licenseState = safeString(licenseRules.default_unknown_state);
      } else if (taskReviews.some((entry) => safeString(entry.review.state) === "blocked")) {
        licenseState = "blocked";
      } else if (taskReviews.some((entry) => safeString(entry.review.state) === "review_required")) {
        licenseState = "review_required";
      }
      rowReviews.push(canonicalize({
        license_state: licenseState,
        reason_codes: stableReasonCodes(taskReviews.map((entry) => entry.review)),
        row_hash: safeString(rowRecord.row_hash),
        row_number: Number(rowRecord.row_number || 0),
        source_reviews: taskReviews
      }));
    }

    let buildState = "allowed";
    if (rowReviews.some((entry) => safeString(entry.license_state) === "blocked")) {
      buildState = "blocked";
    } else if (rowReviews.some((entry) => safeString(entry.license_state) === "review_required")) {
      buildState = "review_required";
    }

    const report = canonicalize({
      build_summary: {
        allowed_row_count: rowReviews.filter((entry) => entry.license_state === "allowed").length,
        blocked_reason_codes: stableReasonCodes(rowReviews.filter((entry) => entry.license_state === "blocked").flatMap((entry) => entry.source_reviews.map((review) => review.review))),
        license_state: buildState,
        review_required_reason_codes: stableReasonCodes(rowReviews.filter((entry) => entry.license_state === "review_required").flatMap((entry) => entry.source_reviews.map((review) => review.review))),
        row_count: rowReviews.length
      },
      row_reviews: rowReviews,
      source_reviews: Array.from(sourceReviews.values()).sort((left, right) => safeString(left.task_id).localeCompare(safeString(right.task_id)))
    });

    return canonicalize({
      license_report: report,
      license_state: buildState,
      ok: true,
      row_reviews: rowReviews
    });
  }

  function getConfigSnapshotHash() {
    validateConfig();
    return sha256(JSON.stringify(licenseRules));
  }

  return Object.freeze({
    classifyBuild,
    getConfigSnapshotHash
  });
}

module.exports = {
  createLicenseReview
};
