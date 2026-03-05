"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalize,
  safeString,
  stableSortStrings
} = require("../governance-automation/common.js");
const { normalizeIso } = require("./supply-chain-common.js");
const { SUPPLY_CHAIN_SCHEMA_VERSION } = require("./supply-chain-schema.js");

const DEFAULT_POLICIES = Object.freeze({
  allowed_licenses: [
    "MIT",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "0BSD",
    "BlueOak-1.0.0"
  ],
  max_direct_dependencies: 50,
  max_total_dependencies: 500,
  max_critical_vulnerabilities: 0,
  manifest_freshness_days: 30
});

function normalizePolicies(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return canonicalize({
    allowed_licenses: stableSortStrings(source.allowed_licenses || DEFAULT_POLICIES.allowed_licenses),
    max_direct_dependencies: Number.parseInt(String(source.max_direct_dependencies ?? DEFAULT_POLICIES.max_direct_dependencies), 10) || DEFAULT_POLICIES.max_direct_dependencies,
    max_total_dependencies: Number.parseInt(String(source.max_total_dependencies ?? DEFAULT_POLICIES.max_total_dependencies), 10) || DEFAULT_POLICIES.max_total_dependencies,
    max_critical_vulnerabilities: Number.parseInt(String(source.max_critical_vulnerabilities ?? DEFAULT_POLICIES.max_critical_vulnerabilities), 10) || DEFAULT_POLICIES.max_critical_vulnerabilities,
    manifest_freshness_days: Number.parseInt(String(source.manifest_freshness_days ?? DEFAULT_POLICIES.manifest_freshness_days), 10) || DEFAULT_POLICIES.manifest_freshness_days
  });
}

function loadPolicyFile(policyPath) {
  const resolved = path.resolve(policyPath);
  if (!fs.existsSync(resolved)) {
    return normalizePolicies({});
  }

  try {
    return normalizePolicies(JSON.parse(fs.readFileSync(resolved, "utf8")));
  } catch {
    return normalizePolicies({});
  }
}

function sortViolations(violations) {
  return violations.slice().sort((left, right) => {
    const leftCode = safeString(left.code);
    const rightCode = safeString(right.code);
    if (leftCode !== rightCode) {
      return leftCode.localeCompare(rightCode);
    }
    return safeString(left.subject).localeCompare(safeString(right.subject));
  });
}

