"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MCP_MAX_BODY_BYTES,
  MCP_OPERATOR_METHOD_ALLOWLIST,
  assertMcpContentLength,
  normalizeMcpMessage
} = require("../../openclaw-bridge/bridge/mcp-transport.js");

test("/mcp/messages rejects batch JSON-RPC payloads", () => {
  assert.throws(() => normalizeMcpMessage([{ jsonrpc: "2.0" }]), (error) => error && error.code === "MCP_BATCH_FORBIDDEN");
});

test("/mcp/messages rejects oversized body", () => {
  assert.throws(() => assertMcpContentLength(MCP_MAX_BODY_BYTES + 1), (error) => error && error.code === "MCP_PAYLOAD_TOO_LARGE");
});

test("/mcp/messages rejects unknown fields and unknown methods", () => {
  assert.throws(
    () =>
      normalizeMcpMessage({
        jsonrpc: "2.0",
        id: "abcdabcdabcdabcd",
        method: "research.search",
        params: {},
        extra: true
      }),
    (error) => error && error.code === "MCP_UNKNOWN_FIELD"
  );

  assert.throws(
    () =>
      normalizeMcpMessage({
        jsonrpc: "2.0",
        id: "abcdabcdabcdabcd",
        method: "research.anything",
        params: {}
      }),
    (error) => error && error.code === "MCP_METHOD_NOT_ALLOWED"
  );
});

test("/mcp/messages rejects invalid correlation id", () => {
  assert.throws(
    () =>
      normalizeMcpMessage({
        jsonrpc: "2.0",
        id: "INVALID_ID",
        method: "research.search",
        params: {
          provider: "semantic-scholar",
          query: "llm security"
        }
      }),
    (error) => error && error.code === "MCP_CORRELATION_ID_INVALID"
  );
});

test("/operator/mcp/messages allows mutation methods only when operator allowlist is supplied", () => {
  assert.doesNotThrow(() =>
    normalizeMcpMessage(
      {
        jsonrpc: "2.0",
        id: "abcdabcdabcdabcd",
        method: "mutation.setKillSwitch",
        params: {
          killSwitch: true,
          approvalToken: "cred_test_token_1234"
        }
      },
      { allowlist: MCP_OPERATOR_METHOD_ALLOWLIST }
    )
  );
});
