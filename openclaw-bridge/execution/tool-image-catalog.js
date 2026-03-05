"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BUILTIN_TOOL_IMAGES = Object.freeze({
  "research-fetch-tool": "ghcr.io/openclaw-research/research-fetch-tool@sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "pdf-extractor-tool": "ghcr.io/openclaw-research/pdf-extractor-tool@sha256:2222222222222222222222222222222222222222222222222222222222222222",
  "latex-compiler-tool": "ghcr.io/openclaw-research/latex-compiler-tool@sha256:3333333333333333333333333333333333333333333333333333333333333333",
  "operator-stub-tool": "ghcr.io/openclaw-research/operator-stub-tool@sha256:4444444444444444444444444444444444444444444444444444444444444444",
  "arxiv-scholar-mcp": "ghcr.io/openclaw-research/arxiv-scholar-mcp@sha256:5555555555555555555555555555555555555555555555555555555555555555",
  "semantic-scholar-mcp": "ghcr.io/openclaw-research/semantic-scholar-mcp@sha256:6666666666666666666666666666666666666666666666666666666666666666",
  "newsletter-publisher-mcp": "ghcr.io/openclaw-research/newsletter-publisher-mcp@sha256:7777777777777777777777777777777777777777777777777777777777777777",
  "notion-sync-mcp": "ghcr.io/openclaw-research/notion-sync-mcp@sha256:8888888888888888888888888888888888888888888888888888888888888888"
});

function normalizeSlug(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isDigestPinned(ref) {
  return /^[^\s:@/]+(?:\/[^\s:@/]+)+@sha256:[a-f0-9]{64}$/.test(String(ref || "").trim());
}

function canonicalizeMap(map) {
  const out = {};
  for (const key of Object.keys(map).sort()) {
    out[key] = map[key];
  }
  return out;
}

function calculateToolRegistryChecksum(catalog = BUILTIN_TOOL_IMAGES) {
  const payload = `${JSON.stringify(canonicalizeMap(catalog))}\n`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function getToolImageCatalog() {
  return Object.freeze({ ...BUILTIN_TOOL_IMAGES });
}

function resolveToolImageReference(toolSlug, options = {}) {
  const slug = normalizeSlug(toolSlug);
  if (!slug) {
    return "";
  }

  const images = options && typeof options.images === "object" && options.images ? options.images : {};
  const override = typeof images[slug] === "string" ? images[slug].trim() : "";
  if (override) {
    return override;
  }

  return typeof BUILTIN_TOOL_IMAGES[slug] === "string" ? BUILTIN_TOOL_IMAGES[slug].trim() : "";
}

function getToolImage(toolSlug, options = {}) {
  return resolveToolImageReference(toolSlug, options);
}

function validateToolImagePolicy(toolSlug, options = {}) {
  const slug = normalizeSlug(toolSlug);
  if (!slug) {
    const error = new Error("toolSlug is required");
    error.code = "TOOL_IMAGE_SLUG_REQUIRED";
    throw error;
  }

  const image = resolveToolImageReference(slug, options);
  if (!image) {
    const error = new Error(`No image mapping found for tool '${slug}'`);
    error.code = "TOOL_IMAGE_NOT_FOUND";
    throw error;
  }
  if (!isDigestPinned(image)) {
    const error = new Error(`Tool image for '${slug}' must be digest pinned`);
    error.code = "TOOL_IMAGE_DIGEST_REQUIRED";
    throw error;
  }

  return {
    valid: true,
    toolSlug: slug,
    image,
  };
}

function assertCatalogDigestOnly(catalog = BUILTIN_TOOL_IMAGES) {
  for (const [slug, ref] of Object.entries(catalog)) {
    if (!isDigestPinned(ref)) {
      const error = new Error(`Tool image for '${slug}' must be digest pinned`);
      error.code = "TOOL_IMAGE_DIGEST_REQUIRED";
      throw error;
    }
  }
}

function assertRegistryChecksumLocked(lockPath) {
  const resolved = path.resolve(lockPath);
  const lock = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const expected = String(lock.registrySha256 || "").toLowerCase();
  const actual = calculateToolRegistryChecksum(BUILTIN_TOOL_IMAGES);
  if (!expected || actual !== expected) {
    const error = new Error("Tool registry checksum mismatch");
    error.code = "TOOL_REGISTRY_MUTATION_DETECTED";
    error.details = { expected, actual };
    throw error;
  }
}

assertCatalogDigestOnly(BUILTIN_TOOL_IMAGES);

module.exports = {
  BUILTIN_TOOL_IMAGES,
  getToolImageCatalog,
  resolveToolImageReference,
  getToolImage,
  validateToolImagePolicy,
  calculateToolRegistryChecksum,
  assertCatalogDigestOnly,
  assertRegistryChecksumLocked
};
