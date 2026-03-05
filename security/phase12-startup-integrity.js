"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { safeString } = require("../workflows/governance-automation/common.js");

const { createSbomGenerator } = require("../workflows/supply-chain/sbom-generator.js");
const { createDependencyIntegrityVerifier } = require("../workflows/supply-chain/dependency-integrity-verifier.js");
const { createBuildProvenanceAttestor } = require("../workflows/supply-chain/build-provenance-attestor.js");
const { createDependencyUpdateGovernor } = require("../workflows/supply-chain/dependency-update-governor.js");
const { createVulnerabilityReporter } = require("../workflows/supply-chain/vulnerability-reporter.js");
const { createSupplyChainPolicyEngine } = require("../workflows/supply-chain/supply-chain-policy-engine.js");
const { createArtifactSigningManager } = require("../workflows/supply-chain/artifact-signing-manager.js");
const { getSupplyChainSchema } = require("../workflows/supply-chain/supply-chain-schema.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 12 startup integrity failure"));
  error.code = String(code || "PHASE12_STARTUP_INTEGRITY_FAILED");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function ensureWritableDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const probePath = path.join(dirPath, ".phase12-startup-probe");
  fs.writeFileSync(probePath, "probe\n", "utf8");
  fs.unlinkSync(probePath);
}

function requiredFiles(rootDir) {
  return [
    "workflows/supply-chain/supply-chain-schema.js",
    "workflows/supply-chain/supply-chain-common.js",
    "workflows/supply-chain/sbom-generator.js",
    "workflows/supply-chain/dependency-integrity-verifier.js",
    "workflows/supply-chain/build-provenance-attestor.js",
    "workflows/supply-chain/dependency-update-governor.js",
    "workflows/supply-chain/vulnerability-reporter.js",
    "workflows/supply-chain/supply-chain-policy-engine.js",
    "workflows/supply-chain/artifact-signing-manager.js",
    "scripts/generate-sbom.js",
    "scripts/verify-dependency-integrity.js",
    "scripts/generate-build-provenance.js",
    "scripts/approve-dependency-update.js",
    "scripts/scan-vulnerabilities.js",
    "scripts/sign-artifact.js",
    "scripts/verify-artifact-signature.js",
    "scripts/generate-phase12-artifacts.js",
    "scripts/verify-phase12-policy.sh",
    "security/known-good-dependencies.json",
    "security/vulnerability-advisories.json",
    "security/supply-chain-policy.json",
    "security/artifact-signing-key.sample.json"
  ].map((rel) => ({ rel, abs: path.join(rootDir, rel) }));
}

