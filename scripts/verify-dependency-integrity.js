#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createSbomGenerator } = require("../workflows/supply-chain/sbom-generator.js");
const { createDependencyIntegrityVerifier } = require("../workflows/supply-chain/dependency-integrity-verifier.js");

function parseArgs(argv) {
  const out = {
    rootDir: process.cwd(),
    sbomPath: "",
    knownGoodPath: path.resolve(process.cwd(), "security", "known-good-dependencies.json")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--root") {
      out.rootDir = path.resolve(String(argv[index + 1] || out.rootDir));
      index += 1;
      continue;
    }
    if (token === "--sbom") {
      out.sbomPath = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (token === "--known-good") {
      out.knownGoodPath = path.resolve(String(argv[index + 1] || out.knownGoodPath));
      index += 1;
      continue;
    }
  }

  return out;
}

function loadSbom(args) {
  if (args.sbomPath) {
    return JSON.parse(fs.readFileSync(args.sbomPath, "utf8"));
  }

  const generator = createSbomGenerator({
    rootDir: args.rootDir,
    timeProvider: { nowIso: () => "1970-01-01T00:00:00.000Z" }
  });
  return generator.generateSbom().sbom;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sbom = loadSbom(args);
  const verifier = createDependencyIntegrityVerifier({
    knownGoodPath: args.knownGoodPath
  });

  const result = verifier.verifyDependencyIntegrity(sbom);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (!result.valid) {
    process.exit(1);
  }
}

main();
