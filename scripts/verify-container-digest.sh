#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node - "$ROOT" <<'NODE'
const path = require("node:path");
const {
  BUILTIN_TOOL_IMAGES,
  assertCatalogDigestOnly,
} = require(path.join(process.argv[2], "openclaw-bridge", "execution", "tool-image-catalog.js"));

assertCatalogDigestOnly(BUILTIN_TOOL_IMAGES);
for (const [slug, image] of Object.entries(BUILTIN_TOOL_IMAGES)) {
  const trimmed = String(image || "").trim();
  const digestIndex = trimmed.indexOf("@sha256:");
  const withoutDigest = digestIndex === -1 ? trimmed : trimmed.slice(0, digestIndex);
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  if (/:latest(?:@|$)/i.test(trimmed) || hasTag) {
    process.stderr.write(`Tagged image reference forbidden for ${slug}: ${image}\n`);
    process.exit(1);
  }
}
process.stdout.write("Container digest-only verification passed\n");
NODE