async function verifyPhase12StartupIntegrity(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const rootDir = typeof options.rootDir === "string" && options.rootDir.trim() ? options.rootDir : process.cwd();

  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    throw makeError("PHASE12_STARTUP_CONFIG_INVALID", "apiGovernance.readState is required for startup checks");
  }
  if (typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE12_STARTUP_CONFIG_INVALID", "apiGovernance.withGovernanceTransaction is required for startup checks");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("PHASE12_STARTUP_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required for startup checks");
  }
  if (typeof operatorAuthorization.issueApprovalToken !== "function") {
    throw makeError("PHASE12_STARTUP_CONFIG_INVALID", "operatorAuthorization.issueApprovalToken is required for startup checks");
  }

  const failures = [];

  for (const file of requiredFiles(rootDir)) {
    if (!fs.existsSync(file.abs)) {
      failures.push({ check: "required_file", file: file.rel, reason: "missing" });
    }
  }

  const knownGoodPath = path.join(rootDir, "security", "known-good-dependencies.json");
  const advisoryDbPath = path.join(rootDir, "security", "vulnerability-advisories.json");
  const policyPath = path.join(rootDir, "security", "supply-chain-policy.json");
  const sampleKeyPath = path.join(rootDir, "security", "artifact-signing-key.sample.json");

  for (const jsonPath of [knownGoodPath, advisoryDbPath, policyPath, sampleKeyPath]) {
    if (!fs.existsSync(jsonPath)) {
      continue;
    }
    try {
      JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch (error) {
      failures.push({
        check: "json_parse",
        file: path.relative(rootDir, jsonPath),
        reason: error && error.message ? error.message : String(error)
      });
    }
  }

  try {
    const schema = getSupplyChainSchema();
    if (!schema || !schema.entities || !schema.entities.sbom) {
      failures.push({ check: "supply_chain_schema", reason: "invalid_schema_shape" });
    }
  } catch (error) {
    failures.push({ check: "supply_chain_schema", reason: error && error.message ? error.message : String(error) });
  }

  try {
    const fixedTimeProvider = { nowIso: () => "2026-03-05T00:00:00.000Z" };

    const sbomGenerator = createSbomGenerator({
      logger,
      rootDir,
      timeProvider: fixedTimeProvider
    });
    const sbomResult = sbomGenerator.generateSbom();

    const integrityVerifier = createDependencyIntegrityVerifier({
      logger,
      knownGoodPath
    });
    const integrityResult = integrityVerifier.verifyDependencyIntegrity(sbomResult.sbom);
    if (!integrityResult || typeof integrityResult.valid !== "boolean") {
      failures.push({ check: "dependency_integrity_verifier", reason: "invalid_verifier_shape" });
    }

    const provenanceAttestor = createBuildProvenanceAttestor({
      logger,
      timeProvider: fixedTimeProvider
    });
    const provenanceResult = provenanceAttestor.generateProvenance({
      commit_sha: safeString(options.commitSha) || "03295ceea3e4620507fa6d88df4f6a2324c899f8",
      builder_identity: "phase12-startup-integrity",
      sbom_hash: sbomResult.sbom_hash,
      artifacts: [{
        artifact_path: path.join(rootDir, "package-lock.json")
      }],
      policy_gates: {
        phase11: "pass",
        phase12: "startup_check"
      }
    });
    if (!provenanceResult || !provenanceResult.provenance_hash) {
      failures.push({ check: "build_provenance_attestor", reason: "invalid_provenance_shape" });
    }

    const vulnerabilityReporter = createVulnerabilityReporter({ logger });
    const vulnerabilityResult = vulnerabilityReporter.scanVulnerabilities(sbomResult.sbom, advisoryDbPath);
    if (!vulnerabilityResult || vulnerabilityResult.advisory_only !== true || vulnerabilityResult.auto_patch_blocked !== true) {
      failures.push({ check: "vulnerability_reporter", reason: "invalid_vulnerability_report_shape" });
    }

    const policyEngine = createSupplyChainPolicyEngine({ logger, policyPath });
    const policyResult = policyEngine.evaluatePolicy({
      sbom: sbomResult.sbom,
      dependency_manifest: JSON.parse(fs.readFileSync(knownGoodPath, "utf8")),
      vulnerability_report: vulnerabilityResult,
      current_time: "2026-03-05T00:00:00.000Z"
    });
    if (!policyResult || typeof policyResult.compliant !== "boolean") {
      failures.push({ check: "supply_chain_policy_engine", reason: "invalid_policy_result_shape" });
    }

    const signingManager = createArtifactSigningManager({
      logger,
      timeProvider: fixedTimeProvider,
      keyPath: sampleKeyPath
    });
    const signingResult = signingManager.signArtifact({
      artifact_path: path.join(rootDir, "package-lock.json"),
      sbom_hash: sbomResult.sbom_hash,
      provenance_hash: provenanceResult.provenance_hash
    });
    const verifyResult = signingManager.verifySignature(signingResult.signature_record, sampleKeyPath);
    if (!verifyResult || typeof verifyResult.valid !== "boolean") {
      failures.push({ check: "artifact_signing_manager", reason: "invalid_verification_shape" });
    }

    const updateGovernor = createDependencyUpdateGovernor({
      apiGovernance,
      operatorAuthorization,
      logger,
      timeProvider: fixedTimeProvider,
      knownGoodPath
    });
    const updatePlan = updateGovernor.presentUpdatePlan({
      request_id: "startup-phase12-001",
      requested_by: "startup-integrity",
      reason: "startup_integrity_contract_check",
      updates: [{
        package_name: "zod",
        current_version: "3.24.1",
        target_version: "3.24.1",
        package_hash_sha256: "placeholder"
      }]
    });
    if (!updatePlan || !updatePlan.plan || !updatePlan.risk || !Array.isArray(updatePlan.acceptance_criteria)) {
      failures.push({ check: "dependency_update_governor", reason: "invalid_plan_shape" });
    }
  } catch (error) {
    failures.push({
      check: "module_bootstrap",
      reason: error && error.message ? error.message : String(error)
    });
  }

  try {
    const artifactDir = path.resolve(options.supplyChainArtifactPath || path.join(rootDir, "audit", "evidence", "supply-chain"));
    ensureWritableDirectory(artifactDir);
  } catch (error) {
    failures.push({ check: "supply_chain_artifact_path", reason: error && error.message ? error.message : String(error) });
  }

  const result = {
    healthy: failures.length === 0,
    failures
  };

  if (!result.healthy) {
    logger.error({ event: "phase12_startup_integrity_failed", failures: result.failures });
    return result;
  }

  logger.info({
    event: "phase12_startup_integrity_verified",
    checks: "all",
    healthy: true
  });

  return result;
}

module.exports = {
  verifyPhase12StartupIntegrity
};
