#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalJson, safeString } = require("../workflows/governance-automation/common.js");
const { canonicalHash } = require("../workflows/supply-chain/supply-chain-common.js");
const { createBuildProvenanceAttestor } = require("../workflows/supply-chain/build-provenance-attestor.js");

function parseArgs(argv) {
  const out = {
    commitSha: "",
    builderId: "",
    sbomPath: "",
    sbomHash: "",
    artifacts: [],
    outPath: "",
    generatedAt: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--commit-sha") {
      out.commitSha = safeString(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--builder-id") {
      out.builderId = safeString(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--sbom") {
      out.sbomPath = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (token === "--sbom-hash") {
      out.sbomHash = safeString(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--artifact") {
      out.artifacts.push(path.resolve(String(argv[index + 1] || "")));
      index += 1;
      continue;
    }
    if (token === "--out") {
      out.outPath = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (token === "--generated-at") {
      out.generatedAt = safeString(argv[index + 1]);
      index += 1;
      continue;
    }
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/generate-build-provenance.js \\",
    "    --commit-sha <sha> \\",
    "    --builder-id <builder> \\",
    "    (--sbom <sbom.json> | --sbom-hash <sha256:...>) \\",
    "    --artifact <path> [--artifact <path>] [--out <path>]"
  ].join("\n");
}

function resolveSbomHash(args) {
  if (args.sbomHash) {
    return args.sbomHash;
  }
  if (!args.sbomPath) {
    return "";
  }
  const sbom = JSON.parse(fs.readFileSync(args.sbomPath, "utf8"));
  return canonicalHash(sbom);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sbomHash = resolveSbomHash(args);
  if (!args.commitSha || !args.builderId || !sbomHash || args.artifacts.length === 0) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }

  const attestor = createBuildProvenanceAttestor({
    timeProvider: {
      nowIso: () => args.generatedAt || "1970-01-01T00:00:00.000Z"
    }
  });

  const result = attestor.generateProvenance({
    commit_sha: args.commitSha,
    builder_identity: args.builderId,
    sbom_hash: sbomHash,
    artifacts: args.artifacts.map((artifactPath) => ({ artifact_path: artifactPath })),
    policy_gates: {
      phase12: "generated"
    },
    generated_at: args.generatedAt
  });

  if (args.outPath) {
    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, canonicalJson(result.provenance), "utf8");
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
