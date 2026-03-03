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

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeObject(value) {
  return isPlainObject(value) ? value : {};
}

if (!fs.existsSync(filePath)) {
  fail(`State file not found: ${filePath}`);
}

const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
const schemaVersion = Number(current.schemaVersion);
if (!Number.isFinite(schemaVersion)) {
  fail("State file is missing numeric schemaVersion");
}

if (schemaVersion === 3) {
  process.stdout.write(`State already schemaVersion 3: ${filePath}\n`);
  process.exit(0);
}

if (schemaVersion !== 2) {
  fail(`Unsupported source schemaVersion: ${schemaVersion}`);
}

const migrated = {
  schemaVersion: 3,
  deterministicSerialization: current.deterministicSerialization === true,
  lastDeterministicReplayAt: current.lastDeterministicReplayAt === null || typeof current.lastDeterministicReplayAt === "string"
    ? current.lastDeterministicReplayAt
    : null,
  activeInitiatives: Array.isArray(current.activeInitiatives) ? current.activeInitiatives : [],
  openLoops: Array.isArray(current.openLoops) ? current.openLoops : [],
  agentHealth: normalizeObject(current.agentHealth),
  circuitBreakerState: normalizeObject(current.circuitBreakerState),
  dailyTokenUsage: normalizeObject(current.dailyTokenUsage),
  hydrationTimestamp: typeof current.hydrationTimestamp === "string" ? current.hydrationTimestamp : "1970-01-01T00:00:00.000Z",
  apiGovernance: {
    dayKey: "1970-01-01",
    global: {
      requestsToday: 0,
      tokensToday: 0
    },
    window: {
      minuteEpoch: 0,
      globalRequests: 0,
      perMcpRequests: {}
    },
    perMcpDaily: {},
    violations: {
      count: 0,
      lastViolationAt: null,
      lastViolationCode: null
    }
  },
  researchIngestion: {
    nextSequence: 1,
    lastCommittedSequence: 0,
    hashVersion: "research-record-v1"
  }
};

fs.writeFileSync(filePath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
process.stdout.write(`Migrated state to schemaVersion 3: ${filePath}\n`);
