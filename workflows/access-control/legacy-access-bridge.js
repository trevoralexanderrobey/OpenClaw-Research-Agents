"use strict";

const path = require("node:path");

const { canonicalize, safeString } = require("../governance-automation/common.js");
const { hashToken } = require("../../security/operator-authorization.js");
const { createRolePermissionRegistry } = require("./role-permission-registry.js");
const { createScopeRegistry } = require("./scope-registry.js");
const { createAccessDecisionLedger } = require("./access-decision-ledger.js");
const { isRoleAllowedForScope, roleAlias } = require("./access-control-common.js");

const LEGACY_PROTECTED_CALL_PATHS = Object.freeze([
  "legacy.compliance.consume_scoped",
  "legacy.experiment.consume_scoped",
  "legacy.rlhf.review.transition",
  "legacy.rlhf.outcomes.record",
  "legacy.rlhf.outcomes.repair",
  "legacy.rlhf.calibration.apply",
  "legacy.mutation.control.toggle",
  "legacy.mutation.control.kill_switch",
  "legacy.mutation.prepare",
  "legacy.mutation.commit",
  "legacy.mutation.reconcile",
  "legacy.script.apply_remediation"
]);

function createLegacyAccessBridge(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  const roleRegistry = options.roleRegistry || createRolePermissionRegistry({ logger });
  const scopeRegistry = options.scopeRegistry || createScopeRegistry({ logger });
  const accessLedger = options.accessDecisionLedger || createAccessDecisionLedger({
    logger,
    timeProvider,
    storePath: path.join(process.cwd(), "security", "access-decision-ledger.json")
  });

  function evaluateLegacyAccess(input = {}) {
    const scope = safeString(input.scope);
    const caller = safeString(input.caller);
    const approvalToken = safeString(input.approvalToken);
    const roleInput = safeString(input.role);
    const action = safeString(input.action) || "legacy.execute";
    const resource = safeString(input.resource) || scope;

    let result = "deny";
    let reason = "deny_unknown";
    let effectiveRole = "";
    let fallbackUsed = false;

    if (!LEGACY_PROTECTED_CALL_PATHS.includes(caller)) {
      reason = "deny_unknown_legacy_path";
    } else if (!approvalToken) {
      reason = "deny_missing_approval_token";
    } else {
      const scopeValidation = scopeRegistry.validateScope(scope);
      if (!scopeValidation.valid) {
        reason = "deny_unknown_scope";
      } else {
        effectiveRole = roleAlias(roleInput);
        if (!effectiveRole) {
          effectiveRole = "operator_admin";
          fallbackUsed = true;
        }

        if (!roleRegistry.getRole(effectiveRole)) {
          reason = "deny_unknown_role";
        } else if (!isRoleAllowedForScope(scopeValidation, effectiveRole)) {
          reason = "deny_insufficient_role_for_scope";
        } else if (!roleRegistry.hasPermission(effectiveRole, scopeValidation.action, scopeValidation.resource)) {
          reason = "deny_permission_mismatch";
        } else if (!roleRegistry.hasPermission(effectiveRole, action, resource)) {
          reason = "deny_action_resource_mismatch";
        } else {
          result = "allow";
          reason = fallbackUsed ? "allow_legacy_admin_fallback" : "allow";
        }
      }
    }

    const tokenActor = approvalToken ? `legacy:${hashToken(approvalToken).slice(0, 16)}` : "legacy:no-token";
    const decisionInput = {
      actor: tokenActor,
      role: effectiveRole,
      action,
      resource,
      scope,
      result,
      reason,
      metadata: {
        caller,
        legacy_path: true,
        fallback_used: fallbackUsed
      }
    };

    const output = canonicalize({
      allowed: result === "allow",
      reason,
      effective_role: effectiveRole,
      decision_id: "",
      fallback_used: fallbackUsed
    });

    accessLedger.recordDecision(decisionInput).catch((error) => {
        logger.warn({
          event: "phase13_legacy_access_decision_log_failed",
          reason: error && error.message ? error.message : String(error)
        });
      });

    if (output.allowed) {
      logger.info({ event: "phase13_legacy_access_allowed", scope, caller, fallback_used: fallbackUsed });
    } else {
      logger.warn({ event: "phase13_legacy_access_denied", scope, caller, reason });
    }

    return output;
  }

  return Object.freeze({
    evaluateLegacyAccess
  });
}

let singleton = null;

function getLegacyAccessBridge(options = {}) {
  if (!singleton) {
    singleton = createLegacyAccessBridge(options);
  }
  return singleton;
}

module.exports = {
  LEGACY_PROTECTED_CALL_PATHS,
  createLegacyAccessBridge,
  getLegacyAccessBridge
};
