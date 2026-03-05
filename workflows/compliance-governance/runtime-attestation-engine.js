"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const {
  AttestationSnapshotWithoutHashSchema,
  AttestationSnapshotRecordSchema,
  computeAttestationHash,
  canonicalStringify,
  makeError,
  sha256
} = require("./compliance-schema.js");
const {
  safeString,
  assertOperatorRole,
  assertKillSwitchOpen,
  consumeScopedApprovalToken,
  ensureComplianceGovernanceState,
  assertIdempotencyReplay,
  buildPolicySnapshotHash
} = require("./compliance-validator.js");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeGateScripts(value) {
  const list = asArray(value)
    .map((entry) => ({
      name: safeString(entry && entry.name),
      sha256: safeString(entry && entry.sha256).toLowerCase()
    }))
    .filter((entry) => entry.name && /^[a-f0-9]{64}$/.test(entry.sha256));
  list.sort((left, right) => left.name.localeCompare(right.name));
  return list;
}

function normalizeModuleManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const pairs = Object.entries(value)
    .map(([name, digest]) => [safeString(name), safeString(digest).toLowerCase()])
    .filter(([name, digest]) => name && /^[a-f0-9]{64}$/.test(digest))
    .sort((left, right) => left[0].localeCompare(right[0]));
  return Object.fromEntries(pairs);
}

function hashEgressAllowlist(allowedHosts) {
  const normalized = asArray(allowedHosts)
    .map((entry) => safeString(entry).toLowerCase())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return sha256(`phase8-egress-allowlist-v1|${canonicalStringify(normalized)}`);
}

function createRuntimeAttestationEngine(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE8_ATTESTATION_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("PHASE8_ATTESTATION_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required");
  }

  async function captureRuntimeAttestation(input = {}, context = {}) {
    assertOperatorRole(context);
    const idempotencyKey = safeString(input.idempotencyKey);
    if (!idempotencyKey) {
      throw makeError("PHASE8_ATTESTATION_IDEMPOTENCY_REQUIRED", "idempotencyKey is required for runtime attestation capture");
    }

    const correlationId = safeString(context.correlationId);
    consumeScopedApprovalToken(operatorAuthorization, input.approvalToken, "compliance.attest.capture", { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureComplianceGovernanceState(state);
      assertKillSwitchOpen(state);

      const snapshots = state.complianceGovernance.attestationSnapshots;
      const existing = snapshots.find((entry) => safeString(entry.idempotencyKey) === idempotencyKey) || null;

      const policySnapshotHash = buildPolicySnapshotHash(state.complianceGovernance.activeReleasePolicy);

      const sequence = existing
        ? Number(existing.sequence)
        : (Math.max(
          Number(state.complianceGovernance.nextAttestationSequence || 0),
          snapshots.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0)
        ) + 1);

      const attestationWithoutHash = AttestationSnapshotWithoutHashSchema.parse({
        sequence,
        capturedAt: existing ? safeString(existing.capturedAt) : String(timeProvider.nowIso()),
        capturedBy: existing ? safeString(existing.capturedBy) : (safeString(context.requester) || "operator"),
        idempotencyKey,
        runtimePolicyVersion: safeString(input.runtimePolicyVersion) || "v1",
        runtimeStateSchemaVersion: Number.parseInt(String(input.runtimeStateSchemaVersion ?? "8"), 10) || 8,
        enabledGateScripts: normalizeGateScripts(input.enabledGateScripts),
        egressAllowlistHash: safeString(input.egressAllowlistHash).toLowerCase() || hashEgressAllowlist(input.egressAllowlist),
        killSwitchState: Boolean(state.outboundMutation && state.outboundMutation.killSwitch),
        criticalModuleHashManifest: normalizeModuleManifest(input.criticalModuleHashManifest),
        policySnapshotHash
      });

      const attestation = AttestationSnapshotRecordSchema.parse({
        ...attestationWithoutHash,
        attestationHash: computeAttestationHash(attestationWithoutHash)
      });

      if (existing) {
        assertIdempotencyReplay(existing, attestation, "runtime attestation");
        return {
          ok: true,
          idempotent: true,
          attestation: AttestationSnapshotRecordSchema.parse(existing)
        };
      }

      snapshots.push(attestation);
      snapshots.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
      state.complianceGovernance.nextAttestationSequence = Math.max(
        Number(state.complianceGovernance.nextAttestationSequence || 0),
        Number(attestation.sequence)
      );

      logger.info({
        correlationId,
        event: "phase8_runtime_attestation_captured",
        sequence: attestation.sequence,
        hash: attestation.attestationHash
      });

      return {
        ok: true,
        idempotent: false,
        attestation
      };
    }, { correlationId });
  }

  return Object.freeze({
    captureRuntimeAttestation
  });
}

module.exports = {
  createRuntimeAttestationEngine,
  normalizeGateScripts,
  normalizeModuleManifest,
  hashEgressAllowlist
};
