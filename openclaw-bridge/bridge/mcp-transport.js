"use strict";

const MCP_MAX_BODY_BYTES = 32 * 1024;
const MCP_CORRELATION_ID_PATTERN = /^[a-f0-9-]{16,64}$/;
const MCP_METHOD_ALLOWLIST = Object.freeze(["research.search", "research.getPaper", "analytics.monetizationScore"]);
const MCP_OPERATOR_METHOD_ALLOWLIST = Object.freeze([
  "mutation.preparePublication",
  "mutation.commitPublication",
  "mutation.retryPublication",
  "mutation.reconcilePublication",
  "mutation.setMutationEnabled",
  "mutation.setKillSwitch"
]);
const MCP_REQUEST_KEYS = Object.freeze(["jsonrpc", "id", "method", "params"]);

function assertMcpContentLength(contentLengthRaw) {
  const parsed = Number.parseInt(String(contentLengthRaw || "0"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const error = new Error("Content-Length header is required");
    error.code = "MCP_CONTENT_LENGTH_REQUIRED";
    throw error;
  }
  if (parsed > MCP_MAX_BODY_BYTES) {
    const error = new Error(`MCP payload exceeds ${MCP_MAX_BODY_BYTES} bytes`);
    error.code = "MCP_PAYLOAD_TOO_LARGE";
    throw error;
  }
  return parsed;
}

function normalizeMcpMessage(rawBody, options = {}) {
  const allowlist = Array.isArray(options.allowlist) && options.allowlist.length > 0
    ? options.allowlist
    : MCP_METHOD_ALLOWLIST;
  if (!rawBody || typeof rawBody !== "object") {
    const error = new Error("MCP message must be a JSON object");
    error.code = "MCP_REQUEST_INVALID";
    throw error;
  }
  if (Array.isArray(rawBody)) {
    const error = new Error("JSON-RPC batch requests are not allowed");
    error.code = "MCP_BATCH_FORBIDDEN";
    throw error;
  }

  const body = rawBody;
  for (const key of Object.keys(body)) {
    if (!MCP_REQUEST_KEYS.includes(key)) {
      const error = new Error(`Unknown MCP field '${key}'`);
      error.code = "MCP_UNKNOWN_FIELD";
      throw error;
    }
  }

  if (body.jsonrpc !== "2.0") {
    const error = new Error("jsonrpc must be '2.0'");
    error.code = "MCP_JSONRPC_VERSION_INVALID";
    throw error;
  }

  const id = String(body.id || "").trim().toLowerCase();
  if (!MCP_CORRELATION_ID_PATTERN.test(id)) {
    const error = new Error("id must match correlation format /^[a-f0-9-]{16,64}$/");
    error.code = "MCP_CORRELATION_ID_INVALID";
    throw error;
  }

  const method = String(body.method || "").trim();
  if (!allowlist.includes(method)) {
    const error = new Error(`MCP method '${method}' is not allowed`);
    error.code = "MCP_METHOD_NOT_ALLOWED";
    throw error;
  }

  const paramsRaw = body.params;
  if (!paramsRaw || typeof paramsRaw !== "object" || Array.isArray(paramsRaw)) {
    const error = new Error("params must be an object");
    error.code = "MCP_PARAMS_INVALID";
    throw error;
  }

  return {
    jsonrpc: "2.0",
    id,
    method,
    params: paramsRaw
  };
}

module.exports = {
  MCP_MAX_BODY_BYTES,
  MCP_CORRELATION_ID_PATTERN,
  MCP_METHOD_ALLOWLIST,
  MCP_OPERATOR_METHOD_ALLOWLIST,
  assertMcpContentLength,
  normalizeMcpMessage
};
