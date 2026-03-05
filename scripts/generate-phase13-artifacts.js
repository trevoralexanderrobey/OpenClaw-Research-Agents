#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { canonicalize, canonicalJson, sha256 } = require("../workflows/governance-automation/common.js");
const { ACCESS_CONTROL_SCHEMA_VERSION } = require("../workflows/access-control/access-control-common.js");
const { getAccessControlSchema } = require("../workflows/access-control/access-control-schema.js");
const { buildPhase13Runtime } = require("./_phase13-access-utils.js");

function parseArgs(argv) {
  const out = {
    rootDir: process.cwd(),
    outDir: path.resolve(process.cwd(), "audit", "evidence", "access-control")
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--root") {
      out.rootDir = path.resolve(String(argv[i + 1] || out.rootDir));
      i += 1;
      continue;
    }
    if (token === "--out") {
      out.outDir = path.resolve(String(argv[i + 1] || out.outDir));
      i += 1;
      continue;
    }
  }
  return out;
}

function writeCanonical(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(value), "utf8");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath, "utf8"));
}

function resetRuntimeStores(rootDir) {
  const stores = {
    "token-store.json": {
      schema_version: ACCESS_CONTROL_SCHEMA_VERSION,
      next_sequence: 0,
      tokens: []
    },
    "access-decision-ledger.json": {
      schema_version: ACCESS_CONTROL_SCHEMA_VERSION,
      next_sequence: 0,
      chain_head: "",
      decisions: []
    },
    "session-store.json": {
      schema_version: ACCESS_CONTROL_SCHEMA_VERSION,
      next_sequence: 0,
      sessions: []
    }
  };

  for (const [name, value] of Object.entries(stores)) {
    writeCanonical(path.join(rootDir, "security", name), value);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  resetRuntimeStores(args.rootDir);
  const runtime = buildPhase13Runtime({
    rootDir: args.rootDir,
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  fs.mkdirSync(args.outDir, { recursive: true });

  const schema = getAccessControlSchema();
  const roles = runtime.roleRegistry.listRoles();
  const scopes = runtime.scopeRegistry.listAllScopes();

  const tokenIssue = await runtime.tokenManager.issueToken({
    role: "operator_standard",
    scopes: ["governance.sbom.generate", "governance.vulnerability.scan"],
    expiresInHours: 24,
    confirm: true
  }, {
    role: "operator",
    requester: "phase13-artifacts",
    confirm: true,
    correlationId: "phase13-artifacts-issue"
  });

  const tokenId = tokenIssue && tokenIssue.token_record ? tokenIssue.token_record.token_id : "";
  const tokenRotation = tokenId
    ? await runtime.tokenManager.rotateToken(tokenId, {
      role: "operator",
      requester: "phase13-artifacts",
      confirm: true,
      correlationId: "phase13-artifacts-rotate"
    })
    : { rejected: true };

  const revokeTarget = tokenRotation && tokenRotation.new_token_record
    ? tokenRotation.new_token_record.token_id
    : tokenId;

  const tokenRevoke = revokeTarget
    ? await runtime.tokenManager.revokeToken(revokeTarget, "phase13_artifact_sample_revoke", {
      role: "operator",
      requester: "phase13-artifacts",
      confirm: true,
      correlationId: "phase13-artifacts-revoke"
    })
    : { rejected: true };

  const accessResult = tokenId
    ? await runtime.permissionEnforcer.evaluateAccess({
      token_id: tokenId,
      action: "generate",
      resource: "governance.sbom",
      scope: "governance.sbom.generate"
    })
    : { allowed: false, reason: "missing_token" };

  const sessionResult = tokenId
    ? await runtime.sessionManager.createSession(tokenId, {
      role: "operator",
      requester: "phase13-artifacts",
      confirm: true,
      correlationId: "phase13-artifacts-session"
    })
    : { rejected: true };

  const invalidatedSession = sessionResult && sessionResult.session_record
    ? await runtime.sessionManager.invalidateSession(sessionResult.session_record.session_id, "phase13_artifact_cleanup", {
      role: "operator",
      requester: "phase13-artifacts",
      correlationId: "phase13-artifacts-session-invalidate"
    })
    : { rejected: true };

  const ledgerDecisions = runtime.accessDecisionLedger.getDecisions({});
  const escalation = runtime.escalationDetector.detectEscalation(ledgerDecisions);
  const ledgerIntegrity = runtime.accessDecisionLedger.verifyChainIntegrity();

  const policyGateRun = spawnSync("bash", ["scripts/verify-phase13-policy.sh", "--root", args.rootDir], {
    cwd: args.rootDir,
    encoding: "utf8"
  });

  const files = {
    "access-control-schema.json": schema,
    "rbac-policy-snapshot.json": { roles },
    "scope-registry-snapshot.json": { scopes },
    "token-issuance-sample.json": tokenIssue,
    "token-rotation-sample.json": tokenRotation,
    "token-revocation-sample.json": tokenRevoke,
    "access-decision-sample.json": accessResult,
    "access-decision-ledger-sample.json": { integrity: ledgerIntegrity, decisions: ledgerDecisions },
    "permission-boundary-results.json": accessResult,
    "escalation-detection-sample.json": escalation,
    "session-governance-sample.json": {
      created: sessionResult,
      invalidated: invalidatedSession
    },
    "phase13-policy-gate-results.json": canonicalize({
      command: `bash scripts/verify-phase13-policy.sh --root ${args.rootDir}`,
      status: Number(policyGateRun.status),
      passed: Number(policyGateRun.status) === 0,
      stdout: String(policyGateRun.stdout || "").trim(),
      stderr: String(policyGateRun.stderr || "").trim()
    })
  };

  for (const [name, value] of Object.entries(files)) {
    writeCanonical(path.join(args.outDir, name), value);
  }

  const ordered = Object.keys(files).sort((left, right) => left.localeCompare(right));
  writeCanonical(path.join(args.outDir, "hash-manifest.json"), canonicalize({
    files: ordered.map((name) => ({ file: name, sha256: hashFile(path.join(args.outDir, name)) }))
  }));

  process.stdout.write(`${JSON.stringify({ ok: true, out_dir: args.outDir, files: [...ordered, "hash-manifest.json"] }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
