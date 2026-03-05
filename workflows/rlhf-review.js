"use strict";

const { nowIso } = require("../openclaw-bridge/core/time-provider.js");
const {
  RLHF_DRAFT_STATUSES,
  RlhfDraftRecordSchema,
  computeDraftContentHash,
  verifyDraftContentHash
} = require("./rlhf-generator/rlhf-schema.js");
const { getLegacyAccessBridge } = require("./access-control/legacy-access-bridge.js");

const ALLOWED_TRANSITIONS = Object.freeze({
  draft: "reviewed",
  reviewed: "approved_for_manual_submission",
  approved_for_manual_submission: "archived"
});

const TRANSITION_SCOPE_BY_STATUS = Object.freeze({
  reviewed: "rlhf.review.review",
  approved_for_manual_submission: "rlhf.review.approve_manual_submission",
  archived: "rlhf.review.archive"
});

function normalizeRole(context = {}) {
  return typeof context.role === "string" ? context.role.trim().toLowerCase() : "supervisor";
}

function normalizeNotes(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assertDependencies(apiGovernance, operatorAuthorization) {
  if (!apiGovernance || typeof apiGovernance.withGovernanceTransaction !== "function") {
    const error = new Error("apiGovernance.withGovernanceTransaction is required");
    error.code = "RLHF_REVIEW_CONFIG_INVALID";
    throw error;
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    const error = new Error("operatorAuthorization.consumeApprovalToken is required");
    error.code = "RLHF_REVIEW_CONFIG_INVALID";
    throw error;
  }
}

function findDraftBySequence(workflows, draftSequence) {
  return Array.isArray(workflows.drafts)
    ? workflows.drafts.find((draft) => Number(draft.sequence) === Number(draftSequence)) || null
    : null;
}

function createRlhfReviewWorkflow(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  assertDependencies(apiGovernance, operatorAuthorization);

  async function transitionStatus(input = {}, context = {}) {
    const role = normalizeRole(context);
    if (role === "supervisor") {
      const error = new Error("Supervisor cannot mutate RLHF draft review status");
      error.code = "RLHF_REVIEW_ROLE_DENIED";
      throw error;
    }
    if (role !== "operator") {
      const error = new Error("Only operator role can mutate RLHF draft review status");
      error.code = "RLHF_REVIEW_ROLE_DENIED";
      throw error;
    }

    const draftSequence = Number(input.draftSequence);
    const toStatus = String(input.toStatus || "").trim();
    if (!Number.isFinite(draftSequence) || draftSequence <= 0) {
      const error = new Error("draftSequence must be a positive integer");
      error.code = "RLHF_REVIEW_SEQUENCE_INVALID";
      throw error;
    }
    if (!RLHF_DRAFT_STATUSES.includes(toStatus)) {
      const error = new Error(`Unsupported status '${toStatus}'`);
      error.code = "RLHF_REVIEW_STATUS_INVALID";
      throw error;
    }

    const scope = TRANSITION_SCOPE_BY_STATUS[toStatus];
    if (!scope) {
      const error = new Error(`No scope is defined for status '${toStatus}'`); // should never happen due status validation
      error.code = "RLHF_REVIEW_SCOPE_UNDEFINED";
      throw error;
    }
    if (typeof input.approvalToken === "string" && input.approvalToken.trim()) {
      const legacyBridge = getLegacyAccessBridge();
      const legacyAccess = legacyBridge.evaluateLegacyAccess({
        approvalToken: input.approvalToken,
        scope,
        role: normalizeRole(context),
        action: "legacy.execute",
        resource: "rlhf.review",
        caller: "legacy.rlhf.review.transition",
        correlationId: typeof context.correlationId === "string" ? context.correlationId : ""
      });
      if (!legacyAccess.allowed) {
        const error = new Error("Phase 13 boundary denied legacy RLHF review transition");
        error.code = "RLHF_REVIEW_ACCESS_DENIED";
        error.details = { reason: legacyAccess.reason };
        throw error;
      }
    }
    const tokenResult = operatorAuthorization.consumeApprovalToken(input.approvalToken, scope, {
      correlationId: typeof context.correlationId === "string" ? context.correlationId : ""
    });

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      const workflows = state.rlhfWorkflows;
      const draft = findDraftBySequence(workflows, draftSequence);
      if (!draft) {
        const error = new Error(`Draft sequence '${draftSequence}' not found`);
        error.code = "RLHF_REVIEW_DRAFT_NOT_FOUND";
        throw error;
      }

      verifyDraftContentHash(draft);

      const expectedNext = ALLOWED_TRANSITIONS[draft.status] || null;
      if (!expectedNext || expectedNext !== toStatus) {
        const error = new Error(`Invalid status transition '${draft.status}' -> '${toStatus}'`);
        error.code = "RLHF_REVIEW_TRANSITION_INVALID";
        error.details = {
          from: draft.status,
          to: toStatus,
          allowed: expectedNext
        };
        throw error;
      }

      draft.status = toStatus;
      draft.reviewedBy = tokenResult.operatorId || (typeof context.requester === "string" ? context.requester : "operator");
      draft.reviewedAt = String(timeProvider.nowIso());
      draft.notes = normalizeNotes(input.notes);
      draft.aiAssisted = true;
      draft.manualSubmissionRequired = true;
      draft.contentHash = computeDraftContentHash({
        sequence: draft.sequence,
        sourcePaperId: draft.sourcePaperId,
        sourceHash: draft.sourceHash,
        domainTag: draft.domainTag,
        complexityScore: draft.complexityScore,
        monetizationScore: draft.monetizationScore,
        generatedAt: draft.generatedAt,
        generatorVersion: draft.generatorVersion,
        status: draft.status,
        aiAssisted: draft.aiAssisted,
        reviewedBy: draft.reviewedBy,
        reviewedAt: draft.reviewedAt,
        notes: draft.notes,
        manualSubmissionRequired: draft.manualSubmissionRequired
      });
      RlhfDraftRecordSchema.parse(draft);

      if (Array.isArray(workflows.reviewQueue)) {
        const queueItem = workflows.reviewQueue.find((item) => Number(item.draftSequence) === draftSequence);
        if (queueItem) {
          queueItem.status = toStatus;
          queueItem.updatedAt = draft.reviewedAt;
          queueItem.notes = draft.notes;
        }
      }

      return {
        ok: true,
        draft: {
          ...draft
        }
      };
    }, {
      correlationId: typeof context.correlationId === "string" ? context.correlationId : ""
    });
  }

  return Object.freeze({
    transitionStatus,
    allowedTransitions: ALLOWED_TRANSITIONS
  });
}

module.exports = {
  createRlhfReviewWorkflow,
  ALLOWED_TRANSITIONS
};
