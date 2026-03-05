"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createRolePermissionRegistry } = require("../../workflows/access-control/role-permission-registry.js");
const { createScopeRegistry } = require("../../workflows/access-control/scope-registry.js");
const { createAccessDecisionLedger } = require("../../workflows/access-control/access-decision-ledger.js");
const { createTokenLifecycleManager } = require("../../workflows/access-control/token-lifecycle-manager.js");
const { createPermissionBoundaryEnforcer } = require("../../workflows/access-control/permission-boundary-enforcer.js");
const { createSessionGovernanceManager } = require("../../workflows/access-control/session-governance-manager.js");
const { createPrivilegeEscalationDetector } = require("../../workflows/access-control/privilege-escalation-detector.js");

const root = path.resolve(__dirname, "../..");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase13-"));
}

function createMutableTimeProvider(startIso = "2026-03-05T00:00:00.000Z") {
  let currentMs = Date.parse(startIso);
  return {
    nowIso() {
      return new Date(currentMs).toISOString();
    },
    nowMs() {
      return currentMs;
    },
    setNow(iso) {
      currentMs = Date.parse(String(iso || startIso));
    },
    advanceMinutes(minutes) {
      currentMs += Number(minutes || 0) * 60 * 1000;
    },
    advanceHours(hours) {
      currentMs += Number(hours || 0) * 60 * 60 * 1000;
    }
  };
}

async function setupPhase13Harness() {
  const dir = await makeTmpDir();
  const securityDir = path.join(dir, "security");
  fs.mkdirSync(securityDir, { recursive: true });

  fs.copyFileSync(path.join(root, "security", "rbac-policy.json"), path.join(securityDir, "rbac-policy.json"));
  fs.copyFileSync(path.join(root, "security", "scope-registry.json"), path.join(securityDir, "scope-registry.json"));

  const timeProvider = createMutableTimeProvider();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    timeProvider: {
      nowIso: () => timeProvider.nowIso(),
      nowMs: () => timeProvider.nowMs()
    }
  });

  const logger = { info() {}, warn() {}, error() {} };

  const roleRegistry = createRolePermissionRegistry({
    logger,
    policyPath: path.join(securityDir, "rbac-policy.json")
  });
  const scopeRegistry = createScopeRegistry({
    logger,
    registryPath: path.join(securityDir, "scope-registry.json")
  });
  const accessDecisionLedger = createAccessDecisionLedger({
    logger,
    timeProvider,
    storePath: path.join(securityDir, "access-decision-ledger.json")
  });
  const tokenManager = createTokenLifecycleManager({
    logger,
    timeProvider,
    storePath: path.join(securityDir, "token-store.json"),
    apiGovernance: governance,
    roleRegistry,
    scopeRegistry,
    accessDecisionLedger
  });
  const permissionEnforcer = createPermissionBoundaryEnforcer({
    roleRegistry,
    scopeRegistry,
    tokenManager,
    logger,
    timeProvider,
    accessDecisionLedger
  });
  const sessionManager = createSessionGovernanceManager({
    tokenManager,
    logger,
    timeProvider,
    accessDecisionLedger,
    storePath: path.join(securityDir, "session-store.json")
  });
  const escalationDetector = createPrivilegeEscalationDetector({ logger, timeProvider });

  return {
    dir,
    root,
    logger,
    timeProvider,
    governance,
    roleRegistry,
    scopeRegistry,
    accessDecisionLedger,
    tokenManager,
    permissionEnforcer,
    sessionManager,
    escalationDetector
  };
}

async function issueToken(harness, options = {}) {
  return harness.tokenManager.issueToken({
    role: options.role || "operator_standard",
    scopes: Array.isArray(options.scopes) ? options.scopes : ["governance.sbom.generate"],
    expiresInHours: Number(options.expiresInHours || 24),
    confirm: true
  }, {
    role: "operator",
    requester: options.requester || "phase13-test",
    confirm: true,
    correlationId: options.correlationId || "phase13-test-issue-token"
  });
}

module.exports = {
  root,
  makeTmpDir,
  createMutableTimeProvider,
  setupPhase13Harness,
  issueToken
};
