"use strict";

const crypto = require("node:crypto");

const { createCredentialBroker } = require("../openclaw-bridge/security/credential-broker.js");

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function redactToken(value) {
  const token = normalizeString(value);
  if (token.length <= 6) {
    return "***";
  }
  return `${token.slice(0, 2)}***${token.slice(-2)}`;
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function makeError(code, message, details) {
  const error = new Error(String(message || "Operator authorization failed"));
  error.code = String(code || "OPERATOR_AUTHORIZATION_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function createOperatorAuthorization(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {} };
  const nowMs = typeof options.nowMs === "function" ? options.nowMs : () => Date.now();
  const tokenTtlMs = Number.isFinite(Number(options.tokenTtlMs)) ? Math.max(60_000, Number(options.tokenTtlMs)) : 15 * 60 * 1000;
  const broker = options.credentialBroker || createCredentialBroker({
    ttlMs: tokenTtlMs,
    nowMs
  });

  const consumed = new Map();

  function pruneConsumed() {
    const current = nowMs();
    for (const [tokenHash, expiresAt] of consumed.entries()) {
      if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= current) {
        consumed.delete(tokenHash);
      }
    }
  }

  function issueApprovalToken(input = {}) {
    const operatorId = normalizeString(input.operatorId) || "operator";
    const scope = normalizeString(input.scope) || "mutation";
    const correlationId = normalizeString(input.correlationId);
    const secret = `approval:${scope}:${operatorId}:${nowMs()}`;
    const token = broker.issueHandle(secret, {
      principal: operatorId,
      purpose: `approval:${scope}`
    });
    logger.info({
      correlationId,
      event: "operator_approval_token_issued",
      scope,
      operatorId,
      token: redactToken(token)
    });
    return {
      token,
      expiresAt: nowMs() + tokenTtlMs,
      scope,
      operatorId
    };
  }

  function validateApprovalToken(token, requiredScope, context = {}) {
    pruneConsumed();

    const rawToken = normalizeString(token);
    const scope = normalizeString(requiredScope) || "mutation";
    const correlationId = normalizeString(context.correlationId);

    if (!rawToken) {
      throw makeError("OPERATOR_TOKEN_REQUIRED", "Operator approval token is required");
    }

    const tokenHash = hashToken(rawToken);
    if (consumed.has(tokenHash)) {
      throw makeError("OPERATOR_TOKEN_REUSED", "Operator approval token has already been consumed");
    }

    let resolved;
    try {
      resolved = broker.resolveHandle(rawToken);
    } catch (error) {
      throw makeError("OPERATOR_TOKEN_INVALID", "Operator approval token is invalid or expired");
    }

    const metadata = resolved && resolved.metadata && typeof resolved.metadata === "object" ? resolved.metadata : {};
    const tokenScope = normalizeString(String(metadata.purpose || "")).replace(/^approval:/, "");
    if (!tokenScope || tokenScope !== scope) {
      throw makeError("OPERATOR_TOKEN_SCOPE_INVALID", `Operator approval token scope mismatch for '${scope}'`, {
        tokenScope,
        requiredScope: scope
      });
    }

    logger.info({
      correlationId,
      event: "operator_approval_token_validated",
      scope,
      token: redactToken(rawToken)
    });

    return {
      ok: true,
      tokenHash,
      scope,
      operatorId: normalizeString(metadata.principal) || "operator",
      expiresAt: Number(resolved.expiresAt || 0)
    };
  }

  function consumeApprovalToken(token, requiredScope, context = {}) {
    const validated = validateApprovalToken(token, requiredScope, context);
    const rawToken = normalizeString(token);
    broker.revokeHandle(rawToken);
    consumed.set(validated.tokenHash, Number(validated.expiresAt || nowMs() + tokenTtlMs));
    logger.info({
      correlationId: normalizeString(context.correlationId),
      event: "operator_approval_token_consumed",
      scope: validated.scope,
      token: redactToken(rawToken)
    });
    return {
      ok: true,
      tokenHash: validated.tokenHash,
      scope: validated.scope,
      operatorId: validated.operatorId
    };
  }

  return Object.freeze({
    issueApprovalToken,
    validateApprovalToken,
    consumeApprovalToken,
    credentialBroker: broker
  });
}

module.exports = {
  createOperatorAuthorization,
  hashToken,
  redactToken
};
