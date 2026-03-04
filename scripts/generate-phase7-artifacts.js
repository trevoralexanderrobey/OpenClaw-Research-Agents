#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { createApiGovernance } = require("../security/api-governance.js");
const { writePhase7Artifacts } = require("../analytics/experiment-explainability/decision-explainer.js");

async function main() {
  const args = process.argv.slice(2);
  let outDir = path.resolve(process.cwd(), "audit", "evidence", "phase7");
  let asOfIso = "";

  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || "");
    if (token === "--as-of") {
      asOfIso = String(args[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (!token.startsWith("-") && outDir === path.resolve(process.cwd(), "audit", "evidence", "phase7")) {
      outDir = path.resolve(token);
      continue;
    }
  }

  const governance = createApiGovernance();
  const result = await writePhase7Artifacts({
    apiGovernance: governance,
    outDir,
    asOfIso
  });

  process.stdout.write(`Phase 7 artifacts generated at ${result.outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
