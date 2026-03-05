"use strict";

const path = require("node:path");

const { createApiGovernance } = require("../security/api-governance.js");
const { nowIso } = require("../openclaw-bridge/core/time-provider.js");
const { safeString } = require("../workflows/governance-automation/common.js");
const { createRolePermissionRegistry } = require("../workflows/access-control/role-permission-registry.js");
const { createScopeRegistry } = require("../workflows/access-control/scope-registry.js");
const { createAccessDecisionLedger } = require("../workflows/access-control/access-decision-ledger.js");
const { createTokenLifecycleManager } = require("../workflows/access-control/token-lifecycle-manager.js");
const { createPermissionBoundaryEnforcer } = require("../workflows/access-control/permission-boundary-enforcer.js");
const { createSessionGovernanceManager } = require("../workflows/access-control/session-governance-manager.js");
const { createPrivilegeEscalationDetector } = require("../workflows/access-control/privilege-escalation-detector.js");

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => safeString(item))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function buildPhase13Runtime(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const apiGovernance = options.apiGovernance || createApiGovernance({ logger });
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  const roleRegistry = options.roleRegistry || createRolePermissionRegistry({
    logger,
    policyPath: path.join(rootDir, "security", "rbac-policy.json")
  });
  const scopeRegistry = options.scopeRegistry || createScopeRegistry({
    logger,
    registryPath: path.join(rootDir, "security", "scope-registry.json")
  });
  const accessDecisionLedger = options.accessDecisionLedger || createAccessDecisionLedger({
    logger,
    timeProvider,
    storePath: path.join(rootDir, "security", "access-decision-ledger.json")
  });

  const tokenManager = options.tokenManager || createTokenLifecycleManager({
    logger,
    timeProvider,
    storePath: path.join(rootDir, "security", "token-store.json"),
    apiGovernance,
    roleRegistry,
    scopeRegistry,
    accessDecisionLedger
  });

  const permissionEnforcer = options.permissionEnforcer || createPermissionBoundaryEnforcer({
    roleRegistry,
    scopeRegistry,
    tokenManager,
    logger,
    timeProvider,
    accessDecisionLedger
  });

  const sessionManager = options.sessionManager || createSessionGovernanceManager({
    tokenManager,
    logger,
    timeProvider,
    accessDecisionLedger,
    storePath: path.join(rootDir, "security", "session-store.json")
  });

  const escalationDetector = options.escalationDetector || createPrivilegeEscalationDetector({ logger, timeProvider });

  return {
    rootDir,
    logger,
    apiGovernance,
    timeProvider,
    roleRegistry,
    scopeRegistry,
    accessDecisionLedger,
    tokenManager,
    permissionEnforcer,
    sessionManager,
    escalationDetector
  };
}

async function logCliRejection(runtime, input = {}) {
  return runtime.accessDecisionLedger.recordDecision({
    actor: safeString(input.actor) || "operator-cli",
    role: safeString(input.role) || "operator_admin",
    action: safeString(input.action) || "cli",
    resource: safeString(input.resource) || "phase13.cli",
    scope: safeString(input.scope),
    result: "deny",
    reason: safeString(input.reason) || "cli_rejected",
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
  });
}

module.exports = {
  parseCsv,
  buildPhase13Runtime,
  logCliRejection
};
