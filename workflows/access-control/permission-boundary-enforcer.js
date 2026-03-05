"use strict";

const path = require("node:path");

const { asArray, canonicalize, safeString } = require("../governance-automation/common.js");
const { createRolePermissionRegistry } = require("./role-permission-registry.js");
const { createScopeRegistry } = require("./scope-registry.js");
const { createTokenLifecycleManager } = require("./token-lifecycle-manager.js");
const { createAccessDecisionLedger } = require("./access-decision-ledger.js");
const { isRoleAllowedForScope, roleAlias, normalizeIso } = require("./access-control-common.js");

function createPermissionBoundaryEnforcer(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  const roleRegistry = options.roleRegistry || createRolePermissionRegistry({ logger });
  const scopeRegistry = options.scopeRegistry || createScopeRegistry({ logger });
  const tokenManager = options.tokenManager || createTokenLifecycleManager({
    logger,
    timeProvider,
    apiGovernance: options.apiGovernance,
    storePath: path.join(process.cwd(), "security", "token-store.json")
  });
  const accessLedger = options.accessDecisionLedger || createAccessDecisionLedger({
    logger,
    timeProvider,
    storePath: path.join(process.cwd(), "security", "access-decision-ledger.json")
  });

  async function evaluateAccess(input = {}) {
    const tokenId = safeString(input.token_id || input.tokenId || input.actor);
    const action = safeString(input.action);
    const resource = safeString(input.resource);
    const scopeId = safeString(input.scope || input.scope_id);

    let allowed = false;
    let reason = "deny_unknown";
    let role = "";
    let scopesEvaluated = [];

    if (!tokenId) {
      reason = "deny_missing_token";
    } else {
      const tokenStatus = tokenManager.validateToken(tokenId);
      role = roleAlias(tokenStatus.role);

      if (!tokenStatus.role) {
        reason = "deny_unknown_token";
      } else if (tokenStatus.revoked) {
        reason = "deny_revoked_token";
      } else if (tokenStatus.expired) {
        reason = "deny_expired_token";
      } else if (!tokenStatus.valid) {
        reason = "deny_invalid_token";
      } else if (!roleRegistry.getRole(role)) {
        reason = "deny_unknown_role";
      } else {
        const grantedScopes = asArray(tokenStatus.scopes).map((entry) => safeString(entry)).filter(Boolean).sort((l, r) => l.localeCompare(r));
        scopesEvaluated = grantedScopes;

        if (scopeId) {
          const scopeValidation = scopeRegistry.validateScope(scopeId);
          if (!scopeValidation.valid) {
            reason = "deny_unknown_scope";
          } else if (!grantedScopes.includes(scopeId)) {
            reason = "deny_scope_not_granted";
          } else if (!isRoleAllowedForScope(scopeValidation, role)) {
            reason = "deny_insufficient_role";
          } else if (!roleRegistry.hasPermission(role, scopeValidation.action, scopeValidation.resource)) {
            reason = "deny_permission_mismatch";
          } else if (action && resource && !roleRegistry.hasPermission(role, action, resource)) {
            reason = "deny_action_resource_mismatch";
          } else {
            allowed = true;
            reason = "allow";
          }
        } else if (!action || !resource) {
          reason = "deny_missing_action_or_resource";
        } else if (!roleRegistry.hasPermission(role, action, resource)) {
          reason = "deny_permission_mismatch";
        } else {
          allowed = true;
          reason = "allow";
        }
      }
    }

    const entry = await accessLedger.recordDecision({
      actor: tokenId || "",
      role,
      action: action || "",
      resource: resource || "",
      scope: scopeId || "",
      result: allowed ? "allow" : "deny",
      reason,
      scopes_evaluated: scopesEvaluated,
      metadata: {
        evaluated_at: normalizeIso(timeProvider.nowIso())
      }
    });

    return canonicalize({
      allowed,
      reason,
      role,
      scopes_evaluated: scopesEvaluated,
      decision_id: entry.entry.decision_id
    });
  }

  return Object.freeze({
    evaluateAccess
  });
}

module.exports = {
  createPermissionBoundaryEnforcer
};
