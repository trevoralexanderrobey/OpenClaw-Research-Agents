#!/usr/bin/env node
"use strict";

const { buildPhase14Runtime } = require("./_phase14-agent-utils.js");

function parseArgs(argv) {
  const out = { provider: "", model: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--provider") { out.provider = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (argv[i] === "--model") { out.model = String(argv[i + 1] || "").trim(); i += 1; continue; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await buildPhase14Runtime({
    config: {
      provider: args.provider,
      model: args.model
    }
  });

  const response = await runtime.llmAdapter.complete("Phase14 connectivity test prompt", {
    taskId: "phase14-connection-test",
    model: args.model
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    provider: response.provider,
    model: response.model,
    tokenCount: response.tokenCount,
    textPreview: String(response.text || "").slice(0, 200)
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
