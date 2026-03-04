"use strict";

const crypto = require("node:crypto");
const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const { ExperimentAssignmentRecordSchema, makeError, canonicalStringify } = require("./experiment-schema.js");
const {
  safeString,
  assertOperatorRole,
  assertKillSwitchOpen,
  consumeScopedApprovalToken,
  ensureExperimentGovernanceState,
  findExperimentBySequence,
  assertExperimentStatus,
  assertPreRegistrationLock,
  assertIdempotencyReplay
} = require("./experiment-validator.js");

const BUCKET_HASH_PREFIX = "phase7-bucket-v1|";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function computeDeterministicBucket(experimentSequence, draftSequence) {
  const digest = sha256(`${BUCKET_HASH_PREFIX}${experimentSequence}|${draftSequence}`);
  const head = digest.slice(0, 8);
  const uint32 = Number.parseInt(head, 16) >>> 0;
  return uint32 % 10000;
}

function assertDependencies(apiGovernance, operatorAuthorization) {
  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("EXPERIMENT_ASSIGNMENT_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("EXPERIMENT_ASSIGNMENT_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required");
  }
}

function findDraftBySequence(state, draftSequence) {
  const workflows = state && state.rlhfWorkflows && typeof state.rlhfWorkflows === "object"
    ? state.rlhfWorkflows
    : {};
  const drafts = Array.isArray(workflows.drafts) ? workflows.drafts : [];
  const found = drafts.find((entry) => Number(entry.sequence) === Number(draftSequence));
  if (!found) {
    throw makeError("EXPERIMENT_ASSIGNMENT_DRAFT_NOT_FOUND", `Draft sequence '${draftSequence}' not found`);
  }
  return found;
}

function determineCohort(splitBasisPoints, bucket) {
  const split = splitBasisPoints && typeof splitBasisPoints === "object"
    ? splitBasisPoints
    : { control: 5000, treatment: 5000 };
  const controlBps = Math.max(0, Math.min(10000, Number.parseInt(String(split.control ?? "5000"), 10) || 5000));
  return bucket < controlBps ? "control" : "treatment";
}

function assignmentPayloadFingerprint(record) {
  return canonicalStringify({
    experimentSequence: Number(record.experimentSequence || 0),
    draftSequence: Number(record.draftSequence || 0),
    bucket: Number(record.bucket || 0),
    cohort: safeString(record.cohort),
    idempotencyKey: safeString(record.idempotencyKey)
  });
}

function createDeterministicAssignmentEngine(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  assertDependencies(apiGovernance, operatorAuthorization);

  async function assignDraftToExperiment(input = {}, context = {}) {
    assertOperatorRole(context);
    const correlationId = safeString(context.correlationId);
    const idempotencyKey = safeString(input.idempotencyKey);
    if (!idempotencyKey) {
      throw makeError("EXPERIMENT_ASSIGNMENT_IDEMPOTENCY_REQUIRED", "idempotencyKey is required for assignment writes");
    }

    consumeScopedApprovalToken(operatorAuthorization, input.approvalToken, "experiment.assign", { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureExperimentGovernanceState(state);
      assertKillSwitchOpen(state);

      const experiment = findExperimentBySequence(state, input.experimentSequence);
      assertExperimentStatus(experiment, ["running", "paused"]);
      assertPreRegistrationLock(experiment);
      findDraftBySequence(state, input.draftSequence);

      const assignments = state.experimentGovernance.assignments;
      const byKey = assignments.find((entry) => safeString(entry.idempotencyKey) === idempotencyKey) || null;
      const byPair = assignments.find((entry) => (
        Number(entry.experimentSequence) === Number(input.experimentSequence)
        && Number(entry.draftSequence) === Number(input.draftSequence)
      )) || null;

      if (byKey) {
        const expectedPayload = assignmentPayloadFingerprint(byKey);
        const currentPayload = assignmentPayloadFingerprint({
          experimentSequence: Number(input.experimentSequence),
          draftSequence: Number(input.draftSequence),
          bucket: Number(byKey.bucket),
          cohort: byKey.cohort,
          idempotencyKey
        });
        if (expectedPayload !== currentPayload) {
          throw makeError("EXPERIMENT_ASSIGNMENT_IDEMPOTENCY_CONFLICT", "Assignment idempotency key reused with divergent payload", {
            idempotencyKey
          });
        }
        assertIdempotencyReplay(
          {
            experimentSequence: Number(byKey.experimentSequence),
            draftSequence: Number(byKey.draftSequence),
            bucket: Number(byKey.bucket),
            cohort: byKey.cohort,
            idempotencyKey: byKey.idempotencyKey
          },
          {
            experimentSequence: Number(input.experimentSequence),
            draftSequence: Number(input.draftSequence),
            bucket: Number(byKey.bucket),
            cohort: byKey.cohort,
            idempotencyKey
          },
          "assignment"
        );
        return {
          ok: true,
          idempotent: true,
          assignment: ExperimentAssignmentRecordSchema.parse(byKey)
        };
      }

      if (byPair) {
        throw makeError("EXPERIMENT_ASSIGNMENT_IMMUTABLE", "Assignment is immutable once persisted", {
          experimentSequence: Number(input.experimentSequence),
          draftSequence: Number(input.draftSequence)
        });
      }

      state.experimentGovernance.nextAssignmentSequence = Math.max(
        Number(state.experimentGovernance.nextAssignmentSequence || 0),
        assignments.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0)
      ) + 1;

      const bucket = computeDeterministicBucket(Number(input.experimentSequence), Number(input.draftSequence));
      const cohort = determineCohort(experiment.splitBasisPoints, bucket);
      const assignment = ExperimentAssignmentRecordSchema.parse({
        sequence: Number(state.experimentGovernance.nextAssignmentSequence),
        experimentSequence: Number(input.experimentSequence),
        draftSequence: Number(input.draftSequence),
        assignedAt: String(timeProvider.nowIso()),
        assignedBy: safeString(context.requester) || "operator",
        bucket,
        cohort,
        idempotencyKey
      });

      assignments.push(assignment);
      assignments.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

      return {
        ok: true,
        idempotent: false,
        assignment
      };
    }, { correlationId });
  }

  return Object.freeze({
    assignDraftToExperiment,
    computeDeterministicBucket
  });
}

module.exports = {
  BUCKET_HASH_PREFIX,
  computeDeterministicBucket,
  createDeterministicAssignmentEngine
};
