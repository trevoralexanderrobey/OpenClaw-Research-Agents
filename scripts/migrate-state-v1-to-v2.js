#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const filePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.cwd(), "workspace", "runtime", "state.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  fail(`State file not found: ${filePath}`);
}

const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
const schemaVersion = Number(current.schemaVersion);
if (!Number.isFinite(schemaVersion)) {
  fail("State file is missing numeric schemaVersion");
}

if (schemaVersion === 2) {
  process.stdout.write(`State already schemaVersion 2: ${filePath}\n`);
  process.exit(0);
}

if (schemaVersion !== 1) {
  fail(`Unsupported source schemaVersion: ${schemaVersion}`);
}

const migrated = {
  schemaVersion: 2,
  deterministicSerialization: true,
  lastDeterministicReplayAt: null,
  activeInitiatives: Array.isArray(current.activeInitiatives) ? current.activeInitiatives : [],
  openLoops: Array.isArray(current.openLoops) ? current.openLoops : [],
  agentHealth: current.agentHealth && typeof current.agentHealth === "object" ? current.agentHealth : {},
  circuitBreakerState: current.circuitBreakerState && typeof current.circuitBreakerState === "object" ? current.circuitBreakerState : {},
  dailyTokenUsage: current.dailyTokenUsage && typeof current.dailyTokenUsage === "object" ? current.dailyTokenUsage : {},
  hydrationTimestamp: typeof current.hydrationTimestamp === "string" ? current.hydrationTimestamp : "1970-01-01T00:00:00.000Z",
};

fs.writeFileSync(filePath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
process.stdout.write(`Migrated state to schemaVersion 2: ${filePath}\n`);
