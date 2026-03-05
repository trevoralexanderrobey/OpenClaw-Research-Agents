"use strict";

const path = require("node:path");

const { asArray, canonicalize, safeString } = require("../governance-automation/common.js");
const { createRolePermissionRegistry } = require("./role-permission-registry.js");
const { createScopeRegistry } = require("./scope-registry.js");
const { createAccessDecisionLedger } = require("./access-decision-ledger.js");
const {
  ACCESS_CONTROL_SCHEMA_VERSION,
  addHoursToIso,
  deriveDeterministicId,
  normalizeIso,
  normalizeScopes,
  parseHours,
  readJsonFileIfExists,
  roleAlias,
  writeCanonicalJsonFile,
  isRoleAllowedForScope
} = require("./access-control-common.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 13 token lifecycle error"));
  error.code = String(code || "PHASE13_TOKEN_LIFECYCLE_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeTokenRecord(entry = {}) {
  return canonicalize({
    token_id: safeString(entry.token_id),
    role: roleAlias(entry.role),
    scopes: normalizeScopes(entry.scopes),
    issued_at: normalizeIso(entry.issued_at),
    expires_at: normalizeIso(entry.expires_at),
    revoked: entry.revoked === true,
    revocation_reason: safeString(entry.revocation_reason),
    revoked_at: safeString(entry.revoked_at),
    issuer: safeString(entry.issuer),
    rotated_to: safeString(entry.rotated_to),
    previous_token_id: safeString(entry.previous_token_id)
  });
}

function normalizeStore(store = {}) {
  const source = store && typeof store === "object" ? store : {};
  const tokens = asArray(source.tokens)
    .map((entry) => normalizeTokenRecord(entry))
    .filter((entry) => entry.token_id)
    .sort((left, right) => left.token_id.localeCompare(right.token_id));

  return {
    schema_version: safeString(source.schema_version) || ACCESS_CONTROL_SCHEMA_VERSION,
    next_sequence: Math.max(0, Number.parseInt(String(source.next_sequence || 0), 10) || 0),
    tokens
  };
}

