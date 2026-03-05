"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const {
  ReleaseGateDecisionRecordWithoutHashSchema,
  ReleaseGateDecisionRecordSchema,
  makeError,
  computeReleaseDecisionHash
} = require("./compliance-schema.js");
const {
  verifyEvidenceBundleIntegrity
} = require("./evidence-bundle-builder.js");
const {
  buildExpectedComplianceLedgerFromDecisions,
  verifyComplianceDecisionIntegrity,
  repairTruncatedComplianceLedgerTail
} = require("./compliance-decision-ledger.js");
const {
  safeString,
  assertOperatorRole,
  assertKillSwitchOpen,
  consumeScopedApprovalToken,
  ensureComplianceGovernanceState,
  normalizeDecision,
  normalizeReasonCode,
  normalizeAsOfIso,
  buildPolicySnapshotHash,
  getLatestBySequence,
  normalizeRequiredChecks,
  computeFreshnessHours,
  buildReleaseGateIdempotencyFingerprint
} = require("./compliance-validator.js");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function findLatestBundle(state) {
  const bundles = asArray(state && state.complianceGovernance && state.complianceGovernance.evidenceBundles);
  return getLatestBySequence(bundles);
}

function collectMissingRequiredChecks(bundle, requiredChecks) {
  const results = bundle && bundle.checkResults && typeof bundle.checkResults === "object" ? bundle.checkResults : {};
  return requiredChecks
    .filter((name) => safeString(results[name]).toLowerCase() !== "pass")
    .sort((left, right) => left.localeCompare(right));
}

