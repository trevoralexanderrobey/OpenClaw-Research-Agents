#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$ROOT/.ci/npm-cache"
LOCK_PATH="$ROOT/security/npm-cache.lock.json"

node - "$CACHE_DIR" "$LOCK_PATH" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const cacheDir = process.argv[2];
const lockPath = process.argv[3];

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(lockPath)) {
  fail(`Cache lock file missing: ${lockPath}`);
}

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const files = Array.isArray(lock.files) ? lock.files : [];
const allowedVolatileNames = new Set(["_update-notifier-last-checked"]);

function walk(dir, output = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_logs") {
        continue;
      }
      walk(abs, output);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (allowedVolatileNames.has(entry.name) || entry.name.endsWith(".tmp")) {
      continue;
    }
    output.push(abs);
  }
  return output;
}

for (const file of files) {
  if (!file || typeof file !== "object") {
    fail("Invalid lock entry in npm-cache lock");
  }
  const relPath = String(file.path || "");
  const expectedSha = String(file.sha256 || "").toLowerCase();
  const expectedSize = Number(file.size || -1);
  const absPath = path.resolve(path.dirname(lockPath), relPath);

  if (!absPath.startsWith(path.resolve(cacheDir))) {
    fail(`Lock entry escapes cache directory: ${relPath}`);
  }

  if (!fs.existsSync(absPath)) {
    fail(`Cached file missing: ${relPath}`);
  }

  const stat = fs.statSync(absPath);
  if (stat.size !== expectedSize) {
    fail(`Cached file size mismatch: ${relPath}`);
  }

  const actualSha = crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
  if (actualSha !== expectedSha) {
    fail(`Cached file checksum mismatch: ${relPath}`);
  }
}

if (fs.existsSync(cacheDir)) {
  const volatilePath = path.join(cacheDir, "_update-notifier-last-checked");
  if (fs.existsSync(volatilePath)) {
    // Volatile npm metadata is intentionally excluded from the lock manifest.
    process.stdout.write("Ignoring volatile npm metadata file: _update-notifier-last-checked\n");
  }

  const actualFiles = walk(cacheDir).map((abs) => path.relative(path.dirname(lockPath), abs).replace(/\\/g, "/")).sort();
  const expectedFiles = files.map((entry) => String(entry.path)).sort();
  if (actualFiles.length !== expectedFiles.length) {
    fail("npm cache file count mismatch against lock manifest");
  }
  for (let i = 0; i < actualFiles.length; i += 1) {
    if (actualFiles[i] !== expectedFiles[i]) {
      fail(`Unexpected npm cache file drift: ${actualFiles[i]} != ${expectedFiles[i]}`);
    }
  }
}

const fileDigestPayload = files.map((entry) => ({
  path: entry.path,
  size: entry.size,
  sha256: entry.sha256,
}));
const expectedManifestHash = String(lock.manifestSha256 || "").toLowerCase();
const actualManifestHash = crypto
  .createHash("sha256")
  .update(JSON.stringify(fileDigestPayload))
  .digest("hex");

if (!expectedManifestHash || actualManifestHash !== expectedManifestHash) {
  fail("npm cache manifest checksum mismatch");
}

process.stdout.write("npm cache checksum verification passed\n");
NODE
