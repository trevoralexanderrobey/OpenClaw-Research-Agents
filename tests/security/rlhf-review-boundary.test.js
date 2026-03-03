"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createOperatorAuthorization } = require("../../security/operator-authorization.js");
const { createRlhfReviewWorkflow } = require("../../workflows/rlhf-review.js");
const { computeDraftContentHash } = require("../../workflows/rlhf-generator/rlhf-schema.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase5-review-"));
}

async function seedDraft(governance) {
  await governance.withGovernanceTransaction(async (tx) => {
    const draftWithoutHash = {
      sequence: 1,
      sourcePaperId: "paper-review",
      sourceHash: "d".repeat(64),
      domainTag: "security",
      complexityScore: 70,
      monetizationScore: 40,
      generatedAt: "2026-03-03T00:00:00.000Z",
      generatorVersion: "v1",
      status: "draft",
      aiAssisted: true,
      reviewedBy: null,
      reviewedAt: null,
      notes: "",
      manualSubmissionRequired: true
    };

    tx.state.rlhfWorkflows.drafts.push({
      ...draftWithoutHash,
      contentHash: computeDraftContentHash(draftWithoutHash)
    });
    tx.state.rlhfWorkflows.nextDraftSequence = 1;
    tx.state.rlhfWorkflows.nextQueueSequence = 1;
    tx.state.rlhfWorkflows.reviewQueue.push({
      queueSequence: 1,
      draftSequence: 1,
      status: "pending_review",
      enqueuedAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z",
      notes: ""
    });
  });
}

test("supervisor cannot change RLHF draft status", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  await seedDraft(governance);

  const auth = createOperatorAuthorization();
  const review = createRlhfReviewWorkflow({ apiGovernance: governance, operatorAuthorization: auth });

  const token = auth.issueApprovalToken({ operatorId: "op-1", scope: "rlhf.review.review" }).token;
  await assert.rejects(
    () => review.transitionStatus({ draftSequence: 1, toStatus: "reviewed", approvalToken: token }, { role: "supervisor" }),
    (error) => error && error.code === "RLHF_REVIEW_ROLE_DENIED"
  );
});

test("operator-only transitions are enforced and invalid transition is rejected", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  await seedDraft(governance);

  const auth = createOperatorAuthorization();
  const review = createRlhfReviewWorkflow({ apiGovernance: governance, operatorAuthorization: auth });

  const reviewToken = auth.issueApprovalToken({ operatorId: "op-1", scope: "rlhf.review.review" }).token;
  const reviewed = await review.transitionStatus(
    { draftSequence: 1, toStatus: "reviewed", approvalToken: reviewToken, notes: "checked" },
    { role: "operator", requester: "operator" }
  );
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.draft.status, "reviewed");

  const invalidToken = auth.issueApprovalToken({ operatorId: "op-1", scope: "rlhf.review.archive" }).token;
  await assert.rejects(
    () => review.transitionStatus({ draftSequence: 1, toStatus: "archived", approvalToken: invalidToken }, { role: "operator" }),
    (error) => error && error.code === "RLHF_REVIEW_TRANSITION_INVALID"
  );

  const approveToken = auth.issueApprovalToken({ operatorId: "op-1", scope: "rlhf.review.approve_manual_submission" }).token;
  const approved = await review.transitionStatus(
    { draftSequence: 1, toStatus: "approved_for_manual_submission", approvalToken: approveToken },
    { role: "operator", requester: "operator" }
  );
  assert.equal(approved.ok, true);
  assert.equal(approved.draft.status, "approved_for_manual_submission");
});

test("review transition denies scope mismatch", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  await seedDraft(governance);

  const auth = createOperatorAuthorization();
  const review = createRlhfReviewWorkflow({ apiGovernance: governance, operatorAuthorization: auth });

  const wrongScopeToken = auth.issueApprovalToken({
    operatorId: "op-1",
    scope: "rlhf.review.approve_manual_submission"
  }).token;

  await assert.rejects(
    () => review.transitionStatus({ draftSequence: 1, toStatus: "reviewed", approvalToken: wrongScopeToken }, { role: "operator" }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
});
