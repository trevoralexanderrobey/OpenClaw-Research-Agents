"use strict";

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const {
  EvidenceBundleWithoutHashSchema,
  EvidenceBundleRecordSchema,
  computeBundleHash,
  makeError
} = require("./compliance-schema.js");
const {
  safeString,
  assertOperatorRole,
  assertKillSwitchOpen,
  consumeScopedApprovalToken,
  ensureComplianceGovernanceState,
  assertIdempotencyReplay,
  buildPolicySnapshotHash,
  computeFreshnessHours,
  getLatestBySequence,
  normalizeRequiredChecks
} = require("./compliance-validator.js");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeArtifactManifest(value) {
  const entries = asArray(value)
    .map((entry) => ({
      file: safeString(entry && entry.file),
      sha256: safeString(entry && entry.sha256).toLowerCase()
    }))
    .filter((entry) => entry.file && /^[a-f0-9]{64}$/.test(entry.sha256));
  entries.sort((left, right) => left.file.localeCompare(right.file));
  return entries;
}

function normalizeCheckResults(value, requiredChecks = []) {
  const out = {};
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const keys = new Set([...Object.keys(source), ...requiredChecks]);
  const orderedKeys = [...keys].sort((left, right) => left.localeCompare(right));
  for (const key of orderedKeys) {
    const normalizedKey = safeString(key);
    if (!normalizedKey) {
      continue;
    }
    const raw = safeString(source[normalizedKey] || source[key]).toLowerCase();
    out[normalizedKey] = ["pass", "fail", "unknown"].includes(raw) ? raw : "unknown";
  }
  return out;
}

function resolveAsOfIso(inputAsOfIso, timeProvider) {
  return safeString(inputAsOfIso) || String(timeProvider.nowIso());
}

function verifyEvidenceBundleIntegrity(input = {}) {
  const bundle = input.bundle && typeof input.bundle === "object" ? input.bundle : input;
  const withoutHash = EvidenceBundleWithoutHashSchema.parse({
    sequence: Number(bundle.sequence),
    builtAt: safeString(bundle.builtAt),
    builtBy: safeString(bundle.builtBy),
    idempotencyKey: safeString(bundle.idempotencyKey),
    asOfIso: safeString(bundle.asOfIso),
    attestationSequence: Number(bundle.attestationSequence),
    attestationHash: safeString(bundle.attestationHash).toLowerCase(),
    policySnapshotHash: safeString(bundle.policySnapshotHash).toLowerCase(),
    requiredChecks: normalizeRequiredChecks(bundle.requiredChecks),
    checkResults: normalizeCheckResults(bundle.checkResults, normalizeRequiredChecks(bundle.requiredChecks)),
    artifactManifest: normalizeArtifactManifest(bundle.artifactManifest),
    freshnessHours: Number(bundle.freshnessHours),
    bundleVersion: "v1"
  });
  const expected = computeBundleHash(withoutHash);
  const actual = safeString(bundle.bundleHash).toLowerCase();
  if (expected !== actual) {
    throw makeError("PHASE8_BUNDLE_HASH_MISMATCH", "Evidence bundle hash mismatch", {
      expected,
      actual
    });
  }
  return {
    ok: true,
    expected,
    actual
  };
}

function createEvidenceBundleBuilder(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  if (!apiGovernance || typeof apiGovernance.readState !== "function" || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE8_BUNDLE_CONFIG_INVALID", "apiGovernance.readState and withGovernanceTransaction are required");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("PHASE8_BUNDLE_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required");
  }

  async function buildEvidenceBundle(input = {}, context = {}) {
    assertOperatorRole(context);
    const idempotencyKey = safeString(input.idempotencyKey);
    if (!idempotencyKey) {
      throw makeError("PHASE8_BUNDLE_IDEMPOTENCY_REQUIRED", "idempotencyKey is required for evidence bundle build");
    }

    const correlationId = safeString(context.correlationId);
    consumeScopedApprovalToken(operatorAuthorization, input.approvalToken, "compliance.bundle.build", { correlationId });

    const preState = await apiGovernance.readState();
    assertKillSwitchOpen(preState);

    return apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureComplianceGovernanceState(state);
      assertKillSwitchOpen(state);

      const bundles = state.complianceGovernance.evidenceBundles;
      const existing = bundles.find((entry) => safeString(entry.idempotencyKey) === idempotencyKey) || null;
      const latestAttestation = getLatestBySequence(state.complianceGovernance.attestationSnapshots);
      if (!latestAttestation) {
        throw makeError("PHASE8_ATTESTATION_REQUIRED", "At least one runtime attestation snapshot is required to build evidence bundle");
      }

      const requiredChecks = normalizeRequiredChecks(state.complianceGovernance.activeReleasePolicy.requiredChecks);
      const policySnapshotHash = buildPolicySnapshotHash(state.complianceGovernance.activeReleasePolicy);
      const asOfIso = resolveAsOfIso(input.asOfIso, timeProvider);
      const freshnessHours = computeFreshnessHours(asOfIso, safeString(latestAttestation.capturedAt));
      const checkResults = normalizeCheckResults(input.checkResults, requiredChecks);

      const sequence = existing
        ? Number(existing.sequence)
        : (Math.max(
          Number(state.complianceGovernance.nextEvidenceBundleSequence || 0),
          bundles.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0)
        ) + 1);

      const bundleWithoutHash = EvidenceBundleWithoutHashSchema.parse({
        sequence,
        builtAt: existing ? safeString(existing.builtAt) : String(timeProvider.nowIso()),
        builtBy: existing ? safeString(existing.builtBy) : (safeString(context.requester) || "operator"),
        idempotencyKey,
        asOfIso,
        attestationSequence: Number(latestAttestation.sequence),
        attestationHash: safeString(latestAttestation.attestationHash),
        policySnapshotHash,
        requiredChecks,
        checkResults,
        artifactManifest: normalizeArtifactManifest(input.artifactManifest),
        freshnessHours,
        bundleVersion: "v1"
      });

      const bundle = EvidenceBundleRecordSchema.parse({
        ...bundleWithoutHash,
        bundleHash: computeBundleHash(bundleWithoutHash)
      });

      if (existing) {
        assertIdempotencyReplay(existing, bundle, "evidence bundle");
        return {
          ok: true,
          idempotent: true,
          bundle: EvidenceBundleRecordSchema.parse(existing)
        };
      }

      bundles.push(bundle);
      bundles.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
      state.complianceGovernance.nextEvidenceBundleSequence = Math.max(
        Number(state.complianceGovernance.nextEvidenceBundleSequence || 0),
        Number(bundle.sequence)
      );

      logger.info({
        correlationId,
        event: "phase8_evidence_bundle_built",
        sequence: bundle.sequence,
        hash: bundle.bundleHash
      });

      return {
        ok: true,
        idempotent: false,
        bundle
      };
    }, { correlationId });
  }

  return Object.freeze({
    buildEvidenceBundle,
    verifyEvidenceBundleIntegrity
  });
}

module.exports = {
  createEvidenceBundleBuilder,
  verifyEvidenceBundleIntegrity,
  normalizeArtifactManifest,
  normalizeCheckResults,
  resolveAsOfIso
};
