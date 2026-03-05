#!/usr/bin/env node
"use strict";

const { buildPhase14Runtime } = require("./_phase14-agent-utils.js");

function parseArgs(argv) {
  const out = { taskId: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--task-id") {
      out.taskId = String(argv[i + 1] || "").trim();
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.taskId) {
    process.stderr.write("Usage: node scripts/view-research-output.js --task-id <task_id>\n");
    process.exit(1);
  }

  const runtime = await buildPhase14Runtime();
  const output = runtime.outputManager.getOutput(args.taskId);
  if (!output) {
    process.stderr.write(`Task output not found: ${args.taskId}\n`);
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
