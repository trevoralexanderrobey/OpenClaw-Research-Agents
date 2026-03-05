"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createCheckpointCoordinator } = require("../workflows/recovery-assurance/checkpoint-coordinator.js");
const { createBackupManifestManager } = require("../workflows/recovery-assurance/backup-manifest-manager.js");
const { createBackupIntegrityVerifier } = require("../workflows/recovery-assurance/backup-integrity-verifier.js");
const { createRestoreOrchestrator } = require("../workflows/recovery-assurance/restore-orchestrator.js");
const { createContinuitySloEngine } = require("../workflows/recovery-assurance/continuity-slo-engine.js");
const { createChaosDrillSimulator } = require("../workflows/recovery-assurance/chaos-drill-simulator.js");
const { createFailoverReadinessValidator } = require("../workflows/recovery-assurance/failover-readiness-validator.js");
const { getRecoverySchema } = require("../workflows/recovery-assurance/recovery-schema.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 11 startup integrity failure"));
  error.code = String(code || "PHASE11_STARTUP_INTEGRITY_FAILED");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function ensureWritableDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const probePath = path.join(dirPath, ".phase11-startup-probe");
  fs.writeFileSync(probePath, "probe\n", "utf8");
  fs.unlinkSync(probePath);
}

function requiredFiles(rootDir) {
  return [
    "workflows/recovery-assurance/recovery-schema.js",
    "workflows/recovery-assurance/recovery-common.js",
    "workflows/recovery-assurance/checkpoint-coordinator.js",
    "workflows/recovery-assurance/backup-manifest-manager.js",
    "workflows/recovery-assurance/backup-integrity-verifier.js",
    "workflows/recovery-assurance/restore-orchestrator.js",
    "workflows/recovery-assurance/continuity-slo-engine.js",
    "workflows/recovery-assurance/chaos-drill-simulator.js",
    "workflows/recovery-assurance/failover-readiness-validator.js",
    "scripts/create-recovery-checkpoint.js",
    "scripts/verify-backup-integrity.js",
    "scripts/execute-restore.js",
    "scripts/run-recovery-drill.js",
    "scripts/generate-phase11-artifacts.js",
    "scripts/verify-phase11-policy.sh"
  ].map((rel) => ({ rel, abs: path.join(rootDir, rel) }));
}

async function verifyPhase11StartupIntegrity(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const rootDir = typeof options.rootDir === "string" && options.rootDir.trim() ? options.rootDir : process.cwd();

  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    throw makeError("PHASE11_STARTUP_CONFIG_INVALID", "apiGovernance.readState is required for startup checks");
  }
  if (typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE11_STARTUP_CONFIG_INVALID", "apiGovernance.withGovernanceTransaction is required for startup checks");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("PHASE11_STARTUP_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required for startup checks");
  }

  const failures = [];

  for (const file of requiredFiles(rootDir)) {
    if (!fs.existsSync(file.abs)) {
      failures.push({ check: "required_file", file: file.rel, reason: "missing" });
    }
  }

  try {
    const schema = getRecoverySchema();
    if (!schema || !schema.entities || !schema.entities.restore_request) {
      failures.push({ check: "recovery_schema", reason: "invalid_schema_shape" });
    }
  } catch (error) {
    failures.push({ check: "recovery_schema", reason: error && error.message ? error.message : String(error) });
  }

  try {
    const checkpointCoordinator = createCheckpointCoordinator({
      apiGovernance,
      logger,
      timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
    });
    const checkpointResult = await checkpointCoordinator.createCheckpoint({
      rootDir,
      timestamp: "2026-03-05T00:00:00.000Z",
      runtime_state: await apiGovernance.readState()
    });

    const manifestManager = createBackupManifestManager({ logger });
    const manifestResult = manifestManager.buildBackupManifest(checkpointResult.checkpoint);

    const verifier = createBackupIntegrityVerifier({ logger });
    const integrity = verifier.verifyBackupIntegrity({ manifest: manifestResult.manifest, rootDir });
    if (!integrity || typeof integrity.valid !== "boolean") {
      failures.push({ check: "backup_integrity", reason: "invalid_verifier_shape" });
    }

    const restore = createRestoreOrchestrator({
      apiGovernance,
      operatorAuthorization,
      logger,
      timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
    });
    const plan = restore.presentRestorePlan({
      request_id: "RST-startup-001",
      checkpoint_id: checkpointResult.checkpoint_id,
      manifest_id: manifestResult.manifest.manifest_id,
      requested_by: "startup-integrity"
    });
    if (!plan || !plan.plan || !plan.risk || !Array.isArray(plan.acceptance_criteria)) {
      failures.push({ check: "restore_orchestrator", reason: "invalid_plan_shape" });
    }

    const continuity = createContinuitySloEngine({ logger });
    const slo = continuity.evaluateContinuity({
      rto_actual_minutes: 25,
      rpo_actual_minutes: 10,
      backup_integrity_success_rate: 100,
      restore_drill_success_rate: 100
    });
    if (!slo || !Array.isArray(slo.breaches) || !Array.isArray(slo.alerts)) {
      failures.push({ check: "continuity_slo_engine", reason: "invalid_slo_shape" });
    }

    const simulator = createChaosDrillSimulator({ logger, timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" } });
    const drill = simulator.runDrill({ scenario: "component_failure" });
    if (!drill || !drill.drill_id || !drill.scenario) {
      failures.push({ check: "chaos_drill_simulator", reason: "invalid_drill_shape" });
    }

    const readinessValidator = createFailoverReadinessValidator({ logger });
    const readiness = readinessValidator.validateReadiness({
      timestamp: "2026-03-05T00:00:00.000Z",
      checkpoint_available: true,
      manifest_valid: true,
      restore_path_healthy: true,
      runbook_complete: true,
      recent_drill_successful: true
    });
    if (!readiness || typeof readiness.ready !== "boolean") {
      failures.push({ check: "failover_readiness", reason: "invalid_readiness_shape" });
    }
  } catch (error) {
    failures.push({
      check: "module_bootstrap",
      reason: error && error.message ? error.message : String(error)
    });
  }

  try {
    const artifactDir = path.resolve(options.recoveryArtifactPath || path.join(rootDir, "audit", "evidence", "recovery-assurance"));
    ensureWritableDirectory(artifactDir);
  } catch (error) {
    failures.push({ check: "recovery_artifact_path", reason: error && error.message ? error.message : String(error) });
  }

  const result = {
    healthy: failures.length === 0,
    failures
  };

  if (!result.healthy) {
    logger.error({ event: "phase11_startup_integrity_failed", failures: result.failures });
    return result;
  }

  logger.info({
    event: "phase11_startup_integrity_verified",
    checks: "all",
    healthy: true
  });

  return result;
}

module.exports = {
  verifyPhase11StartupIntegrity
};
