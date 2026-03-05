#!/usr/bin/env node
"use strict";

const { execSync } = require("node:child_process");

const PHASE_13_MERGE_SHA = "a6462361e6aa985ecdbf6b90a8c7c96698649fcf";
const PHASE_13_GREEN_RUN_ID = "22714729766";

function main() {
  const head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim().toLowerCase();
  if (head !== PHASE_13_MERGE_SHA) {
    process.stderr.write(`Baseline mismatch: expected ${PHASE_13_MERGE_SHA}, got ${head}\n`);
    process.exit(1);
  }

  if (process.env.PHASE14_SKIP_GH_CHECK === "1") {
    process.stdout.write(`${JSON.stringify({ ok: true, head, run_id: PHASE_13_GREEN_RUN_ID, gh_check: "skipped" }, null, 2)}\n`);
    return;
  }

  try {
    const output = execSync(`gh run view ${PHASE_13_GREEN_RUN_ID} --json conclusion,headSha,name`, { encoding: "utf8" }).trim();
    const parsed = JSON.parse(output);
    if ((parsed.conclusion || "").toLowerCase() !== "success") {
      process.stderr.write(`Baseline run ${PHASE_13_GREEN_RUN_ID} is not successful\n`);
      process.exit(1);
    }
    if ((parsed.headSha || "").toLowerCase() !== PHASE_13_MERGE_SHA) {
      process.stderr.write(`Baseline run SHA mismatch for run ${PHASE_13_GREEN_RUN_ID}\n`);
      process.exit(1);
    }
  } catch (error) {
    process.stderr.write(`Failed to verify baseline run ${PHASE_13_GREEN_RUN_ID}: ${error && error.message ? error.message : String(error)}\n`);
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, head, run_id: PHASE_13_GREEN_RUN_ID }, null, 2)}\n`);
}

main();
