#!/usr/bin/env node
"use strict";

const { buildPhase14Runtime } = require("./_phase14-agent-utils.js");

function parseArgs(argv) {
  const out = { taskId: "", provider: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--task-id") { out.taskId = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (argv[i] === "--provider") { out.provider = String(argv[i + 1] || "").trim(); i += 1; continue; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await buildPhase14Runtime();
  const interactions = runtime.interactionLog.getInteractions({
    taskId: args.taskId,
    provider: args.provider
  });

  process.stdout.write(`${JSON.stringify({ count: interactions.length, interactions }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
