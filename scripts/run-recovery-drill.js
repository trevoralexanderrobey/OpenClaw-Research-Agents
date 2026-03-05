#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createChaosDrillSimulator } = require("../workflows/recovery-assurance/chaos-drill-simulator.js");
const { canonicalJson } = require("../workflows/governance-automation/common.js");

function parseArgs(argv) {
  const out = {
    scenario: "component_failure",
    checkpointId: "",
    outPath: "",
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--scenario") {
      out.scenario = String(argv[index + 1] || out.scenario).trim() || out.scenario;
      index += 1;
      continue;
    }
    if (token === "--checkpoint-id") {
      out.checkpointId = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--out") {
      out.outPath = String(argv[index + 1] || "").trim();
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
    "  node scripts/run-recovery-drill.js \\",
    "    [--scenario component_failure|integrity_drift|checkpoint_rollback] \\",
    "    [--checkpoint-id <id>] [--out <path>]"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0) {
    process.stderr.write(`${usage()}\n`);
    process.stderr.write(`Unknown args: ${args.unknown.join(", ")}\n`);
    process.exit(1);
  }

  const simulator = createChaosDrillSimulator({
    timeProvider: {
      nowIso() {
        return "2026-03-05T00:00:00.000Z";
      }
    }
  });

  const result = simulator.runDrill({
    scenario: args.scenario,
    checkpoint_id: args.checkpointId
  });

  if (!args.outPath) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const resolved = path.resolve(args.outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, canonicalJson(result), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, output: resolved, drill_id: result.drill_id }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
