#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createApiGovernance } = require("../security/api-governance.js");
const { createOperatorAuthorization } = require("../security/operator-authorization.js");
const { canonicalize, canonicalJson, sha256 } = require("../workflows/governance-automation/common.js");
const { getRecoverySchema } = require("../workflows/recovery-assurance/recovery-schema.js");
const { createCheckpointCoordinator } = require("../workflows/recovery-assurance/checkpoint-coordinator.js");
const { createBackupManifestManager } = require("../workflows/recovery-assurance/backup-manifest-manager.js");
const { createBackupIntegrityVerifier } = require("../workflows/recovery-assurance/backup-integrity-verifier.js");
const { createRestoreOrchestrator } = require("../workflows/recovery-assurance/restore-orchestrator.js");
const { createContinuitySloEngine } = require("../workflows/recovery-assurance/continuity-slo-engine.js");
const { createChaosDrillSimulator } = require("../workflows/recovery-assurance/chaos-drill-simulator.js");
const { createFailoverReadinessValidator } = require("../workflows/recovery-assurance/failover-readiness-validator.js");

function parseArgs(argv) {
  const out = {
    rootDir: process.cwd(),
    outDir: path.resolve(process.cwd(), "audit", "evidence", "recovery-assurance")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--root") {
      out.rootDir = path.resolve(String(argv[index + 1] || out.rootDir));
      index += 1;
      continue;
    }
    if (token === "--out") {
      out.outDir = path.resolve(String(argv[index + 1] || out.outDir));
      index += 1;
      continue;
    }
  }

  return out;
}

function writeCanonical(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(value), "utf8");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath, "utf8"));
}

function fixedTimeProvider() {
  return {
    nowIso() {
      return "2026-03-05T00:00:00.000Z";
    }
  };
}

function fixedNowMsFactory() {
  let current = 1772668800000;
  return () => {
    const value = current;
    current += 1000;
    return value;
  };
}

function makeHarness(rootDir) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-phase11-artifacts-"));
  const statePath = path.join(tmpDir, "state.json");
  const ndjsonPath = path.join(tmpDir, "research.ndjson");

  const apiGovernance = createApiGovernance({
    statePath,
    researchNdjsonPath: ndjsonPath,
    timeProvider: {
      nowMs: fixedNowMsFactory(),
      nowIso: fixedTimeProvider().nowIso
    }
  });
  const operatorAuthorization = createOperatorAuthorization({
    nowMs: fixedNowMsFactory()
  });

  return {
    rootDir,
    apiGovernance,
    operatorAuthorization,
    timeProvider: fixedTimeProvider()
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = args.rootDir;
  const outDir = args.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const harness = makeHarness(rootDir);

  const schema = getRecoverySchema();

  const checkpointCoordinator = createCheckpointCoordinator({
    apiGovernance: harness.apiGovernance,
    timeProvider: harness.timeProvider
  });

  const checkpointResult = await checkpointCoordinator.createCheckpoint({
    rootDir,
    timestamp: "2026-03-05T00:00:00.000Z",
    prev_checkpoint_hash: "",
    runtime_state: await harness.apiGovernance.readState()
  });

  const manifestManager = createBackupManifestManager({});
  const manifestResult = manifestManager.buildBackupManifest({
    ...checkpointResult.checkpoint,
    prev_manifest_hash: ""
  });

  const integrityVerifier = createBackupIntegrityVerifier({});
  const integrityResult = integrityVerifier.verifyBackupIntegrity({
    manifest: manifestResult.manifest,
    rootDir
  });

  const restoreOrchestrator = createRestoreOrchestrator({
    apiGovernance: harness.apiGovernance,
    operatorAuthorization: harness.operatorAuthorization,
    timeProvider: harness.timeProvider
  });

  const restoreRequest = {
    schema_version: "phase11-recovery-v1",
    request_id: "RST-20260305-001",
    checkpoint_id: checkpointResult.checkpoint_id,
    manifest_id: manifestResult.manifest.manifest_id,
    requested_by: "phase11-artifacts",
    requested_scope: "governance.recovery.restore",
    confirm_required: true,
    reason: "artifact_generation",
    restore_targets: ["workspace/runtime/state.json"],
    risk_tags: ["operational"]
  };

  const restorePlan = restoreOrchestrator.presentRestorePlan(restoreRequest);

  const restoreToken = harness.operatorAuthorization.issueApprovalToken({
    operatorId: "phase11-artifacts-operator",
    scope: "governance.recovery.restore"
  }).token;

  const restoreExecution = await restoreOrchestrator.executeRestore({
    restoreRequest,
    approvalToken: restoreToken,
    confirm: true
  }, {
    role: "operator",
    requester: "phase11-artifacts-operator",
    correlationId: "phase11-artifacts-restore",
    approvalToken: restoreToken,
    confirm: true
  });

  const continuity = createContinuitySloEngine({});
  const continuityResults = continuity.evaluateContinuity({
    rto_actual_minutes: 25,
    rpo_actual_minutes: 10,
    backup_integrity_success_rate: 100,
    restore_drill_success_rate: 100
  });

  const drillSimulator = createChaosDrillSimulator({ timeProvider: harness.timeProvider });
  const drillResults = drillSimulator.runDrill({
    scenario: "integrity_drift",
    checkpoint_id: checkpointResult.checkpoint_id,
    tabletop_mode: true
  });

  const readinessValidator = createFailoverReadinessValidator({});
  const readiness = readinessValidator.validateReadiness({
    timestamp: "2026-03-05T00:00:00.000Z",
    checkpoint_available: true,
    manifest_valid: true,
    restore_path_healthy: true,
    runbook_complete: true,
    recent_drill_successful: true
  });

  const policyGateRun = spawnSync("bash", ["scripts/verify-phase11-policy.sh", "--root", rootDir], {
    cwd: rootDir,
    encoding: "utf8"
  });
  const policyGateResult = canonicalize({
    command: `bash scripts/verify-phase11-policy.sh --root ${rootDir}`,
    status: Number(policyGateRun.status),
    passed: Number(policyGateRun.status) === 0,
    stdout: String(policyGateRun.stdout || "").trim(),
    stderr: String(policyGateRun.stderr || "").trim()
  });

  const files = {
    "recovery-schema.json": schema,
    "checkpoint-sample.json": checkpointResult.checkpoint,
    "backup-manifest-sample.json": manifestResult.manifest,
    "backup-integrity-results.json": integrityResult,
    "restore-plan-sample.json": restorePlan,
    "restore-execution-sample.json": restoreExecution,
    "continuity-slo-results.json": continuityResults,
    "chaos-drill-results.json": drillResults,
    "failover-readiness-report.json": readiness.report,
    "phase11-policy-gate-results.json": policyGateResult
  };

  for (const [name, value] of Object.entries(files)) {
    writeCanonical(path.join(outDir, name), value);
  }

  const orderedFiles = Object.keys(files).sort((left, right) => left.localeCompare(right));
  const hashManifest = canonicalize({
    files: orderedFiles.map((name) => ({
      file: name,
      sha256: hashFile(path.join(outDir, name))
    }))
  });

  writeCanonical(path.join(outDir, "hash-manifest.json"), hashManifest);

  process.stdout.write(`${JSON.stringify({ ok: true, out_dir: outDir, files: [...orderedFiles, "hash-manifest.json"] }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