function createReleaseGateGovernor(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE8_RELEASE_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("PHASE8_RELEASE_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required");
  }

  async function evaluateReleaseGate(input = {}) {
    const state = await apiGovernance.readState();
    ensureComplianceGovernanceState(state);

    const policy = state.complianceGovernance.activeReleasePolicy;
    const policySnapshotHash = buildPolicySnapshotHash(policy);
    const requiredChecks = normalizeRequiredChecks(policy.requiredChecks);
    const latestBundle = findLatestBundle(state);
    const asOfIso = normalizeAsOfIso(input.asOfIso) || String(timeProvider.nowIso());

    if (!latestBundle) {
      return {
        ok: true,
        decision: "block",
        reasonCode: "missing_evidence",
        targetRef: safeString(input.targetRef),
        targetSha: safeString(input.targetSha).toLowerCase(),
        asOfIso,
        policySnapshotHash,
        missingChecks: requiredChecks,
        freshnessHours: null,
        evidenceSequence: null,
        evidenceHash: ""
      };
    }

    try {
      verifyEvidenceBundleIntegrity({ bundle: latestBundle });
    } catch (error) {
      return {
        ok: true,
        decision: "block",
        reasonCode: "integrity_mismatch",
        targetRef: safeString(input.targetRef),
        targetSha: safeString(input.targetSha).toLowerCase(),
        asOfIso,
        policySnapshotHash,
        missingChecks: requiredChecks,
        freshnessHours: null,
        evidenceSequence: Number(latestBundle.sequence),
        evidenceHash: safeString(latestBundle.bundleHash)
      };
    }

    const missingChecks = collectMissingRequiredChecks(latestBundle, requiredChecks);
    if (missingChecks.length > 0) {
      return {
        ok: true,
        decision: "block",
        reasonCode: "missing_evidence",
        targetRef: safeString(input.targetRef),
        targetSha: safeString(input.targetSha).toLowerCase(),
        asOfIso,
        policySnapshotHash,
        missingChecks,
        freshnessHours: Number(latestBundle.freshnessHours || 0),
        evidenceSequence: Number(latestBundle.sequence),
        evidenceHash: safeString(latestBundle.bundleHash)
      };
    }

    const freshnessHours = computeFreshnessHours(asOfIso, safeString(latestBundle.asOfIso));
    const minFreshnessHours = Math.max(1, Number(policy.minEvidenceFreshnessHours || 24));
    if (freshnessHours > minFreshnessHours) {
      return {
        ok: true,
        decision: "hold",
        reasonCode: "policy_violation",
        targetRef: safeString(input.targetRef),
        targetSha: safeString(input.targetSha).toLowerCase(),
        asOfIso,
        policySnapshotHash,
        missingChecks: [],
        freshnessHours,
        evidenceSequence: Number(latestBundle.sequence),
        evidenceHash: safeString(latestBundle.bundleHash)
      };
    }

    return {
      ok: true,
      decision: "allow",
      reasonCode: "all_checks_passed",
      targetRef: safeString(input.targetRef),
      targetSha: safeString(input.targetSha).toLowerCase(),
      asOfIso,
      policySnapshotHash,
      missingChecks: [],
      freshnessHours,
      evidenceSequence: Number(latestBundle.sequence),
      evidenceHash: safeString(latestBundle.bundleHash)
    };
  }

  async function applyReleaseGateDecision(input = {}, context = {}) {
    assertOperatorRole(context);

    const correlationId = safeString(context.correlationId);
    const idempotencyKey = safeString(input.idempotencyKey);
    if (!idempotencyKey) {
      throw makeError("PHASE8_RELEASE_IDEMPOTENCY_REQUIRED", "idempotencyKey is required for release-gate apply");
    }

    consumeScopedApprovalToken(operatorAuthorization, input.approvalToken, "compliance.release.apply", { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureComplianceGovernanceState(state);
      assertKillSwitchOpen(state);

      const decisions = state.complianceGovernance.releaseGates;
      const existing = decisions.find((entry) => safeString(entry.idempotencyKey) === idempotencyKey) || null;
      if (existing) {
        const requestedTargetRef = safeString(input.targetRef) || safeString(existing.targetRef);
        const requestedTargetSha = safeString(input.targetSha).toLowerCase() || safeString(existing.targetSha).toLowerCase();
        const requestedDecision = normalizeDecision(input.decision || existing.decision);
        const requestedReasonCode = normalizeReasonCode(input.reasonCode || existing.reasonCode);
        const requestedAsOfIso = Object.prototype.hasOwnProperty.call(input, "asOfIso")
          ? normalizeAsOfIso(input.asOfIso)
          : normalizeAsOfIso(existing.asOfIso);
        const requestedPolicySnapshotHash = safeString(existing.policySnapshotHash).toLowerCase()
          || buildPolicySnapshotHash(state.complianceGovernance.activeReleasePolicy);

        const fingerprint = buildReleaseGateIdempotencyFingerprint({
          targetRef: requestedTargetRef,
          targetSha: requestedTargetSha,
          decision: requestedDecision,
          reasonCode: requestedReasonCode,
          asOfIso: requestedAsOfIso,
          policySnapshotHash: requestedPolicySnapshotHash
        });
        const existingFingerprint = buildReleaseGateIdempotencyFingerprint({
          targetRef: existing.targetRef,
          targetSha: existing.targetSha,
          decision: existing.decision,
          reasonCode: existing.reasonCode,
          asOfIso: existing.asOfIso,
          policySnapshotHash: existing.policySnapshotHash
        });
        if (existingFingerprint !== fingerprint) {
          throw makeError("PHASE8_RELEASE_IDEMPOTENCY_CONFLICT", "Release-gate idempotency key reused with divergent payload", {
            idempotencyKey
          });
        }
        return {
          ok: true,
          idempotent: true,
          decision: ReleaseGateDecisionRecordSchema.parse(existing),
          recommendation: {
            decision: existing.decision,
            reasonCode: existing.reasonCode,
            targetRef: existing.targetRef,
            targetSha: existing.targetSha,
            asOfIso: existing.asOfIso,
            policySnapshotHash: existing.policySnapshotHash
          }
        };
      }

      const recommendation = await evaluateReleaseGate({
        targetRef: input.targetRef,
        targetSha: input.targetSha,
        asOfIso: input.asOfIso
      });

      const decision = normalizeDecision(input.decision || recommendation.decision);
      const reasonCode = normalizeReasonCode(input.reasonCode || recommendation.reasonCode);
      if (decision === "allow" && recommendation.decision !== "allow") {
        throw makeError("PHASE8_RELEASE_ALLOW_POLICY_VIOLATION", "allow decision requires all checks and fresh evidence", {
          recommendation: recommendation.decision,
          recommendationReasonCode: recommendation.reasonCode
        });
      }

      const targetRef = safeString(input.targetRef);
      const targetSha = safeString(input.targetSha).toLowerCase();
      if (!targetRef) {
        throw makeError("PHASE8_RELEASE_TARGET_REQUIRED", "targetRef is required");
      }
      if (!/^[a-f0-9]{64}$/.test(targetSha)) {
        throw makeError("PHASE8_RELEASE_TARGET_SHA_INVALID", "targetSha must be a 64-char sha256 hex string");
      }

      const policySnapshotHash = safeString(recommendation.policySnapshotHash).toLowerCase();
      const asOfIso = normalizeAsOfIso(input.asOfIso || recommendation.asOfIso);

      const sequence = Math.max(
        Number(state.complianceGovernance.nextReleaseGateSequence || 0),
        decisions.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0)
      ) + 1;
      const prevDecisionHash = decisions.length === 0 ? "" : safeString(decisions[decisions.length - 1].decisionHash);

      const baseDecision = ReleaseGateDecisionRecordWithoutHashSchema.parse({
        sequence,
        decidedAt: String(timeProvider.nowIso()),
        decidedBy: safeString(context.requester) || "operator",
        targetRef,
        targetSha,
        decision,
        reasonCode,
        approvalToken: safeString(input.approvalToken),
        idempotencyKey,
        prevDecisionHash,
        asOfIso,
        policySnapshotHash
      });

      const persistedDecision = ReleaseGateDecisionRecordSchema.parse({
        ...baseDecision,
        decisionHash: computeReleaseDecisionHash(baseDecision)
      });

      decisions.push(persistedDecision);
      decisions.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

      const expectedLedger = buildExpectedComplianceLedgerFromDecisions(decisions);
      state.complianceGovernance.decisionLedger = {
        records: expectedLedger.records,
        nextSequence: expectedLedger.nextSequence,
        chainHead: expectedLedger.chainHead
      };
      state.complianceGovernance.nextReleaseGateSequence = Math.max(
        Number(state.complianceGovernance.nextReleaseGateSequence || 0),
        Number(persistedDecision.sequence)
      );

      verifyComplianceDecisionIntegrity(state);

      logger.info({
        correlationId,
        event: "phase8_release_gate_decision_applied",
        sequence: persistedDecision.sequence,
        decisionHash: persistedDecision.decisionHash,
        decision: persistedDecision.decision
      });

      return {
        ok: true,
        idempotent: false,
        decision: persistedDecision,
        recommendation
      };
    }, { correlationId });
  }

  async function repairComplianceLedgerTail(input = {}, context = {}) {
    assertOperatorRole(context);
    const correlationId = safeString(context.correlationId);
    consumeScopedApprovalToken(operatorAuthorization, input.approvalToken, "compliance.release.repair", { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureComplianceGovernanceState(state);
      assertKillSwitchOpen(state);
      const repaired = repairTruncatedComplianceLedgerTail(state);
      verifyComplianceDecisionIntegrity(state);
      return repaired;
    }, { correlationId });
  }

  return Object.freeze({
    evaluateReleaseGate,
    applyReleaseGateDecision,
    repairComplianceLedgerTail
  });
}

module.exports = {
  createReleaseGateGovernor,
  collectMissingRequiredChecks,
  findLatestBundle
};
