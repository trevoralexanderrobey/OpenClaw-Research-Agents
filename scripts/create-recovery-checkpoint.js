#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createApiGovernance } = require("../security/api-governance.js");
const { createCheckpointCoordinator } = require("../workflows/recovery-assurance/checkpoint-coordinator.js");
const { canonicalJson } = require("../workflows/governance-automation/common.js");

function parseArgs(argv) {
  const out = {
    outPath: "",
    prevCheckpointHash: "",
    rootDir: process.cwd(),
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--out") {
      out.outPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--prev-checkpoint-hash") {
      out.prevCheckpointHash = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--root") {
      out.rootDir = path.resolve(String(argv[index + 1] || out.rootDir));
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
    "  node scripts/create-recovery-checkpoint.js \\",
    "    [--prev-checkpoint-hash <sha256:...>] \\",
    "    [--out <path>]"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0) {
    process.stderr.write(`${usage()}\n`);
    process.stderr.write(`Unknown args: ${args.unknown.join(", ")}\n`);
    process.exit(1);
  }

  const apiGovernance = createApiGovernance();
  const coordinator = createCheckpointCoordinator({
    apiGovernance,
    timeProvider: {
      nowIso() {
        return "2026-03-05T00:00:00.000Z";
      }
    }
  });

  const result = await coordinator.createCheckpoint({
    rootDir: args.rootDir,
    prev_checkpoint_hash: args.prevCheckpointHash
  });

  if (!args.outPath) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const resolved = path.resolve(args.outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, canonicalJson(result), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, output: resolved, checkpoint_id: result.checkpoint_id }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
