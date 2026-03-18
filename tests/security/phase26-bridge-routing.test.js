"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BRIDGE_ROUTE_TYPES,
  AUTH_REQUIRED_ROUTE_TYPES,
  parseBridgeRoute,
  routeRequiresAuth
} = require("../../openclaw-bridge/bridge/bridge-routing.js");

test("phase26 parseBridgeRoute maps streamable and legacy MCP routes deterministically", () => {
  assert.equal(parseBridgeRoute("/mcp").type, BRIDGE_ROUTE_TYPES.MCP_STREAMABLE);
  assert.equal(parseBridgeRoute("/mcp/sse").type, BRIDGE_ROUTE_TYPES.MCP_SSE);
  assert.equal(parseBridgeRoute("/mcp/events").type, BRIDGE_ROUTE_TYPES.MCP_SSE);
  assert.equal(parseBridgeRoute("/mcp/messages").type, BRIDGE_ROUTE_TYPES.MCP_MESSAGES);
  assert.equal(parseBridgeRoute("/operator/mcp/messages").type, BRIDGE_ROUTE_TYPES.OPERATOR_MCP_MESSAGES);
});

test("phase26 parseBridgeRoute keeps jobs and health routing stable", () => {
  assert.equal(parseBridgeRoute("/health").type, BRIDGE_ROUTE_TYPES.HEALTH);
  assert.equal(parseBridgeRoute("/jobs").type, BRIDGE_ROUTE_TYPES.JOBS);
  assert.equal(parseBridgeRoute("/jobs/test-1").type, BRIDGE_ROUTE_TYPES.JOB);
  assert.equal(parseBridgeRoute("/jobs/test-1/cancel").type, BRIDGE_ROUTE_TYPES.CANCEL);
});

test("phase26 auth coverage includes streamable and legacy MCP paths", () => {
  const required = new Set(AUTH_REQUIRED_ROUTE_TYPES);
  assert.equal(required.has(BRIDGE_ROUTE_TYPES.MCP_STREAMABLE), true);
  assert.equal(required.has(BRIDGE_ROUTE_TYPES.MCP_SSE), true);
  assert.equal(required.has(BRIDGE_ROUTE_TYPES.MCP_MESSAGES), true);
  assert.equal(required.has(BRIDGE_ROUTE_TYPES.OPERATOR_MCP_MESSAGES), true);
  assert.equal(required.has(BRIDGE_ROUTE_TYPES.JOBS), true);
  assert.equal(required.has(BRIDGE_ROUTE_TYPES.JOB), true);
  assert.equal(required.has(BRIDGE_ROUTE_TYPES.CANCEL), true);
});

test("phase26 routeRequiresAuth keeps health open and MCP protected", () => {
  assert.equal(routeRequiresAuth(BRIDGE_ROUTE_TYPES.HEALTH), false);
  assert.equal(routeRequiresAuth(BRIDGE_ROUTE_TYPES.MCP_STREAMABLE), true);
  assert.equal(routeRequiresAuth(BRIDGE_ROUTE_TYPES.MCP_SSE), true);
  assert.equal(routeRequiresAuth(BRIDGE_ROUTE_TYPES.MCP_MESSAGES), true);
  assert.equal(routeRequiresAuth(BRIDGE_ROUTE_TYPES.OPERATOR_MCP_MESSAGES), true);
});
