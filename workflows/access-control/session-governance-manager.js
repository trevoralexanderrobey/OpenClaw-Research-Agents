"use strict";

const path = require("node:path");

const { asArray, canonicalize, safeString } = require("../governance-automation/common.js");
const { createAccessDecisionLedger } = require("./access-decision-ledger.js");
const {
  ACCESS_CONTROL_SCHEMA_VERSION,
  addHoursToIso,
  deriveDeterministicId,
  normalizeIso,
  parseHours,
  readJsonFileIfExists,
  writeCanonicalJsonFile
} = require("./access-control-common.js");

function normalizeSession(record = {}) {
  return canonicalize({
    session_id: safeString(record.session_id),
    token_id: safeString(record.token_id),
    created_at: normalizeIso(record.created_at),
    expires_at: normalizeIso(record.expires_at),
    active: record.active === true,
    invalidated_reason: safeString(record.invalidated_reason),
    invalidated_at: safeString(record.invalidated_at)
  });
}

function normalizeStore(store = {}) {
  const source = store && typeof store === "object" ? store : {};
  const sessions = asArray(source.sessions)
    .map((entry) => normalizeSession(entry))
    .filter((entry) => entry.session_id)
    .sort((left, right) => left.session_id.localeCompare(right.session_id));

  return {
    schema_version: safeString(source.schema_version) || ACCESS_CONTROL_SCHEMA_VERSION,
    next_sequence: Math.max(0, Number.parseInt(String(source.next_sequence || 0), 10) || 0),
    sessions
  };
}

