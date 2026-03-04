"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createMcpService } = require("../../openclaw-bridge/mcp/mcp-service.js");

const {
  setupPhase7Harness,
  issueToken,
  createAndStartExperiment
} = require("./_phase7-helpers.js");

const {
  verifyPhase7StartupIntegrity
} = require("../../security/phase7-startup-integrity.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase7-startup-"));
}

test("phase7 startup integrity succeeds for valid state", async () => {
  const harness = await setupPhase7Harness();
  const experiment = await createAndStartExperiment(harness);

  await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experiment.sequence),
    decision: "hold",
    reasonCode: "operator_override",
    idempotencyKey: "startup-ok"
  }, {
    role: "operator",
    requester: "op-1"
  });

  const verified = await verifyPhase7StartupIntegrity({
    apiGovernance: harness.governance,
    logger: { info() {}, warn() {}, error() {} }
  });

  assert.equal(verified.ok, true);
  assert.equal(verified.decisions, 1);
});

test("phase7 startup integrity fails closed on anchor mismatch", async () => {
  const harness = await setupPhase7Harness();
  const experiment = await createAndStartExperiment(harness);

  await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experiment.sequence),
    decision: "hold",
    reasonCode: "operator_override",
    idempotencyKey: "startup-bad-anchor"
  }, {
    role: "operator",
    requester: "op-1"
  });

  await harness.governance.withGovernanceTransaction(async (tx) => {
    tx.state.experimentGovernance.decisionLedger.chainHead = "f".repeat(64);
  });

  await assert.rejects(
    () => verifyPhase7StartupIntegrity({
      apiGovernance: harness.governance,
      logger: { info() {}, warn() {}, error() {} }
    }),
    (error) => error && error.code === "PHASE7_LEDGER_CHAIN_HEAD_MISMATCH"
  );
});

test("mcp service initialize fails before serving methods when phase7 startup integrity fails", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  await governance.withGovernanceTransaction(async (tx) => {
    tx.state.experimentGovernance.decisionLedger.chainHead = "a".repeat(64);
  });

  const service = createMcpService({ apiGovernance: governance });

  await assert.rejects(
    () => service.initialize(),
    (error) => error && error.code === "PHASE7_LEDGER_CHAIN_HEAD_MISMATCH"
  );

  await assert.rejects(
    () => service.handle("analytics.monetizationScore", {}, { correlationId: "phase7-startup-gate" }),
    (error) => error && error.code === "PHASE7_LEDGER_CHAIN_HEAD_MISMATCH"
  );
});
