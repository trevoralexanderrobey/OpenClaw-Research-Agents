"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createOperatorAuthorization } = require("../../security/operator-authorization.js");
const { createOutcomeCaptureWorkflow } = require("../../workflows/rlhf-outcomes/outcome-capture.js");
const { computeDraftContentHash } = require("../../workflows/rlhf-generator/rlhf-schema.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase6-outcomes-"));
}

async function seedDraft(governance) {
  await governance.withGovernanceTransaction(async (tx) => {
    const draftWithoutHash = {
      sequence: 1,
      sourcePaperId: "paper-phase6",
      sourceHash: "a".repeat(64),
      domainTag: "security",
      complexityScore: 70,
      monetizationScore: 50,
      generatedAt: "2026-03-04T00:00:00.000Z",
      generatorVersion: "v1",
      status: "approved_for_manual_submission",
      aiAssisted: true,
      reviewedBy: "op-1",
      reviewedAt: "2026-03-04T00:00:00.000Z",
      notes: "",
      manualSubmissionRequired: true
    };
    tx.state.rlhfWorkflows.drafts.push({
      ...draftWithoutHash,
      contentHash: computeDraftContentHash(draftWithoutHash)
    });
    tx.state.rlhfWorkflows.nextDraftSequence = 1;
  });
}

async function setup() {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  await seedDraft(governance);

  const authorization = createOperatorAuthorization();
  const workflow = createOutcomeCaptureWorkflow({
    apiGovernance: governance,
    operatorAuthorization: authorization,
    artifactPath: path.join(dir, "outcomes.ndjson")
  });
  return { dir, governance, authorization, workflow };
}

function issueRecordToken(authorization) {
  return authorization.issueApprovalToken({
    operatorId: "op-1",
    scope: "rlhf.outcomes.record"
  }).token;
}

test("operator-only outcome write enforced and supervisor denied", async () => {
  const { workflow, authorization } = await setup();
  const token = issueRecordToken(authorization);

  await assert.rejects(
    () => workflow.recordOutcome({
      draftSequence: 1,
      result: "accepted",
      score: 95,
      manualSubmissionConfirmed: true,
      idempotencyKey: "capture-1",
      approvalToken: token
    }, { role: "supervisor", correlationId: "aaaa1111aaaa1111" }),
    (error) => error && error.code === "RLHF_OUTCOME_ROLE_DENIED"
  );
});

test("finalized outcome requires manual submission confirmation", async () => {
  const { workflow, authorization } = await setup();
  const token = issueRecordToken(authorization);
  await assert.rejects(
    () => workflow.recordOutcome({
      draftSequence: 1,
      result: "accepted",
      score: 99,
      manualSubmissionConfirmed: false,
      idempotencyKey: "capture-2",
      approvalToken: token
    }, { role: "operator", correlationId: "bbbb2222bbbb2222" }),
    (error) => error && error.code === "RLHF_OUTCOME_MANUAL_CONFIRMATION_REQUIRED"
  );
});

test("pending result enforces fixed score=0 and finalized score is bounded", async () => {
  const { workflow, authorization } = await setup();
  const pendingToken = issueRecordToken(authorization);
  const pending = await workflow.recordOutcome({
    draftSequence: 1,
    result: "pending",
    score: 88,
    manualSubmissionConfirmed: false,
    idempotencyKey: "capture-3",
    approvalToken: pendingToken
  }, { role: "operator", correlationId: "cccc3333cccc3333" });
  assert.equal(pending.record.score, 0);
  assert.equal(pending.record.result, "pending");

  const finalizedToken = issueRecordToken(authorization);
  const finalized = await workflow.recordOutcome({
    draftSequence: 1,
    result: "revise_requested",
    score: 150,
    manualSubmissionConfirmed: true,
    idempotencyKey: "capture-4",
    approvalToken: finalizedToken
  }, { role: "operator", correlationId: "dddd4444dddd4444" });
  assert.equal(finalized.record.score, 100);
});

test("idempotency replay returns existing record and conflicts on payload drift", async () => {
  const { workflow, authorization, governance } = await setup();
  const tokenA = issueRecordToken(authorization);
  const first = await workflow.recordOutcome({
    draftSequence: 1,
    result: "accepted",
    score: 97,
    manualSubmissionConfirmed: true,
    idempotencyKey: "capture-5",
    approvalToken: tokenA
  }, { role: "operator", correlationId: "eeee5555eeee5555" });
  assert.equal(first.idempotent, false);

  const tokenB = issueRecordToken(authorization);
  const replay = await workflow.recordOutcome({
    draftSequence: 1,
    result: "accepted",
    score: 97,
    manualSubmissionConfirmed: true,
    idempotencyKey: "capture-5",
    approvalToken: tokenB
  }, { role: "operator", correlationId: "ffff6666ffff6666" });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.record.sequence, first.record.sequence);

  const tokenC = issueRecordToken(authorization);
  await assert.rejects(
    () => workflow.recordOutcome({
      draftSequence: 1,
      result: "accepted",
      score: 65,
      manualSubmissionConfirmed: true,
      idempotencyKey: "capture-5",
      approvalToken: tokenC
    }, { role: "operator", correlationId: "9999aaaa9999aaaa" }),
    (error) => error && error.code === "RLHF_OUTCOME_IDEMPOTENCY_CONFLICT"
  );

  const state = await governance.readState();
  assert.equal(state.rlhfOutcomes.records.length, 1);
});

test("kill-switch denies recordOutcome mutation", async () => {
  const { workflow, authorization, governance } = await setup();
  await governance.withGovernanceTransaction(async (tx) => {
    tx.state.outboundMutation.killSwitch = true;
  });

  const token = issueRecordToken(authorization);
  await assert.rejects(
    () => workflow.recordOutcome({
      draftSequence: 1,
      result: "accepted",
      score: 80,
      manualSubmissionConfirmed: true,
      idempotencyKey: "capture-6",
      approvalToken: token
    }, { role: "operator", correlationId: "1010bbbb1010bbbb" }),
    (error) => error && error.code === "RLHF_OUTCOME_KILL_SWITCH_ACTIVE"
  );
});