function createSessionGovernanceManager(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const tokenManager = options.tokenManager;
  const storePath = path.resolve(safeString(options.storePath) || path.join(process.cwd(), "security", "session-store.json"));

  if (!tokenManager || typeof tokenManager.validateToken !== "function") {
    const error = new Error("tokenManager.validateToken is required");
    error.code = "PHASE13_SESSION_CONFIG_INVALID";
    throw error;
  }

  const accessLedger = options.accessDecisionLedger || createAccessDecisionLedger({
    logger,
    timeProvider,
    storePath: path.join(process.cwd(), "security", "access-decision-ledger.json")
  });

  function readStore() {
    return normalizeStore(readJsonFileIfExists(storePath, {
      schema_version: ACCESS_CONTROL_SCHEMA_VERSION,
      next_sequence: 0,
      sessions: []
    }));
  }

  function writeStore(store) {
    writeCanonicalJsonFile(storePath, canonicalize(store));
  }

  function findSession(store, sessionId) {
    const normalizedSessionId = safeString(sessionId);
    return store.sessions.find((entry) => entry.session_id === normalizedSessionId) || null;
  }

  async function recordDecision(input) {
    return accessLedger.recordDecision({
      actor: safeString(input.actor),
      role: safeString(input.role),
      action: safeString(input.action),
      resource: "phase13.session",
      scope: "governance.session.create",
      result: safeString(input.result),
      reason: safeString(input.reason),
      metadata: input.metadata && typeof input.metadata === "object" ? canonicalize(input.metadata) : {},
      timestamp: normalizeIso(timeProvider.nowIso())
    });
  }

  async function createSession(tokenId, context = {}) {
    const actor = safeString(context.requester) || "operator";
    const confirm = context.confirm === true;
    const normalizedTokenId = safeString(tokenId);

    if (safeString(context.role).toLowerCase() !== "operator") {
      throw new Error("operator role is required for session creation");
    }

    if (!confirm || !normalizedTokenId) {
      const ledgerEntry = await recordDecision({
        actor,
        role: "operator_admin",
        action: "create_session",
        result: "deny",
        reason: !confirm ? "missing_confirm" : "missing_token_id"
      });
      return canonicalize({ session_record: null, ledger_entry: ledgerEntry, rejected: true });
    }

    const tokenStatus = tokenManager.validateToken(normalizedTokenId);
    if (!tokenStatus.valid) {
      const ledgerEntry = await recordDecision({
        actor,
        role: "operator_admin",
        action: "create_session",
        result: "deny",
        reason: tokenStatus.revoked ? "token_revoked" : (tokenStatus.expired ? "token_expired" : "token_invalid"),
        metadata: { token_id: normalizedTokenId }
      });
      return canonicalize({ session_record: null, ledger_entry: ledgerEntry, rejected: true });
    }

    const store = readStore();
    const sequence = Number(store.next_sequence || store.sessions.length) + 1;
    const createdAt = normalizeIso(timeProvider.nowIso());
    const expiresAt = addHoursToIso(createdAt, parseHours(context.expiresInHours || 8, 8));
    const sessionId = deriveDeterministicId("ses", {
      sequence,
      token_id: normalizedTokenId,
      created_at: createdAt
    }, 24);

    const sessionRecord = normalizeSession({
      session_id: sessionId,
      token_id: normalizedTokenId,
      created_at: createdAt,
      expires_at: expiresAt,
      active: true
    });

    store.sessions.push(sessionRecord);
    store.sessions.sort((left, right) => left.session_id.localeCompare(right.session_id));
    store.next_sequence = sequence;
    writeStore(store);

    const ledgerEntry = await recordDecision({
      actor,
      role: "operator_admin",
      action: "create_session",
      result: "allow",
      reason: "created",
      metadata: { session_id: sessionId, token_id: normalizedTokenId }
    });

    logger.info({ event: "phase13_session_created", session_id: sessionId, token_id: normalizedTokenId });
    return canonicalize({ session_record: sessionRecord, ledger_entry: ledgerEntry });
  }

  function validateSession(sessionId) {
    const store = readStore();
    const session = findSession(store, sessionId);
    if (!session) {
      return canonicalize({ valid: false, expired: false, token_valid: false, remaining_minutes: 0 });
    }

    const nowMs = Date.parse(normalizeIso(timeProvider.nowIso()));
    const expiresMs = Date.parse(normalizeIso(session.expires_at));
    const expired = Number.isFinite(nowMs) && Number.isFinite(expiresMs) && nowMs >= expiresMs;
    const tokenValidation = tokenManager.validateToken(session.token_id);
    const tokenValid = tokenValidation.valid === true;
    const active = session.active === true && !expired && tokenValid;
    const remainingMinutes = Number.isFinite(expiresMs) && Number.isFinite(nowMs)
      ? Math.max(0, Math.floor((expiresMs - nowMs) / 60000))
      : 0;

    return canonicalize({
      valid: active,
      expired,
      token_valid: tokenValid,
      remaining_minutes: remainingMinutes
    });
  }

  async function invalidateSession(sessionId, reason, context = {}) {
    const actor = safeString(context.requester) || "operator";
    const normalizedSessionId = safeString(sessionId);
    const invalidationReason = safeString(reason) || "operator_invalidate";

    if (safeString(context.role).toLowerCase() !== "operator") {
      throw new Error("operator role is required for session invalidation");
    }

    const store = readStore();
    const session = findSession(store, normalizedSessionId);
    if (!session) {
      const ledgerEntry = await recordDecision({
        actor,
        role: "operator_admin",
        action: "invalidate_session",
        result: "deny",
        reason: "session_not_found",
        metadata: { session_id: normalizedSessionId }
      });
      return canonicalize({ invalidated_record: null, ledger_entry: ledgerEntry, rejected: true });
    }

    session.active = false;
    session.invalidated_reason = invalidationReason;
    session.invalidated_at = normalizeIso(timeProvider.nowIso());
    writeStore(store);

    const invalidatedRecord = normalizeSession(session);
    const ledgerEntry = await recordDecision({
      actor,
      role: "operator_admin",
      action: "invalidate_session",
      result: "allow",
      reason: "invalidated",
      metadata: { session_id: normalizedSessionId, reason: invalidationReason }
    });

    return canonicalize({ invalidated_record: invalidatedRecord, ledger_entry: ledgerEntry });
  }

  function listActiveSessions() {
    const store = readStore();
    return canonicalize(store.sessions.filter((session) => validateSession(session.session_id).valid));
  }

  return Object.freeze({
    storePath,
    createSession,
    validateSession,
    invalidateSession,
    listActiveSessions
  });
}

module.exports = {
  createSessionGovernanceManager
};
