"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const crypto = require("node:crypto");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createOperatorAuthorization } = require("../../security/operator-authorization.js");
const {
  createCalibrationEngine,
  assertValidWeightSet
} = require("../../analytics/rlhf-quality/calibration-engine.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase6-calibration-"));
}

function hashFile(filePath) {
  const body = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(body).digest("hex");
}

test("calibration output is byte-identical for same inputs", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  const authorization = createOperatorAuthorization();
  const qualityScoreEngine = {
    async computeQualitySnapshot() {
      return {
        ok: true,
        asOfIso: "2026-03-04T12:00:00.000Z",
        totals: { draftCount: 4, outcomeCount: 4, finalizedCount: 4, pendingCount: 0 },
        monetizationSnapshotScore: 50,
        perDraft: [
          { draftSequence: 1, domainTag: "security", generatorVersion: "v1", templateVersion: "v1", result: "accepted", score: 90, qualitySignal: 90, complexityScore: 80, monetizationScore: 50, outcomeSequence: 1 },
          { draftSequence: 2, domainTag: "security", generatorVersion: "v1", templateVersion: "v1", result: "accepted", score: 85, qualitySignal: 86, complexityScore: 78, monetizationScore: 48, outcomeSequence: 2 },
          { draftSequence: 3, domainTag: "distributed-systems", generatorVersion: "v1", templateVersion: "v1", result: "rejected", score: 40, qualitySignal: 34, complexityScore: 70, monetizationScore: 35, outcomeSequence: 3 },
          { draftSequence: 4, domainTag: "distributed-systems", generatorVersion: "v1", templateVersion: "v1", result: "revise_requested", score: 60, qualitySignal: 58, complexityScore: 65, monetizationScore: 38, outcomeSequence: 4 }
        ],
        perDomain: [],
        perTemplate: [],
        qualityPriorByDomain: {}
      };
    }
  };

  const engine = createCalibrationEngine({
    apiGovernance: governance,
    qualityScoreEngine,
    operatorAuthorization: authorization
  });

  const first = await engine.computeCalibration({ asOfIso: "2026-03-04T12:00:00.000Z" });
  const second = await engine.computeCalibration({ asOfIso: "2026-03-04T12:00:00.000Z" });
  assert.deepEqual(first, second);
  assert.equal(first.noOp, false);
});

test("calibration rejects invalid weight configurations", () => {
  assert.throws(
    () => assertValidWeightSet({ complexity: 0.9, monetization: 0.9, qualitySignal: 0.9 }),
    (error) => error && error.code === "RLHF_CALIBRATION_WEIGHTS_INVALID"
  );
});

test("kill-switch denies calibration apply mutation", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  await governance.withGovernanceTransaction(async (tx) => {
    tx.state.outboundMutation.killSwitch = true;
  });
  const authorization = createOperatorAuthorization();
  const qualityScoreEngine = {
    async computeQualitySnapshot() {
      return {
        ok: true,
        asOfIso: "2026-03-04T12:00:00.000Z",
        totals: { draftCount: 0, outcomeCount: 0, finalizedCount: 0, pendingCount: 0 },
        monetizationSnapshotScore: 0,
        perDraft: [],
        perDomain: [],
        perTemplate: [],
        qualityPriorByDomain: {}
      };
    }
  };
  const engine = createCalibrationEngine({
    apiGovernance: governance,
    qualityScoreEngine,
    operatorAuthorization: authorization
  });
  const token = authorization.issueApprovalToken({
    operatorId: "op-1",
    scope: "rlhf.calibration.apply"
  }).token;

  await assert.rejects(
    () => engine.applyCalibration({ approvalToken: token }, { role: "operator", correlationId: "aaaa1111aaaa1111" }),
    (error) => error && error.code === "RLHF_CALIBRATION_KILL_SWITCH_ACTIVE"
  );
});

test("empty calibration window returns deterministic no-op without state drift", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  const governance = createApiGovernance({
    statePath,
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  const authorization = createOperatorAuthorization();
  const qualityScoreEngine = {
    async computeQualitySnapshot() {
      return {
        ok: true,
        asOfIso: "2026-03-04T12:00:00.000Z",
        totals: { draftCount: 1, outcomeCount: 1, finalizedCount: 0, pendingCount: 1 },
        monetizationSnapshotScore: 0,
        perDraft: [
          { draftSequence: 1, domainTag: "security", generatorVersion: "v1", templateVersion: "v1", result: "pending", score: 0, qualitySignal: 0, complexityScore: 70, monetizationScore: 40, outcomeSequence: 0 }
        ],
        perDomain: [],
        perTemplate: [],
        qualityPriorByDomain: {}
      };
    }
  };
  const engine = createCalibrationEngine({
    apiGovernance: governance,
    qualityScoreEngine,
    operatorAuthorization: authorization
  });
  const token = authorization.issueApprovalToken({
    operatorId: "op-1",
    scope: "rlhf.calibration.apply"
  }).token;

  await governance.withGovernanceTransaction(async () => {});
  const beforeHash = hashFile(statePath);
  const result = await engine.applyCalibration({ approvalToken: token }, { role: "operator", correlationId: "bbbb2222bbbb2222" });
  const afterHash = hashFile(statePath);

  assert.equal(result.noOp, true);
  assert.equal(beforeHash, afterHash);
});
