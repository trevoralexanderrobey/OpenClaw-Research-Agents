"use strict";

const MCP_METHOD_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const MCP_METHODS = Object.freeze({
  RESEARCH_SEARCH: "research_search",
  RESEARCH_GET_PAPER: "research_getPaper",
  ANALYTICS_MONETIZATION_SCORE: "analytics_monetizationScore",
  MUTATION_PREPARE_PUBLICATION: "mutation_preparePublication",
  MUTATION_COMMIT_PUBLICATION: "mutation_commitPublication",
  MUTATION_RETRY_PUBLICATION: "mutation_retryPublication",
  MUTATION_RECONCILE_PUBLICATION: "mutation_reconcilePublication",
  MUTATION_SET_MUTATION_ENABLED: "mutation_setMutationEnabled",
  MUTATION_SET_KILL_SWITCH: "mutation_setKillSwitch"
});

const MCP_METHOD_ALIASES = Object.freeze({
  "research.search": MCP_METHODS.RESEARCH_SEARCH,
  "research.getPaper": MCP_METHODS.RESEARCH_GET_PAPER,
  "analytics.monetizationScore": MCP_METHODS.ANALYTICS_MONETIZATION_SCORE,
  "mutation.preparePublication": MCP_METHODS.MUTATION_PREPARE_PUBLICATION,
  "mutation.commitPublication": MCP_METHODS.MUTATION_COMMIT_PUBLICATION,
  "mutation.retryPublication": MCP_METHODS.MUTATION_RETRY_PUBLICATION,
  "mutation.reconcilePublication": MCP_METHODS.MUTATION_RECONCILE_PUBLICATION,
  "mutation.setMutationEnabled": MCP_METHODS.MUTATION_SET_MUTATION_ENABLED,
  "mutation.setKillSwitch": MCP_METHODS.MUTATION_SET_KILL_SWITCH
});

const MCP_METHOD_ALLOWLIST = Object.freeze([
  MCP_METHODS.RESEARCH_SEARCH,
  MCP_METHODS.RESEARCH_GET_PAPER,
  MCP_METHODS.ANALYTICS_MONETIZATION_SCORE
]);

const MCP_OPERATOR_METHOD_ALLOWLIST = Object.freeze([
  MCP_METHODS.MUTATION_PREPARE_PUBLICATION,
  MCP_METHODS.MUTATION_COMMIT_PUBLICATION,
  MCP_METHODS.MUTATION_RETRY_PUBLICATION,
  MCP_METHODS.MUTATION_RECONCILE_PUBLICATION,
  MCP_METHODS.MUTATION_SET_MUTATION_ENABLED,
  MCP_METHODS.MUTATION_SET_KILL_SWITCH
]);

function sanitizeToolLikeName(input) {
  const raw = String(input || "");
  return raw
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeMcpMethodName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const aliased = Object.prototype.hasOwnProperty.call(MCP_METHOD_ALIASES, raw)
    ? MCP_METHOD_ALIASES[raw]
    : raw;
  return String(aliased).trim();
}

function isValidToolLikeName(value) {
  return MCP_METHOD_NAME_PATTERN.test(String(value || ""));
}

module.exports = {
  MCP_METHODS,
  MCP_METHOD_ALIASES,
  MCP_METHOD_ALLOWLIST,
  MCP_OPERATOR_METHOD_ALLOWLIST,
  MCP_METHOD_NAME_PATTERN,
  sanitizeToolLikeName,
  normalizeMcpMethodName,
  isValidToolLikeName
};
