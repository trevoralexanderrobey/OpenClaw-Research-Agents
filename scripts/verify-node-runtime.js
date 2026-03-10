#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main() {
  const rootDir = path.resolve(__dirname, "..");
  const packageJson = readJson(path.join(rootDir, "package.json"));
  const expectedNode = String(packageJson.engines && packageJson.engines.node || "").trim();
  const actualNode = String(process.versions && process.versions.node || "").trim();

  if (!expectedNode) {
    throw new Error("package.json must declare engines.node");
  }

  if (actualNode !== expectedNode) {
    const error = new Error(`Unsupported Node runtime: expected ${expectedNode}, received ${actualNode}`);
    error.code = "OPENCLAW_NODE_RUNTIME_UNSUPPORTED";
    throw error;
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    runtime: "node",
    expected: expectedNode,
    actual: actualNode
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
}
