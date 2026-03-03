#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_PATH="$ROOT/security/tool-registry.lock.json"

node - "$ROOT" "$LOCK_PATH" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
const lockPath = process.argv[3];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(lockPath)) {
  fail(`Missing lock file: ${lockPath}`);
}

const catalog = require(path.join(root, "openclaw-bridge", "execution", "tool-image-catalog.js"));
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const expected = String(lock.registrySha256 || "").toLowerCase();
const actual = String(catalog.calculateToolRegistryChecksum(catalog.BUILTIN_TOOL_IMAGES || {})).toLowerCase();

catalog.assertCatalogDigestOnly(catalog.BUILTIN_TOOL_IMAGES || {});

if (!expected || expected !== actual) {
  fail(`Tool registry checksum mismatch. expected=${expected} actual=${actual}`);
}

process.stdout.write("Tool registry checksum verification passed\n");
NODE
