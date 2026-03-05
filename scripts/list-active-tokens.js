#!/usr/bin/env node
"use strict";

const { buildPhase13Runtime } = require("./_phase13-access-utils.js");

function main() {
  const runtime = buildPhase13Runtime();
  const result = runtime.tokenManager.listActiveTokens();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
