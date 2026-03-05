"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setupPhase8Harness,
  issueToken,
  createAttestation,
  makeHash
} = require("./_phase8-helpers.js");

test("runtime attestation snapshot is deterministic across replay", async () => {
  const one = await setupPhase8Harness();
  const two = await setupPhase8Harness();

  const first = await createAttestation(one, {
    idempotencyKey: "deterministic-attest"
  });
  const second = await createAttestation(two, {
    idempotencyKey: "deterministic-attest"
  });

  assert.equal(first.attestation.attestationHash, second.attestation.attestationHash);
  assert.deepEqual(first.attestation, second.attestation);
});

test("runtime attestation duplicate idempotency returns prior result", async () => {
  const harness = await setupPhase8Harness();

  const initial = await harness.attestationEngine.captureRuntimeAttestation({
    approvalToken: issueToken(harness.authorization, "compliance.attest.capture"),
    idempotencyKey: "attest-idem",
    runtimePolicyVersion: "v1",
    runtimeStateSchemaVersion: 8,
    enabledGateScripts: [{ name: "verify-phase8-policy.sh", sha256: makeHash("a") }],
    egressAllowlistHash: makeHash("b"),
    criticalModuleHashManifest: {
      "security/api-governance.js": makeHash("c")
    }
  }, {
    role: "operator",
    requester: "op-1"
  });

  const replay = await harness.attestationEngine.captureRuntimeAttestation({
    approvalToken: issueToken(harness.authorization, "compliance.attest.capture"),
    idempotencyKey: "attest-idem",
    runtimePolicyVersion: "v1",
    runtimeStateSchemaVersion: 8,
    enabledGateScripts: [{ name: "verify-phase8-policy.sh", sha256: makeHash("a") }],
    egressAllowlistHash: makeHash("b"),
    criticalModuleHashManifest: {
      "security/api-governance.js": makeHash("c")
    }
  }, {
    role: "operator",
    requester: "op-1"
  });

  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.attestation, initial.attestation);
});

test("runtime attestation idempotency conflict fails closed", async () => {
  const harness = await setupPhase8Harness();

  await createAttestation(harness, { idempotencyKey: "attest-conflict" });

  await assert.rejects(
    () => harness.attestationEngine.captureRuntimeAttestation({
      approvalToken: issueToken(harness.authorization, "compliance.attest.capture"),
      idempotencyKey: "attest-conflict",
      runtimePolicyVersion: "v1",
      runtimeStateSchemaVersion: 8,
      enabledGateScripts: [{ name: "verify-phase8-policy.sh", sha256: makeHash("a") }],
      egressAllowlistHash: makeHash("9"),
      criticalModuleHashManifest: {
        "security/api-governance.js": makeHash("c")
      }
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "COMPLIANCE_IDEMPOTENCY_CONFLICT"
  );
});

test("supervisor cannot mutate runtime attestation state", async () => {
  const harness = await setupPhase8Harness();

  await assert.rejects(
    () => harness.attestationEngine.captureRuntimeAttestation({
      approvalToken: issueToken(harness.authorization, "compliance.attest.capture"),
      idempotencyKey: "attest-supervisor",
      runtimePolicyVersion: "v1",
      runtimeStateSchemaVersion: 8,
      enabledGateScripts: [{ name: "verify-phase8-policy.sh", sha256: makeHash("a") }],
      egressAllowlistHash: makeHash("b"),
      criticalModuleHashManifest: {
        "security/api-governance.js": makeHash("c")
      }
    }, {
      role: "supervisor",
      requester: "sup-1"
    }),
    (error) => error && error.code === "COMPLIANCE_ROLE_DENIED"
  );
});

test("runtime attestation rejects missing approvalToken", async () => {
  const harness = await setupPhase8Harness();

  await assert.rejects(
    () => harness.attestationEngine.captureRuntimeAttestation({
      idempotencyKey: "attest-no-token",
      runtimePolicyVersion: "v1",
      runtimeStateSchemaVersion: 8,
      enabledGateScripts: [{ name: "verify-phase8-policy.sh", sha256: makeHash("a") }],
      egressAllowlistHash: makeHash("b"),
      criticalModuleHashManifest: {
        "security/api-governance.js": makeHash("c")
      }
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_REQUIRED"
  );
});

test("runtime attestation rejects invalid approvalToken scope", async () => {
  const harness = await setupPhase8Harness();

  await assert.rejects(
    () => harness.attestationEngine.captureRuntimeAttestation({
      approvalToken: issueToken(harness.authorization, "compliance.bundle.build"),
      idempotencyKey: "attest-bad-scope",
      runtimePolicyVersion: "v1",
      runtimeStateSchemaVersion: 8,
      enabledGateScripts: [{ name: "verify-phase8-policy.sh", sha256: makeHash("a") }],
      egressAllowlistHash: makeHash("b"),
      criticalModuleHashManifest: {
        "security/api-governance.js": makeHash("c")
      }
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
});
