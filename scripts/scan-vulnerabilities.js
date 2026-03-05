#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalJson } = require("../workflows/governance-automation/common.js");
const { createSbomGenerator } = require("../workflows/supply-chain/sbom-generator.js");
const { createVulnerabilityReporter } = require("../workflows/supply-chain/vulnerability-reporter.js");

function parseArgs(argv) {
  const out = {
    rootDir: process.cwd(),
    sbomPath: "",
    advisoryDbPath: path.resolve(process.cwd(), "security", "vulnerability-advisories.json"),
    outPath: ""
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
    if (token === "--advisory-db") {
      out.advisoryDbPath = path.resolve(String(argv[index + 1] || out.advisoryDbPath));
      index += 1;
      continue;
    }
    if (token === "--out") {
      out.outPath = path.resolve(String(argv[index + 1] || ""));
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

  const reporter = createVulnerabilityReporter({});
  const result = reporter.scanVulnerabilities(sbom, args.advisoryDbPath);

  if (args.outPath) {
    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, canonicalJson(result), "utf8");
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (Array.isArray(result.violations) && result.violations.length > 0) {
    process.exit(1);
  }
}

main();
