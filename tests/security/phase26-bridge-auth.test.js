"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BRIDGE_PRINCIPALS,
  INTEGRATION_HATCHIFY_SCOPE,
  parseBearerToken,
  createBridgePrincipalResolver,
  getMcpAllowlistForPrincipal,
  principalToMcpRole
} = require("../../openclaw-bridge/bridge/bridge-auth.js");
const { BRIDGE_ROUTE_TYPES } = require("../../openclaw-bridge/bridge/bridge-routing.js");
const {
  MCP_METHOD_ALLOWLIST,
  MCP_OPERATOR_METHOD_ALLOWLIST
} = require("../../openclaw-bridge/bridge/mcp-transport.js");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-phase26-bridge-auth-"));
}

function writeTokenStore(filePath) {
  const now = Date.now();
  const in24h = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const inPast = new Date(now - 60 * 1000).toISOString();
  const payload = {
    schema_version: "phase13-access-control-v1",
    next_sequence: 5,
    tokens: [
      {
        token_id: "tok-operator",
        role: "operator_admin",
        scopes: ["governance.token.issue"],
        issued_at: in24h,
        expires_at: in24h,
        revoked: false,
        revocation_reason: "",
        revoked_at: "",
        issuer: "test",
        rotated_to: "",
        previous_token_id: ""
      },
      {
        token_id: "tok-supervisor",
        role: "system_automated",
        scopes: [],
        issued_at: in24h,
        expires_at: in24h,
        revoked: false,
        revocation_reason: "",
        revoked_at: "",
        issuer: "test",
        rotated_to: "",
        previous_token_id: ""
      },
      {
        token_id: "tok-hatchify",
        role: "operator_readonly",
        scopes: [INTEGRATION_HATCHIFY_SCOPE],
        issued_at: in24h,
        expires_at: in24h,
        revoked: false,
        revocation_reason: "",
        revoked_at: "",
        issuer: "test",
        rotated_to: "",
        previous_token_id: ""
      },
      {
        token_id: "tok-revoked",
        role: "operator_admin",
        scopes: [],
        issued_at: in24h,
        expires_at: in24h,
        revoked: true,
        revocation_reason: "test",
        revoked_at: in24h,
        issuer: "test",
        rotated_to: "",
        previous_token_id: ""
      },
      {
        token_id: "tok-expired",
        role: "operator_admin",
        scopes: [],
        issued_at: inPast,
        expires_at: inPast,
        revoked: false,
        revocation_reason: "",
        revoked_at: "",
        issuer: "test",
        rotated_to: "",
        previous_token_id: ""
      }
    ]
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("phase26 bearer parsing is deterministic", () => {
  assert.equal(parseBearerToken("Bearer tok-123"), "tok-123");
  assert.equal(parseBearerToken("bearer tok-456"), "tok-456");
  assert.equal(parseBearerToken("Token tok-456"), "");
  assert.equal(parseBearerToken(""), "");
});

test("phase26 bridge resolver enforces auth failures and token status", () => {
  const dir = makeTmpDir();
  const tokenStorePath = path.join(dir, "token-store.json");
  writeTokenStore(tokenStorePath);
  const resolver = createBridgePrincipalResolver({ tokenStorePath });

  const missing = resolver.resolve({ routeType: BRIDGE_ROUTE_TYPES.MCP_STREAMABLE, authorizationHeader: "" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "BRIDGE_AUTH_REQUIRED");

  const invalid = resolver.resolve({ routeType: BRIDGE_ROUTE_TYPES.MCP_STREAMABLE, authorizationHeader: "Bearer tok-missing" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "BRIDGE_AUTH_INVALID");

  const revoked = resolver.resolve({ routeType: BRIDGE_ROUTE_TYPES.MCP_STREAMABLE, authorizationHeader: "Bearer tok-revoked" });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.code, "BRIDGE_AUTH_TOKEN_REVOKED");

  const expired = resolver.resolve({ routeType: BRIDGE_ROUTE_TYPES.MCP_STREAMABLE, authorizationHeader: "Bearer tok-expired" });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, "BRIDGE_AUTH_TOKEN_EXPIRED");
});

test("phase26 bridge resolver separates integration_hatchify from operator/supervisor lanes", () => {
  const dir = makeTmpDir();
  const tokenStorePath = path.join(dir, "token-store.json");
  writeTokenStore(tokenStorePath);
  const resolver = createBridgePrincipalResolver({ tokenStorePath });

  const hatchifyMcp = resolver.resolve({
    routeType: BRIDGE_ROUTE_TYPES.MCP_STREAMABLE,
    authorizationHeader: "Bearer tok-hatchify"
  });
  assert.equal(hatchifyMcp.ok, true);
  assert.equal(hatchifyMcp.principal, BRIDGE_PRINCIPALS.INTEGRATION_HATCHIFY);

  const hatchifyOperatorRoute = resolver.resolve({
    routeType: BRIDGE_ROUTE_TYPES.OPERATOR_MCP_MESSAGES,
    authorizationHeader: "Bearer tok-hatchify"
  });
  assert.equal(hatchifyOperatorRoute.ok, false);
  assert.equal(hatchifyOperatorRoute.code, "BRIDGE_PRINCIPAL_FORBIDDEN");

  const hatchifyJobsRoute = resolver.resolve({
    routeType: BRIDGE_ROUTE_TYPES.JOBS,
    authorizationHeader: "Bearer tok-hatchify"
  });
  assert.equal(hatchifyJobsRoute.ok, false);
  assert.equal(hatchifyJobsRoute.code, "BRIDGE_PRINCIPAL_FORBIDDEN");

  const operatorRoute = resolver.resolve({
    routeType: BRIDGE_ROUTE_TYPES.OPERATOR_MCP_MESSAGES,
    authorizationHeader: "Bearer tok-operator"
  });
  assert.equal(operatorRoute.ok, true);
  assert.equal(operatorRoute.principal, BRIDGE_PRINCIPALS.OPERATOR);

  const supervisorRoute = resolver.resolve({
    routeType: BRIDGE_ROUTE_TYPES.MCP_STREAMABLE,
    authorizationHeader: "Bearer tok-supervisor"
  });
  assert.equal(supervisorRoute.ok, true);
  assert.equal(supervisorRoute.principal, BRIDGE_PRINCIPALS.SUPERVISOR);
});

test("phase26 principal allowlist remains read-only for integration lane", () => {
  const operatorAllowlist = getMcpAllowlistForPrincipal(BRIDGE_PRINCIPALS.OPERATOR, {
    readAllowlist: MCP_METHOD_ALLOWLIST,
    operatorAllowlist: MCP_OPERATOR_METHOD_ALLOWLIST
  });
  assert.equal(operatorAllowlist.includes("mutation_setKillSwitch"), true);

  const integrationAllowlist = getMcpAllowlistForPrincipal(BRIDGE_PRINCIPALS.INTEGRATION_HATCHIFY, {
    readAllowlist: MCP_METHOD_ALLOWLIST,
    operatorAllowlist: MCP_OPERATOR_METHOD_ALLOWLIST
  });
  assert.equal(integrationAllowlist.includes("mutation_setKillSwitch"), false);
  assert.equal(integrationAllowlist.includes("research_search"), true);
  assert.equal(principalToMcpRole(BRIDGE_PRINCIPALS.INTEGRATION_HATCHIFY), "integration_hatchify");
});
