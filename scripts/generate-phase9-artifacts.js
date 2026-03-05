#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createApiGovernance } = require("../security/api-governance.js");
const { createComplianceMonitor } = require("../workflows/governance-automation/compliance-monitor.js");
const { createPolicyDriftDetector } = require("../workflows/governance-automation/policy-drift-detector.js");
const { createRemediationRecommender } = require("../workflows/governance-automation/remediation-recommender.js");
const { createOperatorOverrideLedger } = require("../workflows/governance-automation/operator-override-ledger.js");
const { createPhaseCompletenessValidator } = require("../workflows/governance-automation/phase-completeness-validator.js");
const {
  writeBaselineContracts,
  loadBaselineContracts,
  FROZEN_BASELINE_COMMIT,
  FROZEN_BASELINE_CI_RUN,
  FROZEN_HISTORICAL_RUN
} = require("../workflows/governance-automation/phase9-baseline-contracts.js");
const { canonicalJson, canonicalize, sha256 } = require("../workflows/governance-automation/common.js");

function parseArgs(argv) {
  const out = {
    rootDir: process.cwd(),
    outDir: path.resolve(process.cwd(), "audit/evidence/governance-automation")
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = args.rootDir;
  const outDir = args.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const baselineResult = writeBaselineContracts(rootDir, path.join(outDir, "phase9-baseline-contracts.json"));
  const baselines = loadBaselineContracts(rootDir, baselineResult.path);

  const monitor = createComplianceMonitor({ phaseBaselines: baselines });
  const governance = createApiGovernance();
  const runtimeState = await governance.readState();
  const complianceScan = monitor.scanComplianceState({ rootDir, state: runtimeState });

  const driftDetector = createPolicyDriftDetector({ baselineContracts: baselines });
  const driftScan = driftDetector.detectDrifts({ rootDir });

  const recommender = createRemediationRecommender({
    driftDetectionOutput: driftScan,
    phaseContracts: baselines
  });

  const recommendation = recommender.recommendRemediationDelta({
    rootDir,
    outputPath: path.join(outDir, "remediation-request.json"),
    driftDetectionOutput: driftScan
  });

  const overrideLedger = createOperatorOverrideLedger({
    apiGovernance: governance,
    operatorAuthorization: {
      consumeApprovalToken() {
        throw new Error("operatorAuthorization not used for integrity-only checks");
      }
    }
  });

  const overrideIntegrity = await overrideLedger.verifyOverrideLedgerIntegrity();
  const runtimeStateForLedger = await governance.readState();
  const overrideLedgerState = runtimeStateForLedger
    && runtimeStateForLedger.complianceGovernance
    && runtimeStateForLedger.complianceGovernance.operatorOverrideLedger
    ? runtimeStateForLedger.complianceGovernance.operatorOverrideLedger
    : { records: [], nextSequence: 0, chainHead: "" };

  const completenessValidator = createPhaseCompletenessValidator({ allPhaseBaselines: baselines });
  const completeness = completenessValidator.validatePhaseCompleteness({ rootDir });

  const policyGateRun = spawnSync("bash", ["scripts/verify-phase9-policy.sh", "--root", rootDir], {
    cwd: rootDir,
    encoding: "utf8"
  });

  const policyGateResults = canonicalize({
    baseline_commit: FROZEN_BASELINE_COMMIT,
    baseline_ci_run: FROZEN_BASELINE_CI_RUN,
    historical_run: FROZEN_HISTORICAL_RUN,
    command: `bash scripts/verify-phase9-policy.sh --root ${rootDir}`,
    status: policyGateRun.status,
    passed: policyGateRun.status === 0,
    stdout: String(policyGateRun.stdout || "").trim(),
    stderr: String(policyGateRun.stderr || "").trim()
  });

  const files = {
    "compliance-scan-results.json": complianceScan,
    "drift-detection-results.json": driftScan,
    "remediation-recommendations.json": recommendation.recommendation,
    "override-ledger-sample.json": canonicalize({
      integrity: overrideIntegrity,
      ledger: overrideLedgerState
    }),
    "phase-completeness-status.json": completeness,
    "phase9-policy-gate-results.json": policyGateResults
  };

  for (const [name, value] of Object.entries(files)) {
    writeCanonical(path.join(outDir, name), value);
  }

  const manifestFiles = [
    "phase9-baseline-contracts.json",
    ...Object.keys(files)
  ].sort((left, right) => left.localeCompare(right));

  const hashManifest = {
    baseline_commit: FROZEN_BASELINE_COMMIT,
    baseline_ci_run: FROZEN_BASELINE_CI_RUN,
    files: manifestFiles.map((name) => ({
      file: name,
      sha256: hashFile(path.join(outDir, name))
    }))
  };

  writeCanonical(path.join(outDir, "hash-manifest.json"), hashManifest);

  process.stdout.write(`${JSON.stringify({ ok: true, out_dir: outDir, files: [...manifestFiles, "hash-manifest.json"] }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
