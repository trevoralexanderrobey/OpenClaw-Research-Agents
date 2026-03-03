"use strict";

const MCP_CONTAINER_PROFILES = Object.freeze({
  "semantic-scholar-mcp": Object.freeze({
    credentialHandle: "semantic_scholar_api_key",
    allowedHosts: ["api.semanticscholar.org"],
    writableVolumeNamespace: "scratch-semantic-scholar",
    runAsNonRoot: true,
    privileged: false,
    dropCapabilities: ["ALL"]
  }),
  "arxiv-scholar-mcp": Object.freeze({
    credentialHandle: "arxiv_api_key",
    allowedHosts: ["export.arxiv.org"],
    writableVolumeNamespace: "scratch-arxiv",
    runAsNonRoot: true,
    privileged: false,
    dropCapabilities: ["ALL"]
  }),
  "newsletter-publisher-mcp": Object.freeze({
    credentialHandle: "newsletter_api_key",
    allowedHosts: ["api.beehiiv.com"],
    writableVolumeNamespace: "scratch-newsletter",
    runAsNonRoot: true,
    privileged: false,
    dropCapabilities: ["ALL"]
  }),
  "notion-sync-mcp": Object.freeze({
    credentialHandle: "notion_api_key",
    allowedHosts: ["api.notion.com"],
    writableVolumeNamespace: "scratch-notion",
    runAsNonRoot: true,
    privileged: false,
    dropCapabilities: ["ALL"]
  })
});

function normalizeSlug(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolveMcpContainerProfile(slug) {
  const normalized = normalizeSlug(slug);
  return Object.prototype.hasOwnProperty.call(MCP_CONTAINER_PROFILES, normalized)
    ? MCP_CONTAINER_PROFILES[normalized]
    : null;
}

function assertCredentialIsolation(toolSlug, credentialHandle) {
  const profile = resolveMcpContainerProfile(toolSlug);
  if (!profile) {
    return;
  }
  const provided = typeof credentialHandle === "string" ? credentialHandle.trim().toLowerCase() : "";
  const expected = profile.credentialHandle;
  if (!provided || provided !== expected) {
    const error = new Error("Credential handle does not match MCP profile");
    error.code = "MCP_CREDENTIAL_ISOLATION_VIOLATION";
    error.details = { toolSlug: normalizeSlug(toolSlug), expected, provided };
    throw error;
  }
}

module.exports = {
  MCP_CONTAINER_PROFILES,
  resolveMcpContainerProfile,
  assertCredentialIsolation
};
