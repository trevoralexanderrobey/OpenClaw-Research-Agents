"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { nowMs } = require("../core/time-provider.js");

const { BRIDGE_ROUTE_TYPES, routeRequiresAuth } = require("./bridge-routing.js");

const BRIDGE_PRINCIPALS = Object.freeze({
  SUPERVISOR: "supervisor",
  OPERATOR: "operator",
  INTEGRATION_HATCHIFY: "integration_hatchify",
  ANONYMOUS: "anonymous"
});

const INTEGRATION_HATCHIFY_SCOPE = "integration.hatchify.readonly";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBearerToken(authHeader) {
  const value = normalizeString(authHeader);
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return "";
  }
  return normalizeString(match[1]);
}

function parseIsoTimestamp(value) {
  const text = normalizeString(value);
  if (!text) {
    return Number.NaN;
  }
  return Date.parse(text);
}

function readTokenStore(tokenStorePath) {
  try {
    const raw = fs.readFileSync(tokenStorePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tokens)) {
      return [];
    }
    return parsed.tokens.filter((entry) => entry && typeof entry === "object");
  } catch {
    return [];
  }
}

function findTokenRecord(tokenStorePath, tokenId) {
  const normalizedTokenId = normalizeString(tokenId);
  if (!normalizedTokenId) {
    return null;
  }
  const tokens = readTokenStore(tokenStorePath);
  return tokens.find((entry) => normalizeString(entry.token_id) === normalizedTokenId) || null;
}

function derivePrincipalFromTokenRecord(tokenRecord) {
  const role = normalizeString(tokenRecord && tokenRecord.role).toLowerCase();
  const scopes = Array.isArray(tokenRecord && tokenRecord.scopes)
    ? tokenRecord.scopes.map((entry) => normalizeString(entry)).filter(Boolean)
    : [];

  if (role === BRIDGE_PRINCIPALS.INTEGRATION_HATCHIFY || scopes.includes(INTEGRATION_HATCHIFY_SCOPE)) {
    return BRIDGE_PRINCIPALS.INTEGRATION_HATCHIFY;
  }

  if (role.startsWith("operator_")) {
    return BRIDGE_PRINCIPALS.OPERATOR;
  }

  if (role === "system_automated" || role === BRIDGE_PRINCIPALS.SUPERVISOR) {
    return BRIDGE_PRINCIPALS.SUPERVISOR;
  }

  return "";
}

function isPrincipalAllowedForRoute(principal, routeType) {
  const normalizedPrincipal = normalizeString(principal);
  const normalizedRoute = normalizeString(routeType);

  if (normalizedRoute === BRIDGE_ROUTE_TYPES.OPERATOR_MCP_MESSAGES) {
    return normalizedPrincipal === BRIDGE_PRINCIPALS.OPERATOR;
  }

  if (
    normalizedRoute === BRIDGE_ROUTE_TYPES.JOBS
    || normalizedRoute === BRIDGE_ROUTE_TYPES.JOB
    || normalizedRoute === BRIDGE_ROUTE_TYPES.CANCEL
  ) {
    return normalizedPrincipal === BRIDGE_PRINCIPALS.OPERATOR || normalizedPrincipal === BRIDGE_PRINCIPALS.SUPERVISOR;
  }

  if (
    normalizedRoute === BRIDGE_ROUTE_TYPES.MCP_STREAMABLE
    || normalizedRoute === BRIDGE_ROUTE_TYPES.MCP_SSE
    || normalizedRoute === BRIDGE_ROUTE_TYPES.MCP_MESSAGES
  ) {
    return (
      normalizedPrincipal === BRIDGE_PRINCIPALS.OPERATOR
      || normalizedPrincipal === BRIDGE_PRINCIPALS.SUPERVISOR
      || normalizedPrincipal === BRIDGE_PRINCIPALS.INTEGRATION_HATCHIFY
    );
  }

  return true;
}

function principalToMcpRole(principal) {
  if (principal === BRIDGE_PRINCIPALS.OPERATOR) {
    return "operator";
  }
  if (principal === BRIDGE_PRINCIPALS.INTEGRATION_HATCHIFY) {
    return BRIDGE_PRINCIPALS.INTEGRATION_HATCHIFY;
  }
  return "supervisor";
}

