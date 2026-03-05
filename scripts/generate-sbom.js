#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalJson, safeString } = require("../workflows/governance-automation/common.js");
const { createSbomGenerator } = require("../workflows/supply-chain/sbom-generator.js");

function parseArgs(argv) {
  const out = {
    rootDir: process.cwd(),
    outPath: path.resolve(process.cwd(), "audit", "evidence", "phase2", "sbom.cyclonedx.json"),
    generatedAt: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--root") {
      out.rootDir = path.resolve(String(argv[index + 1] || out.rootDir));
      index += 1;
      continue;
    }
    if (token === "--out") {
      out.outPath = path.resolve(String(argv[index + 1] || out.outPath));
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const generator = createSbomGenerator({
    rootDir: args.rootDir,
    generatedAt: args.generatedAt,
    timeProvider: {
      nowIso: () => "1970-01-01T00:00:00.000Z"
    }
  });

  const result = generator.generateSbom();
  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, canonicalJson(result.sbom), "utf8");

  process.stdout.write(`${JSON.stringify({
    out_path: args.outPath,
    sbom_hash: result.sbom_hash,
    component_count: result.component_count,
    generated_at: result.generated_at
  }, null, 2)}\n`);
}

main();
