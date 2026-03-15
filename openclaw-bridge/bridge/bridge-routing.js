"use strict";

const BRIDGE_ROUTE_TYPES = Object.freeze({
  HEALTH: "health",
  JOBS: "jobs",
  JOB: "job",
  CANCEL: "cancel",
  EXECUTE_TOOL: "execute-tool",
  MCP_STREAMABLE: "mcp-streamable",
  MCP_SSE: "mcp-sse",
  MCP_MESSAGES: "mcp-messages",
  OPERATOR_MCP_MESSAGES: "operator-mcp-messages",
  UNKNOWN: "unknown"
});

const AUTH_REQUIRED_ROUTE_TYPES = Object.freeze([
  BRIDGE_ROUTE_TYPES.JOBS,
  BRIDGE_ROUTE_TYPES.JOB,
  BRIDGE_ROUTE_TYPES.CANCEL,
  BRIDGE_ROUTE_TYPES.MCP_STREAMABLE,
  BRIDGE_ROUTE_TYPES.MCP_SSE,
  BRIDGE_ROUTE_TYPES.MCP_MESSAGES,
  BRIDGE_ROUTE_TYPES.OPERATOR_MCP_MESSAGES
]);

function parseBridgeRoute(pathname) {
  const normalized = String(pathname || "").trim();
  if (normalized === "/health") return { type: BRIDGE_ROUTE_TYPES.HEALTH };
  if (normalized === "/jobs") return { type: BRIDGE_ROUTE_TYPES.JOBS };
  if (normalized === "/execute-tool") return { type: BRIDGE_ROUTE_TYPES.EXECUTE_TOOL };
  if (normalized === "/mcp") return { type: BRIDGE_ROUTE_TYPES.MCP_STREAMABLE };
  if (normalized === "/mcp/sse" || normalized === "/mcp/events") return { type: BRIDGE_ROUTE_TYPES.MCP_SSE };
  if (normalized === "/mcp/messages") return { type: BRIDGE_ROUTE_TYPES.MCP_MESSAGES };
  if (normalized === "/operator/mcp/messages") return { type: BRIDGE_ROUTE_TYPES.OPERATOR_MCP_MESSAGES };

  const jobMatch = normalized.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch) return { type: BRIDGE_ROUTE_TYPES.JOB, jobId: decodeURIComponent(jobMatch[1]) };

  const cancelMatch = normalized.match(/^\/jobs\/([^/]+)\/cancel$/);
  if (cancelMatch) return { type: BRIDGE_ROUTE_TYPES.CANCEL, jobId: decodeURIComponent(cancelMatch[1]) };

  return { type: BRIDGE_ROUTE_TYPES.UNKNOWN };
}

function routeRequiresAuth(routeType) {
  return AUTH_REQUIRED_ROUTE_TYPES.includes(String(routeType || ""));
}

module.exports = {
  BRIDGE_ROUTE_TYPES,
  AUTH_REQUIRED_ROUTE_TYPES,
  parseBridgeRoute,
  routeRequiresAuth
};
