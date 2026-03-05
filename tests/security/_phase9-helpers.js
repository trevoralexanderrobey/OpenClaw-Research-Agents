"use strict";

const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createOperatorAuthorization } = require("../../security/operator-authorization.js");
const { createComplianceMonitor } = require("../../workflows/governance-automation/compliance-monitor.js");
const { createPolicyDriftDetector } = require("../../workflows/governance-automation/policy-drift-detector.js");
const { createRemediationRecommender } = require("../../workflows/governance-automation/remediation-recommender.js");
const { createOperatorOverrideLedger } = require("../../workflows/governance-automation/operator-override-ledger.js");
const { createPhaseCompletenessValidator } = require("../../workflows/governance-automation/phase-completeness-validator.js");
const { buildBaselineContracts } = require("../../workflows/governance-automation/phase9-baseline-contracts.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase9-"));
}

function fixedTimeProvider() {
  let current = Date.parse("2026-03-05T02:00:00.000Z");
  return {
    nowMs() {
      const value = current;
      current += 1000;
      return value;
    },
    nowIso() {
      return new Date(this.nowMs()).toISOString();
    }
  };
}

async function setupPhase9Harness(rootDir = path.resolve(__dirname, "../..")) {
  const dir = await makeTmpDir();
  const timeProvider = fixedTimeProvider();

  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    timeProvider
  });

  const authorization = createOperatorAuthorization({
    nowMs: () => Date.parse("2026-03-05T02:00:00.000Z")
  });

  const baselines = buildBaselineContracts(rootDir);
  const monitor = createComplianceMonitor({ phaseBaselines: baselines });
  const driftDetector = createPolicyDriftDetector({ baselineContracts: baselines });
  const recommender = createRemediationRecommender({ phaseContracts: baselines });
  const overrideLedger = createOperatorOverrideLedger({
    apiGovernance: governance,
    operatorAuthorization: authorization,
    timeProvider
  });
  const completenessValidator = createPhaseCompletenessValidator({ allPhaseBaselines: baselines });

  return {
    dir,
    rootDir,
    baselines,
    governance,
    authorization,
    monitor,
    driftDetector,
    recommender,
    overrideLedger,
    completenessValidator
  };
}

function issueToken(authorization, scope) {
  return authorization.issueApprovalToken({
    operatorId: "op-1",
    scope
  }).token;
}

module.exports = {
  setupPhase9Harness,
  issueToken
};
