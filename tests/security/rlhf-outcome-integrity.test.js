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
const { computeOutcomeHash, CHAIN_ZERO_HASH } = require("../../workflows/rlhf-outcomes/outcome-schema.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase6-outcome-integrity-"));
}

async function seedDraft(governance) {
  await governance.withGovernanceTransaction(async (tx) => {
    const draftWithoutHash = {
      sequence: 1,
      sourcePaperId: "paper-integrity",
      sourceHash: "b".repeat(64),
      domainTag: "security",
      complexityScore: 80,
      monetizationScore: 40,
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
  const artifactPath = path.join(dir, "outcomes.ndjson");
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  await seedDraft(governance);
  const authorization = createOperatorAuthorization();
  const workflow = createOutcomeCaptureWorkflow({
    apiGovernance: governance,
    operatorAuthorization: authorization,
    artifactPath
  });
  return { dir, artifactPath, governance, authorization, workflow };
}

async function insertOneOutcome(workflow, authorization) {
  const token = authorization.issueApprovalToken({
    operatorId: "op-1",
    scope: "rlhf.outcomes.record"
  }).token;
  return workflow.recordOutcome({
    draftSequence: 1,
    result: "accepted",
    score: 94,
    manualSubmissionConfirmed: true,
    idempotencyKey: "integrity-1",
    approvalToken: token
  }, { role: "operator", correlationId: "aaaa1111aaaa1111" });
}

test("outcome hash remains stable across replay", () => {
  const payload = {
    sequence: 1,
    draftSequence: 1,
    idempotencyKey: "stable-1",
    enteredAt: "2026-03-04T00:00:00.000Z",
    enteredBy: "op-1",
    aiAssisted: true,
    manualSubmissionConfirmed: true,
    result: "accepted",
    score: 90,
    feedbackTags: [],
    notes: "",
    evidenceHash: "",
    outcomeVersion: "v1"
  };
  const first = computeOutcomeHash(payload);
  const second = computeOutcomeHash(payload);
  assert.equal(first, second);
});

test("chain tamper detection fails closed", async () => {
  const { workflow, authorization, artifactPath } = await setup();
  await insertOneOutcome(workflow, authorization);
  await fsp.appendFile(artifactPath, "{\"corrupted\": ", "utf8");

  await assert.rejects(
    () => workflow.verifyOutcomeChainIntegrity(),
    (error) => error && error.code === "RLHF_OUTCOME_ARTIFACT_CORRUPTED"
  );
});

test("startup chain-head anchor mismatch fails closed", async () => {
  const { workflow, authorization, governance } = await setup();
  await insertOneOutcome(workflow, authorization);

  await governance.withGovernanceTransaction(async (tx) => {
    tx.state.rlhfOutcomes.chainHeadHash = CHAIN_ZERO_HASH;
    tx.state.rlhfOutcomes.chainHeadSequence = 0;
  });

  await assert.rejects(
    () => workflow.verifyOutcomeChainIntegrity(),
    (error) => error && error.code === "RLHF_OUTCOME_STATE_CHAIN_INVALID"
  );
});

test("repairOutcomeArtifactTail repairs truncated trailing line and preserves chain", async () => {
  const { workflow, authorization, artifactPath } = await setup();
  await insertOneOutcome(workflow, authorization);
  await fsp.appendFile(artifactPath, "{\"truncated\": ", "utf8");

  const repairToken = authorization.issueApprovalToken({
    operatorId: "op-1",
    scope: "rlhf.outcomes.repair"
  }).token;
  const repaired = await workflow.repairOutcomeArtifactTail({
    approvalToken: repairToken
  }, {
    role: "operator",
    correlationId: "bbbb2222bbbb2222"
  });
  assert.equal(repaired.repaired, true);

  const integrity = await workflow.verifyOutcomeChainIntegrity();
  assert.equal(integrity.ok, true);
  assert.equal(integrity.stateCount, 1);
});
