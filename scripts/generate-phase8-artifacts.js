#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { createApiGovernance } = require("../security/api-governance.js");
const { createReleaseGateGovernor } = require("../workflows/compliance-governance/release-gate-governor.js");
const { writePhase8Artifacts } = require("../analytics/compliance-explainability/attestation-explainer.js");

async function main() {
  const args = process.argv.slice(2);
  let outDir = path.resolve(process.cwd(), "audit", "evidence", "phase8");
  let asOfIso = "";
  let targetRef = "";
  let targetSha = "";

  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || "");
    if (token === "--as-of") {
      asOfIso = String(args[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--target-ref") {
      targetRef = String(args[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--target-sha") {
      targetSha = String(args[index + 1] || "").trim().toLowerCase();
      index += 1;
      continue;
    }
    if (!token.startsWith("-") && outDir === path.resolve(process.cwd(), "audit", "evidence", "phase8")) {
      outDir = path.resolve(token);
      continue;
    }
  }

  const governance = createApiGovernance();
  const releaseGateGovernor = createReleaseGateGovernor({
    apiGovernance: governance,
    operatorAuthorization: {
      consumeApprovalToken() {
        throw new Error("operatorAuthorization is not used for read-only evaluateReleaseGate in artifact generation");
      }
    }
  });

  const result = await writePhase8Artifacts({
    apiGovernance: governance,
    releaseGateGovernor,
    outDir,
    asOfIso,
    targetRef,
    targetSha
  });

  process.stdout.write(`Phase 8 artifacts generated at ${result.outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