function createSupplyChainPolicyEngine(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const defaultPolicyPath = path.resolve(safeString(options.policyPath) || path.join(process.cwd(), "security", "supply-chain-policy.json"));

  function evaluatePolicy(input = {}) {
    try {
      const source = input && typeof input === "object" ? input : {};
      const sbom = source.sbom && typeof source.sbom === "object"
        ? source.sbom
        : (source.currentSbom && typeof source.currentSbom === "object" ? source.currentSbom : {});
      const dependencyManifest = source.dependency_manifest && typeof source.dependency_manifest === "object"
        ? source.dependency_manifest
        : (source.known_good_manifest && typeof source.known_good_manifest === "object" ? source.known_good_manifest : {});
      const vulnerabilityReport = source.vulnerability_report && typeof source.vulnerability_report === "object"
        ? source.vulnerability_report
        : {};

      const policies = normalizePolicies(source.policy || loadPolicyFile(defaultPolicyPath));
      const components = Array.isArray(sbom.components) ? sbom.components : [];

      const violations = [];

      for (const component of components) {
        const name = safeString(component && component.name);
        const version = safeString(component && component.version);
        const license = safeString(component && component.license);
        const packageHash = safeString(component && component.package_hash_sha256);
        const subject = `${name}@${version}`;

        if (license && !policies.allowed_licenses.includes(license)) {
          violations.push(canonicalize({
            code: "license_not_allowed",
            severity: "high",
            subject,
            message: `Dependency license '${license}' is not in allowed_licenses`
          }));
        }

        if (!packageHash) {
          violations.push(canonicalize({
            code: "missing_integrity_hash",
            severity: "high",
            subject,
            message: "Dependency is missing package_hash_sha256 integrity evidence"
          }));
        }
      }

      const directCount = components.filter((entry) => entry && entry.direct_dependency === true).length;
      if (directCount > policies.max_direct_dependencies) {
        violations.push(canonicalize({
          code: "direct_dependency_count_exceeded",
          severity: "medium",
          subject: "sbom",
          message: `Direct dependency count ${directCount} exceeds max_direct_dependencies ${policies.max_direct_dependencies}`
        }));
      }

      const totalCount = components.length;
      if (totalCount > policies.max_total_dependencies) {
        violations.push(canonicalize({
          code: "total_dependency_count_exceeded",
          severity: "medium",
          subject: "sbom",
          message: `Total dependency count ${totalCount} exceeds max_total_dependencies ${policies.max_total_dependencies}`
        }));
      }

      const manifestGeneratedAt = safeString(dependencyManifest.generated_at);
      if (!manifestGeneratedAt || !Number.isFinite(Date.parse(manifestGeneratedAt))) {
        violations.push(canonicalize({
          code: "manifest_freshness_unknown",
          severity: "medium",
          subject: "dependency_manifest",
          message: "Known-good dependency manifest is missing a valid generated_at timestamp"
        }));
      } else {
        const referenceIso = normalizeIso(safeString(source.current_time) || safeString(source.evaluated_at) || "1970-01-01T00:00:00.000Z");
        const ageMs = Math.max(0, Date.parse(referenceIso) - Date.parse(manifestGeneratedAt));
        const ageDays = ageMs / 86400000;
        if (ageDays > policies.manifest_freshness_days) {
          violations.push(canonicalize({
            code: "manifest_stale",
            severity: "medium",
            subject: "dependency_manifest",
            message: `Known-good dependency manifest age ${ageDays.toFixed(2)} days exceeds manifest_freshness_days ${policies.manifest_freshness_days}`
          }));
        }
      }

      const criticalCount = Number.parseInt(String(vulnerabilityReport.critical_count || 0), 10) || 0;
      if (criticalCount > policies.max_critical_vulnerabilities) {
        violations.push(canonicalize({
          code: "critical_vulnerability_threshold_exceeded",
          severity: "high",
          subject: "vulnerability_report",
          message: `Critical vulnerability count ${criticalCount} exceeds max_critical_vulnerabilities ${policies.max_critical_vulnerabilities}`
        }));
      }

      const sortedViolations = sortViolations(violations);
      const uniqueCodes = stableSortStrings([...new Set(sortedViolations.map((entry) => safeString(entry.code)).filter(Boolean))]);
      const score = Math.max(0, 100 - (sortedViolations.length * 10));

      const result = canonicalize({
        schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
        compliant: sortedViolations.length === 0,
        violations: sortedViolations,
        score,
        recommendations: uniqueCodes.map((code) => `Review policy violation: ${code}`)
      });

      logger.info({
        event: "phase12_supply_chain_policy_evaluated",
        compliant: result.compliant,
        violations: result.violations.length,
        score: result.score
      });

      return result;
    } catch (error) {
      const fallback = canonicalize({
        schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
        compliant: false,
        violations: [{
          code: "policy_evaluation_error",
          severity: "high",
          subject: "supply_chain_policy_engine",
          message: error && error.message ? error.message : "Policy evaluation failed"
        }],
        score: 0,
        recommendations: ["Investigate policy engine evaluation failure"]
      });

      logger.error({
        event: "phase12_supply_chain_policy_error",
        message: error && error.message ? error.message : String(error)
      });

      return fallback;
    }
  }

  return Object.freeze({
    evaluatePolicy
  });
}

module.exports = {
  DEFAULT_POLICIES,
  createSupplyChainPolicyEngine,
  normalizePolicies,
  loadPolicyFile
};