function getMcpAllowlistForPrincipal(principal, options = {}) {
  const readAllowlist = Array.isArray(options.readAllowlist) ? options.readAllowlist : [];
  const operatorAllowlist = Array.isArray(options.operatorAllowlist) ? options.operatorAllowlist : [];
  if (principal !== BRIDGE_PRINCIPALS.OPERATOR) {
    return [...readAllowlist];
  }
  const out = new Set([...readAllowlist, ...operatorAllowlist]);
  return [...out];
}

function createBridgePrincipalResolver(options = {}) {
  const tokenStorePath = path.resolve(
    normalizeString(options.tokenStorePath) || path.join(process.cwd(), "security", "token-store.json")
  );

  function resolve(input = {}) {
    const routeType = normalizeString(input.routeType);
    if (!routeRequiresAuth(routeType)) {
      return {
        ok: true,
        status: 200,
        required: false,
        code: "",
        principal: BRIDGE_PRINCIPALS.ANONYMOUS,
        tokenId: "",
        role: "",
        scopes: []
      };
    }

    const tokenId = parseBearerToken(input.authorizationHeader);
    if (!tokenId) {
      return {
        ok: false,
        status: 401,
        required: true,
        code: "BRIDGE_AUTH_REQUIRED",
        principal: BRIDGE_PRINCIPALS.ANONYMOUS,
        tokenId: "",
        role: "",
        scopes: []
      };
    }

    const record = findTokenRecord(tokenStorePath, tokenId);
    if (!record) {
      return {
        ok: false,
        status: 401,
        required: true,
        code: "BRIDGE_AUTH_INVALID",
        principal: BRIDGE_PRINCIPALS.ANONYMOUS,
        tokenId,
        role: "",
        scopes: []
      };
    }

    const revoked = record.revoked === true;
    const expiresAtMs = parseIsoTimestamp(record.expires_at);
    const currentMs = nowMs();
    const expired = Number.isFinite(expiresAtMs) ? currentMs >= expiresAtMs : false;
    if (revoked) {
      return {
        ok: false,
        status: 401,
        required: true,
        code: "BRIDGE_AUTH_TOKEN_REVOKED",
        principal: BRIDGE_PRINCIPALS.ANONYMOUS,
        tokenId,
        role: normalizeString(record.role),
        scopes: Array.isArray(record.scopes) ? record.scopes : []
      };
    }
    if (expired) {
      return {
        ok: false,
        status: 401,
        required: true,
        code: "BRIDGE_AUTH_TOKEN_EXPIRED",
        principal: BRIDGE_PRINCIPALS.ANONYMOUS,
        tokenId,
        role: normalizeString(record.role),
        scopes: Array.isArray(record.scopes) ? record.scopes : []
      };
    }

    const principal = derivePrincipalFromTokenRecord(record);
    if (!principal) {
      return {
        ok: false,
        status: 403,
        required: true,
        code: "BRIDGE_PRINCIPAL_UNMAPPED",
        principal: BRIDGE_PRINCIPALS.ANONYMOUS,
        tokenId,
        role: normalizeString(record.role),
        scopes: Array.isArray(record.scopes) ? record.scopes : []
      };
    }

    if (!isPrincipalAllowedForRoute(principal, routeType)) {
      return {
        ok: false,
        status: 403,
        required: true,
        code: "BRIDGE_PRINCIPAL_FORBIDDEN",
        principal,
        tokenId,
        role: normalizeString(record.role),
        scopes: Array.isArray(record.scopes) ? record.scopes : []
      };
    }

    return {
      ok: true,
      status: 200,
      required: true,
      code: "",
      principal,
      tokenId,
      role: normalizeString(record.role),
      scopes: Array.isArray(record.scopes) ? record.scopes : []
    };
  }

  return Object.freeze({
    tokenStorePath,
    resolve
  });
}

module.exports = {
  BRIDGE_PRINCIPALS,
  INTEGRATION_HATCHIFY_SCOPE,
  parseBearerToken,
  derivePrincipalFromTokenRecord,
  isPrincipalAllowedForRoute,
  principalToMcpRole,
  getMcpAllowlistForPrincipal,
  createBridgePrincipalResolver
};
