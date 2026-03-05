"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { createExternalAttestationAnchor } = require("../../workflows/attestation/external-attestation-anchor.js");
const { setupPhase10Harness, issueToken } = require("./_phase10-helpers.js");

function writeAllowlist(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    schema_version: "phase10-attestation-egress-v1",
    blocked_by_default: true,
    allowed_hosts: ["attestation.service.io"]
  }, null, 2), "utf8");
}

test("phase10 attestation anchor enforces confirm and approval token requirements", async () => {
  const harness = await setupPhase10Harness();
  const allowlistPath = path.join(harness.dir, "allowlist.json");
  writeAllowlist(allowlistPath);

  const anchor = createExternalAttestationAnchor({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    allowlistPath,
    artifactPath: path.join(harness.dir, "attestation"),
    timeProvider: harness.timeProvider
  });

  await assert.rejects(
    () => anchor.initiateAttestationAnchor({}, "https://attestation.service.io", {
      role: "operator",
      requester: "op-1",
      scope: "governance.attestation.anchor",
      confirm: false
    }),
    (error) => error && error.code === "PHASE10_ATTESTATION_CONFIRM_REQUIRED"
  );

  await assert.rejects(
    () => anchor.initiateAttestationAnchor({}, "https://attestation.service.io", {
      role: "operator",
      requester: "op-1",
      scope: "governance.attestation.anchor",
      confirm: true
    }),
    (error) => error && error.code === "OPERATOR_TOKEN_REQUIRED"
  );
});

test("phase10 attestation anchor rejects invalid scope and non-allowlisted host", async () => {
  const harness = await setupPhase10Harness();
  const allowlistPath = path.join(harness.dir, "allowlist.json");
  writeAllowlist(allowlistPath);

  const anchor = createExternalAttestationAnchor({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    allowlistPath,
    artifactPath: path.join(harness.dir, "attestation"),
    timeProvider: harness.timeProvider
  });

  await assert.rejects(
    () => anchor.initiateAttestationAnchor({}, "https://attestation.service.io", {
      role: "operator",
      requester: "op-1",
      approvalToken: issueToken(harness.authorization, "governance.attestation.anchor"),
      scope: "governance.invalid.scope",
      confirm: true
    }),
    (error) => error && error.code === "PHASE10_ATTESTATION_SCOPE_INVALID"
  );

  await assert.rejects(
    () => anchor.initiateAttestationAnchor({}, "", {
      role: "operator",
      requester: "op-1",
      approvalToken: issueToken(harness.authorization, "governance.attestation.anchor"),
      scope: "governance.attestation.anchor",
      confirm: true
    }),
    (error) => error && error.code === "PHASE10_ATTESTATION_EXTERNAL_SERVICE_REQUIRED"
  );

  await assert.rejects(
    () => anchor.initiateAttestationAnchor({}, "https://not-allowlisted.example", {
      role: "operator",
      requester: "op-1",
      approvalToken: issueToken(harness.authorization, "governance.attestation.anchor"),
      scope: "governance.attestation.anchor",
      confirm: true
    }),
    (error) => error && error.code === "PHASE10_ATTESTATION_EXTERNAL_SERVICE_DENIED"
  );
});

test("phase10 attestation anchor produces deterministic artifact and verification proof", async () => {
  const harness = await setupPhase10Harness();
  const allowlistPath = path.join(harness.dir, "allowlist.json");
  writeAllowlist(allowlistPath);

  const anchor = createExternalAttestationAnchor({
    apiGovernance: harness.governance,
    operatorAuthorization: harness.authorization,
    allowlistPath,
    artifactPath: path.join(harness.dir, "attestation"),
    timeProvider: {
      nowIso() {
        return "2026-03-04T12:34:56.000Z";
      }
    }
  });

  const anchored = await anchor.initiateAttestationAnchor({
    bundle: "phase8"
  }, "https://attestation.service.io", {
    role: "operator",
    requester: "op-1",
    approvalToken: issueToken(harness.authorization, "governance.attestation.anchor"),
    scope: "governance.attestation.anchor",
    confirm: true,
    correlationId: "phase10-attestation-success"
  });

  assert.equal(anchored.anchor_id, "ATT-20260304-001");
  assert.ok(anchored.anchor_proof.startsWith("proof:"));

  const verified = anchor.verifyAttestationAnchor(anchored.anchor_id);
  assert.deepEqual(verified, {
    valid: true,
    external_reference: `https://attestation.service.io#${anchored.anchor_id}`
  });

  const state = await harness.governance.readState();
  assert.ok(state.complianceGovernance.operatorOverrideLedger.records.length >= 1);
  assert.ok(state.complianceGovernance.operationalDecisionLedger.records.length >= 1);
});
