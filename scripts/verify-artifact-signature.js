#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createArtifactSigningManager } = require("../workflows/supply-chain/artifact-signing-manager.js");

function parseArgs(argv) {
  const out = {
    signatureRecordPath: "",
    keyPath: path.resolve(process.cwd(), "security", "artifact-signing-key.json")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--signature-record") {
      out.signatureRecordPath = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (token === "--key-path") {
      out.keyPath = path.resolve(String(argv[index + 1] || out.keyPath));
      index += 1;
      continue;
    }
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/verify-artifact-signature.js \\",
    "    --signature-record <path/to/signature-record.json> [--key-path <path>]"
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.signatureRecordPath) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }

  if (!fs.existsSync(args.signatureRecordPath)) {
    process.stderr.write(`Signature record not found: ${args.signatureRecordPath}\n`);
    process.exit(1);
  }

  const signatureRecord = JSON.parse(fs.readFileSync(args.signatureRecordPath, "utf8"));
  const manager = createArtifactSigningManager({ keyPath: args.keyPath });
  const result = manager.verifySignature(signatureRecord, args.keyPath);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (!result.valid) {
    process.exit(1);
  }
}

main();
