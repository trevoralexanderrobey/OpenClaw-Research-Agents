"use strict";

const { safeString, canonicalize } = require("../../workflows/governance-automation/common.js");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createMCPClient(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const config = isPlainObject(options.config) ? options.config : {};

  async function call(server, method, params = {}) {
    const serverName = safeString(server);
    const methodName = safeString(method);
    if (!serverName || !methodName) {
      const error = new Error("server and method are required");
      error.code = "PHASE16_MCP_CLIENT_INVALID_INPUT";
      throw error;
    }

    const endpoint = safeString(config[serverName] && config[serverName].endpoint);
    if (!endpoint) {
      const error = new Error(`No MCP endpoint configured for server '${serverName}'`);
      error.code = "PHASE16_MCP_SERVER_NOT_CONFIGURED";
      throw error;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `mcp-${Date.parse(timeProvider.nowIso())}`,
        method: methodName,
        params: canonicalize(params)
      })
    });

    if (!response.ok) {
      const error = new Error(`MCP call failed (${response.status})`);
      error.code = "PHASE16_MCP_HTTP_ERROR";
      throw error;
    }

    const payload = await response.json();
    logger.info({ event: "phase16_mcp_call", server: serverName, method: methodName });
    return canonicalize(payload);
  }

  return Object.freeze({
    call
  });
}

module.exports = {
  createMCPClient
};
