"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setupPhase8Harness,
  issueToken,
  createAttestation,
  createBundle,
  makeHash
} = require("./_phase8-helpers.js");
const {
  verifyEvidenceBundleIntegrity
} = require("../../workflows/compliance-governance/evidence-bundle-builder.js");

test("evidence bundle hash is stable across replay", async () => {
  const one = await setupPhase8Harness();
  const two = await setupPhase8Harness();

  await createAttestation(one, { idempotencyKey: "attest-bundle-1" });
  await createAttestation(two, { idempotencyKey: "attest-bundle-1" });

  const first = await createBundle(one, {
    idempotencyKey: "bundle-stable"
  });
  const second = await createBundle(two, {
    idempotencyKey: "bundle-stable"
  });

  assert.equal(first.bundle.bundleHash, second.bundle.bundleHash);
  assert.deepEqual(first.bundle, second.bundle);
});

test("evidence bundle integrity mismatch triggers fail-closed", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "attest-integrity" });
  const result = await createBundle(harness, { idempotencyKey: "bundle-integrity" });

  verifyEvidenceBundleIntegrity({ bundle: result.bundle });

  const tampered = {
    ...result.bundle,
    bundleHash: makeHash("f")
  };

  assert.throws(
    () => verifyEvidenceBundleIntegrity({ bundle: tampered }),
    (error) => error && error.code === "PHASE8_BUNDLE_HASH_MISMATCH"
  );
});

test("supervisor cannot mutate evidence bundles", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "attest-supervisor-bundle" });

  await assert.rejects(
    () => harness.bundleBuilder.buildEvidenceBundle({
      approvalToken: issueToken(harness.authorization, "compliance.bundle.build"),
      idempotencyKey: "bundle-supervisor",
      checkResults: {
        "phase2-gates": "pass",
        "mcp-policy": "pass",
        "phase6-policy": "pass",
        "phase7-policy": "pass"
      },
      artifactManifest: []
    }, {
      role: "supervisor",
      requester: "sup-1"
    }),
    (error) => error && error.code === "COMPLIANCE_ROLE_DENIED"
  );
});

test("evidence bundle rejects missing approvalToken", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "attest-no-token-bundle" });

  await assert.rejects(
    () => harness.bundleBuilder.buildEvidenceBundle({
      idempotencyKey: "bundle-no-token",
      checkResults: {
        "phase2-gates": "pass",
        "mcp-policy": "pass",
        "phase6-policy": "pass",
        "phase7-policy": "pass"
      },
      artifactManifest: []
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_REQUIRED"
  );
});

test("evidence bundle rejects invalid approvalToken scope", async () => {
  const harness = await setupPhase8Harness();
  await createAttestation(harness, { idempotencyKey: "attest-bad-scope-bundle" });

  await assert.rejects(
    () => harness.bundleBuilder.buildEvidenceBundle({
      approvalToken: issueToken(harness.authorization, "compliance.attest.capture"),
      idempotencyKey: "bundle-bad-scope",
      checkResults: {
        "phase2-gates": "pass",
        "mcp-policy": "pass",
        "phase6-policy": "pass",
        "phase7-policy": "pass"
      },
      artifactManifest: []
    }, {
      role: "operator",
      requester: "op-1"
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_SCOPE_INVALID"
  );
});
