#!/usr/bin/env node
"use strict";

const { buildPhase14Runtime } = require("./_phase14-agent-utils.js");

async function main() {
  const runtime = await buildPhase14Runtime();
  const tasks = runtime.outputManager.listOutputs();
  process.stdout.write(`${JSON.stringify({ count: tasks.length, tasks }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
