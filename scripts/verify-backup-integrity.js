#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createBackupIntegrityVerifier } = require("../workflows/recovery-assurance/backup-integrity-verifier.js");

function parseArgs(argv) {
  const out = {
    manifestPath: "",
    rootDir: process.cwd(),
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--manifest") {
      out.manifestPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--root") {
      out.rootDir = path.resolve(String(argv[index + 1] || out.rootDir));
      index += 1;
      continue;
    }
    out.unknown.push(token);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/verify-backup-integrity.js \\",
    "    --manifest <path/to/backup-manifest.json> [--root <repo-root>]"
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !args.manifestPath) {
    process.stderr.write(`${usage()}\n`);
    if (args.unknown.length > 0) {
      process.stderr.write(`Unknown args: ${args.unknown.join(", ")}\n`);
    }
    process.exit(1);
  }

  const resolvedManifest = path.resolve(args.manifestPath);
  if (!fs.existsSync(resolvedManifest)) {
    process.stderr.write(`Manifest not found: ${resolvedManifest}\n`);
    process.exit(1);
  }

  const manifest = readJson(resolvedManifest);
  const verifier = createBackupIntegrityVerifier({});
  const result = verifier.verifyBackupIntegrity({
    manifest,
    rootDir: args.rootDir
  });

  process.stdout.write(`${JSON.stringify({ manifest: resolvedManifest, result }, null, 2)}\n`);
  if (!result.valid) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
