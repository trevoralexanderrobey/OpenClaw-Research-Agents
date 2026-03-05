#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalJson } = require("../workflows/governance-automation/common.js");
const { createArtifactSigningManager } = require("../workflows/supply-chain/artifact-signing-manager.js");

function parseArgs(argv) {
  const out = {
    artifactPath: "",
    sbomHash: "",
    provenanceHash: "",
    keyPath: path.resolve(process.cwd(), "security", "artifact-signing-key.json"),
    outPath: "",
    generatedAt: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--artifact") {
      out.artifactPath = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (token === "--sbom-hash") {
      out.sbomHash = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--provenance-hash") {
      out.provenanceHash = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--key-path") {
      out.keyPath = path.resolve(String(argv[index + 1] || out.keyPath));
      index += 1;
      continue;
    }
    if (token === "--out") {
      out.outPath = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (token === "--generated-at") {
      out.generatedAt = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/sign-artifact.js \\",
    "    --artifact <path> \\",
    "    --sbom-hash <sha256:...> \\",
    "    --provenance-hash <sha256:...> [--key-path <path>] [--out <path>]"
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.artifactPath || !args.sbomHash || !args.provenanceHash) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }

  const manager = createArtifactSigningManager({
    keyPath: args.keyPath,
    timeProvider: {
      nowIso: () => args.generatedAt || "1970-01-01T00:00:00.000Z"
    }
  });

  const result = manager.signArtifact({
    artifact_path: args.artifactPath,
    sbom_hash: args.sbomHash,
    provenance_hash: args.provenanceHash,
    keyPath: args.keyPath,
    timestamp: args.generatedAt
  });

  if (args.outPath) {
    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, canonicalJson(result.signature_record), "utf8");
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