function createTokenLifecycleManager(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const apiGovernance = options.apiGovernance;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const storePath = path.resolve(safeString(options.storePath) || path.join(process.cwd(), "security", "token-store.json"));

  if (!apiGovernance || typeof apiGovernance.withGovernanceTransaction !== "function") {
    throw makeError("PHASE13_TOKEN_MANAGER_CONFIG_INVALID", "apiGovernance.withGovernanceTransaction is required");
  }

  const roleRegistry = options.roleRegistry || createRolePermissionRegistry({ logger });
  const scopeRegistry = options.scopeRegistry || createScopeRegistry({ logger });
  const accessLedger = options.accessDecisionLedger || createAccessDecisionLedger({
    logger,
    timeProvider,
    storePath: path.join(process.cwd(), "security", "access-decision-ledger.json")
  });

  function readStore() {
    return normalizeStore(readJsonFileIfExists(storePath, {
      schema_version: ACCESS_CONTROL_SCHEMA_VERSION,
      next_sequence: 0,
      tokens: []
    }));
  }

  function writeStore(store) {
    writeCanonicalJsonFile(storePath, canonicalize(store));
  }

  function findToken(store, tokenId) {
    const normalizedTokenId = safeString(tokenId);
    return store.tokens.find((entry) => entry.token_id === normalizedTokenId) || null;
  }

  function tokenStatus(record) {
    const currentIso = normalizeIso(timeProvider.nowIso());
    const expiresAtMs = Date.parse(normalizeIso(record && record.expires_at));
    const nowMs = Date.parse(currentIso);
    const expired = Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && nowMs >= expiresAtMs;
    const revoked = Boolean(record && record.revoked === true);
    return { expired, revoked, valid: !expired && !revoked };
  }

  async function recordLifecycleDecision(input) {
    return accessLedger.recordDecision({
      actor: safeString(input.actor),
      role: roleAlias(input.role),
      action: safeString(input.action),
      resource: safeString(input.resource) || "phase13.token",
      scope: safeString(input.scope),
      result: safeString(input.result),
      reason: safeString(input.reason),
      scopes_evaluated: normalizeScopes(input.scopes_evaluated),
      metadata: input.metadata && typeof input.metadata === "object" ? canonicalize(input.metadata) : {},
      timestamp: normalizeIso(timeProvider.nowIso())
    });
  }

  function ensureOperatorContext(context) {
    const role = safeString(context && context.role).toLowerCase();
    if (role !== "operator") {
      throw makeError("PHASE13_TOKEN_OPERATOR_REQUIRED", "operator role is required for token lifecycle actions");
    }
  }

  function validateRoleAndScopes(requestedRole, requestedScopes) {
    const role = roleAlias(requestedRole);
    const roleDefinition = roleRegistry.getRole(role);
    if (!roleDefinition) {
      return { valid: false, reason: "unknown_role", role, scopes: requestedScopes };
    }

    for (const scopeId of requestedScopes) {
      const scope = scopeRegistry.validateScope(scopeId);
      if (!scope.valid) {
        return { valid: false, reason: "unknown_scope", role, scopes: requestedScopes };
      }
      if (!isRoleAllowedForScope(scope, role)) {
        return { valid: false, reason: "scope_role_mismatch", role, scopes: requestedScopes };
      }
      if (!roleRegistry.hasPermission(role, scope.action, scope.resource)) {
        return { valid: false, reason: "permission_mismatch", role, scopes: requestedScopes };
      }
    }

    return { valid: true, reason: "ok", role, scopes: requestedScopes };
  }

  async function issueToken(input = {}, context = {}) {
    ensureOperatorContext(context);
    const confirm = context.confirm === true || input.confirm === true;
    const actor = safeString(context.requester) || safeString(input.issuer) || "operator";
    const requestedRole = roleAlias(input.role);
    const requestedScopes = normalizeScopes(input.scopes);
    const expiresInHours = parseHours(input.expires_in_hours || input.expiresInHours || input.expires_in || input.expiresIn, 24);

    return apiGovernance.withGovernanceTransaction(async () => {
      if (!confirm) {
        const ledgerEntry = await recordLifecycleDecision({
          actor,
          role: requestedRole,
          action: "issue_token",
          resource: "phase13.token",
          scope: "governance.token.issue",
          result: "deny",
          reason: "missing_confirm",
          scopes_evaluated: requestedScopes
        });
        return canonicalize({ token_record: null, ledger_entry: ledgerEntry, rejected: true });
      }
      if (!requestedRole || requestedScopes.length === 0) {
        const ledgerEntry = await recordLifecycleDecision({
          actor,
          role: requestedRole,
          action: "issue_token",
          resource: "phase13.token",
          scope: "governance.token.issue",
          result: "deny",
          reason: "missing_role_or_scopes",
          scopes_evaluated: requestedScopes
        });
        return canonicalize({ token_record: null, ledger_entry: ledgerEntry, rejected: true });
      }

      const validation = validateRoleAndScopes(requestedRole, requestedScopes);
      if (!validation.valid) {
        const ledgerEntry = await recordLifecycleDecision({
          actor,
          role: requestedRole,
          action: "issue_token",
          resource: "phase13.token",
          scope: "governance.token.issue",
          result: "deny",
          reason: validation.reason,
          scopes_evaluated: requestedScopes
        });
        return canonicalize({ token_record: null, ledger_entry: ledgerEntry, rejected: true });
      }

      const store = readStore();
      const sequence = Number(store.next_sequence || store.tokens.length) + 1;
      const issuedAt = normalizeIso(timeProvider.nowIso());
      const expiresAt = addHoursToIso(issuedAt, expiresInHours);
      const tokenId = deriveDeterministicId("tok", {
        sequence,
        role: requestedRole,
        scopes: requestedScopes,
        issued_at: issuedAt,
        issuer: actor
      }, 24);

      const tokenRecord = normalizeTokenRecord({
        token_id: tokenId,
        role: requestedRole,
        scopes: requestedScopes,
        issued_at: issuedAt,
        expires_at: expiresAt,
        revoked: false,
        issuer: actor
      });

      store.tokens.push(tokenRecord);
      store.tokens.sort((left, right) => left.token_id.localeCompare(right.token_id));
      store.next_sequence = sequence;
      writeStore(store);

      const ledgerEntry = await recordLifecycleDecision({
        actor,
        role: requestedRole,
        action: "issue_token",
        resource: "phase13.token",
        scope: "governance.token.issue",
        result: "allow",
        reason: "issued",
        scopes_evaluated: requestedScopes,
        metadata: { token_id: tokenId }
      });

      logger.info({ event: "phase13_token_issued", token_id: tokenId, role: requestedRole });
      return canonicalize({ token_record: tokenRecord, ledger_entry: ledgerEntry });
    }, { correlationId: safeString(context.correlationId) });
  }

  async function rotateToken(tokenId, context = {}) {
    ensureOperatorContext(context);
    const confirm = context.confirm === true;
    const actor = safeString(context.requester) || "operator";
    const normalizedTokenId = safeString(tokenId);

    return apiGovernance.withGovernanceTransaction(async () => {
      if (!confirm) {
        const ledgerEntry = await recordLifecycleDecision({
          actor,
          role: "operator_admin",
          action: "rotate_token",
          resource: "phase13.token",
          scope: "governance.token.rotate",
          result: "deny",
          reason: "missing_confirm",
          metadata: { token_id: normalizedTokenId }
        });
        return canonicalize({ new_token_record: null, old_token_record: null, ledger_entry: ledgerEntry, rejected: true });
      }
      if (!normalizedTokenId) {
        const ledgerEntry = await recordLifecycleDecision({
          actor,
          role: "operator_admin",
          action: "rotate_token",
          resource: "phase13.token",
          scope: "governance.token.rotate",
          result: "deny",
          reason: "missing_token_id"
        });
        return canonicalize({ new_token_record: null, old_token_record: null, ledger_entry: ledgerEntry, rejected: true });
      }

      const store = readStore();
      const oldToken = findToken(store, normalizedTokenId);
      if (!oldToken) {
        const ledgerEntry = await recordLifecycleDecision({
          actor,
          role: "operator_admin",
          action: "rotate_token",
          resource: "phase13.token",
          scope: "governance.token.rotate",
          result: "deny",
          reason: "token_not_found",
          metadata: { token_id: normalizedTokenId }
        });
        return canonicalize({ new_token_record: null, old_token_record: null, ledger_entry: ledgerEntry, rejected: true });
      }

      const oldStatus = tokenStatus(oldToken);
      if (!oldStatus.valid) {
        const ledgerEntry = await recordLifecycleDecision({
          actor,
          role: oldToken.role,
          action: "rotate_token",
          resource: "phase13.token",
          scope: "governance.token.rotate",
          result: "deny",
          reason: oldStatus.revoked ? "token_revoked" : "token_expired",
          metadata: { token_id: normalizedTokenId }
        });
        return canonicalize({ new_token_record: null, old_token_record: oldToken, ledger_entry: ledgerEntry, rejected: true });
      }

      const sequence = Number(store.next_sequence || store.tokens.length) + 1;
      const issuedAt = normalizeIso(timeProvider.nowIso());
      const expiresAt = addHoursToIso(issuedAt, parseHours(context.expiresInHours || 24, 24));
      const newTokenId = deriveDeterministicId("tok", {
        sequence,
        role: oldToken.role,
        scopes: oldToken.scopes,
        issued_at: issuedAt,
        issuer: actor,
        previous_token_id: oldToken.token_id
      }, 24);

      const newRecord = normalizeTokenRecord({
        token_id: newTokenId,
        role: oldToken.role,
        scopes: oldToken.scopes,
        issued_at: issuedAt,
        expires_at: expiresAt,
        revoked: false,
        issuer: actor,
        previous_token_id: oldToken.token_id
      });

      oldToken.revoked = true;
      oldToken.revocation_reason = "rotated";
      oldToken.revoked_at = normalizeIso(timeProvider.nowIso());
      oldToken.rotated_to = newTokenId;

      store.tokens.push(newRecord);
      store.tokens = store.tokens.map((entry) => normalizeTokenRecord(entry)).sort((left, right) => left.token_id.localeCompare(right.token_id));
      store.next_sequence = sequence;
      writeStore(store);

      const ledgerEntry = await recordLifecycleDecision({
        actor,
        role: "operator_admin",
        action: "rotate_token",
        resource: "phase13.token",
        scope: "governance.token.rotate",
        result: "allow",
        reason: "rotated",
        metadata: { old_token_id: oldToken.token_id, new_token_id: newTokenId }
      });

      return canonicalize({
        new_token_record: newRecord,
        old_token_record: normalizeTokenRecord(oldToken),
        ledger_entry: ledgerEntry
      });
    }, { correlationId: safeString(context.correlationId) });
  }

  async function revokeToken(tokenId, reason, context = {}) {
    ensureOperatorContext(context);
    const confirm = context.confirm === true;
    const actor = safeString(context.requester) || "operator";
    const normalizedTokenId = safeString(tokenId);
    const revokeReason = safeString(reason);

    return apiGovernance.withGovernanceTransaction(async () => {
      if (!confirm) {
        const ledgerEntry = await recordLifecycleDecision({
          actor,
          role: "operator_admin",
          action: "revoke_token",
          resource: "phase13.token",
          scope: "governance.token.revoke",
          result: "deny",
          reason: "missing_confirm",
          metadata: { token_id: normalizedTokenId }
        });
        return canonicalize({ revoked_record: null, ledger_entry: ledgerEntry, rejected: true });
      }
      if (!normalizedTokenId || !revokeReason) {
        const ledgerEntry = await recordLifecycleDecision({
          actor,
          role: "operator_admin",
          action: "revoke_token",
          resource: "phase13.token",
          scope: "governance.token.revoke",
          result: "deny",
          reason: "missing_token_id_or_reason",
          metadata: { token_id: normalizedTokenId }
        });
        return canonicalize({ revoked_record: null, ledger_entry: ledgerEntry, rejected: true });
      }

      const store = readStore();
      const token = findToken(store, normalizedTokenId);
      if (!token) {
        const ledgerEntry = await recordLifecycleDecision({
          actor,
          role: "operator_admin",
          action: "revoke_token",
          resource: "phase13.token",
          scope: "governance.token.revoke",
          result: "deny",
          reason: "token_not_found",
          metadata: { token_id: normalizedTokenId }
        });
        return canonicalize({ revoked_record: null, ledger_entry: ledgerEntry, rejected: true });
      }

      token.revoked = true;
      token.revoked_at = normalizeIso(timeProvider.nowIso());
      token.revocation_reason = revokeReason;
      writeStore(store);

      const revokedRecord = normalizeTokenRecord(token);
      const ledgerEntry = await recordLifecycleDecision({
        actor,
        role: "operator_admin",
        action: "revoke_token",
        resource: "phase13.token",
        scope: "governance.token.revoke",
        result: "allow",
        reason: "revoked",
        metadata: { token_id: normalizedTokenId, revocation_reason: revokeReason }
      });

      return canonicalize({ revoked_record: revokedRecord, ledger_entry: ledgerEntry });
    }, { correlationId: safeString(context.correlationId) });
  }

  function validateToken(tokenId) {
    const store = readStore();
    const token = findToken(store, tokenId);
    if (!token) {
      return canonicalize({ valid: false, expired: false, revoked: false, role: "", scopes: [] });
    }

    const status = tokenStatus(token);
    return canonicalize({
      valid: status.valid,
      expired: status.expired,
      revoked: status.revoked,
      role: token.role,
      scopes: token.scopes
    });
  }

  function listActiveTokens() {
    const store = readStore();
    return canonicalize(store.tokens.filter((token) => tokenStatus(token).valid));
  }

  return Object.freeze({
    storePath,
    issueToken,
    rotateToken,
    revokeToken,
    validateToken,
    listActiveTokens
  });
}

module.exports = {
  createTokenLifecycleManager
};
