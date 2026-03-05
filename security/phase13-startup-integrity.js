"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { safeString } = require("../workflows/governance-automation/common.js");
const { createRolePermissionRegistry } = require("../workflows/access-control/role-permission-registry.js");
const { createScopeRegistry } = require("../workflows/access-control/scope-registry.js");
const { createAccessDecisionLedger } = require("../workflows/access-control/access-decision-ledger.js");
const { createTokenLifecycleManager } = require("../workflows/access-control/token-lifecycle-manager.js");
const { createPermissionBoundaryEnforcer } = require("../workflows/access-control/permission-boundary-enforcer.js");
const { createPrivilegeEscalationDetector } = require("../workflows/access-control/privilege-escalation-detector.js");
const { createSessionGovernanceManager } = require("../workflows/access-control/session-governance-manager.js");
const { getAccessControlSchema } = require("../workflows/access-control/access-control-schema.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 13 startup integrity failure"));
  error.code = String(code || "PHASE13_STARTUP_INTEGRITY_FAILED");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function ensureWritableDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const probePath = path.join(dirPath, ".phase13-startup-probe");
  fs.writeFileSync(probePath, "probe\n", "utf8");
  fs.unlinkSync(probePath);
}

function requiredFiles(rootDir) {
  return [
    "workflows/access-control/access-control-schema.js",
    "workflows/access-control/access-control-common.js",
    "workflows/access-control/role-permission-registry.js",
    "workflows/access-control/scope-registry.js",
    "workflows/access-control/access-decision-ledger.js",
    "workflows/access-control/token-lifecycle-manager.js",
    "workflows/access-control/permission-boundary-enforcer.js",
    "workflows/access-control/privilege-escalation-detector.js",
    "workflows/access-control/session-governance-manager.js",
    "workflows/access-control/legacy-access-bridge.js",
    "scripts/_phase13-access-utils.js",
    "scripts/issue-token.js",
    "scripts/rotate-token.js",
    "scripts/revoke-token.js",
    "scripts/validate-token.js",
    "scripts/list-active-tokens.js",
    "scripts/create-session.js",
    "scripts/validate-session.js",
    "scripts/check-access.js",
    "scripts/detect-escalation.js",
    "scripts/generate-phase13-artifacts.js",
    "scripts/verify-phase13-policy.sh",
    "security/rbac-policy.json",
    "security/scope-registry.json",
    "security/token-store.sample.json"
  ].map((rel) => ({ rel, abs: path.join(rootDir, rel) }));
}

async function verifyPhase13StartupIntegrity(options = {}) {
  const apiGovernance = options.apiGovernance;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const rootDir = typeof options.rootDir === "string" && options.rootDir.trim() ? options.rootDir : process.cwd();

  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    throw makeError("PHASE13_STARTUP_CONFIG_INVALID", "apiGovernance.readState is required for startup checks");
  }
  if (typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE13_STARTUP_CONFIG_INVALID", "apiGovernance.withGovernanceTransaction is required for startup checks");
  }

  const failures = [];

  for (const file of requiredFiles(rootDir)) {
    if (!fs.existsSync(file.abs)) {
      failures.push({ check: "required_file", file: file.rel, reason: "missing" });
    }
  }

  const rbacPath = path.join(rootDir, "security", "rbac-policy.json");
  const scopePath = path.join(rootDir, "security", "scope-registry.json");
  const tokenSamplePath = path.join(rootDir, "security", "token-store.sample.json");

  for (const jsonPath of [rbacPath, scopePath, tokenSamplePath]) {
    if (!fs.existsSync(jsonPath)) {
      continue;
    }
    try {
      JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch (error) {
      failures.push({
        check: "json_parse",
        file: path.relative(rootDir, jsonPath),
        reason: error && error.message ? error.message : String(error)
      });
    }
  }

  try {
    const schema = getAccessControlSchema();
    if (!schema || !schema.entities || !schema.entities.token_record) {
      failures.push({ check: "access_control_schema", reason: "invalid_schema_shape" });
    }
  } catch (error) {
    failures.push({ check: "access_control_schema", reason: error && error.message ? error.message : String(error) });
  }

  try {
    const fixedTimeProvider = { nowIso: () => "2026-03-05T00:00:00.000Z" };
    const roleRegistry = createRolePermissionRegistry({ logger, policyPath: rbacPath });
    const scopeRegistry = createScopeRegistry({ logger, registryPath: scopePath });
    const accessLedger = createAccessDecisionLedger({
      logger,
      timeProvider: fixedTimeProvider,
      storePath: path.join(rootDir, "security", "access-decision-ledger.json")
    });

    const tokenManager = createTokenLifecycleManager({
      logger,
      timeProvider: fixedTimeProvider,
      storePath: path.join(rootDir, "security", "token-store.json"),
      apiGovernance,
      roleRegistry,
      scopeRegistry,
      accessDecisionLedger: accessLedger
    });

    const enforcer = createPermissionBoundaryEnforcer({
      roleRegistry,
      scopeRegistry,
      tokenManager,
      logger,
      timeProvider: fixedTimeProvider,
      accessDecisionLedger: accessLedger
    });

    const detector = createPrivilegeEscalationDetector({ logger, timeProvider: fixedTimeProvider });
    const sessionManager = createSessionGovernanceManager({
      tokenManager,
      logger,
      timeProvider: fixedTimeProvider,
      accessDecisionLedger: accessLedger,
      storePath: path.join(rootDir, "security", "session-store.json")
    });

    if (!roleRegistry.getRole("operator_admin")) {
      failures.push({ check: "rbac_registry", reason: "operator_admin missing" });
    }
    if (!scopeRegistry.validateScope("governance.token.issue").valid) {
      failures.push({ check: "scope_registry", reason: "governance.token.issue missing" });
    }
    if (typeof enforcer.evaluateAccess !== "function") {
      failures.push({ check: "permission_boundary_enforcer", reason: "evaluateAccess missing" });
    }
    if (typeof detector.detectEscalation !== "function") {
      failures.push({ check: "privilege_escalation_detector", reason: "detectEscalation missing" });
    }
    if (typeof sessionManager.validateSession !== "function") {
      failures.push({ check: "session_governance_manager", reason: "validateSession missing" });
    }
  } catch (error) {
    failures.push({ check: "module_bootstrap", reason: error && error.message ? error.message : String(error) });
  }

  try {
    const artifactDir = path.resolve(options.accessControlArtifactPath || path.join(rootDir, "audit", "evidence", "access-control"));
    ensureWritableDirectory(artifactDir);
  } catch (error) {
    failures.push({ check: "access_control_artifact_path", reason: error && error.message ? error.message : String(error) });
  }

  const result = {
    healthy: failures.length === 0,
    failures
  };

  if (!result.healthy) {
    logger.error({ event: "phase13_startup_integrity_failed", failures: result.failures });
    return result;
  }

  logger.info({ event: "phase13_startup_integrity_verified", checks: "all", healthy: true });
  return result;
}

module.exports = {
  verifyPhase13StartupIntegrity
};
