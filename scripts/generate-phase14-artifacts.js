#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { canonicalize, canonicalJson, sha256 } = require("../workflows/governance-automation/common.js");

function parseArgs(argv) {
  const out = {
    rootDir: process.cwd(),
    outDir: path.resolve(process.cwd(), "audit", "evidence", "agent-engine")
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--root") { out.rootDir = path.resolve(String(argv[i + 1] || out.rootDir)); i += 1; continue; }
    if (token === "--out") { out.outDir = path.resolve(String(argv[i + 1] || out.outDir)); i += 1; continue; }
  }
  return out;
}

function writeCanonical(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(value), "utf8");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outDir, { recursive: true });

  const runApproved = spawnSync("node", [
    "scripts/run-research-task.js",
    "--task", "Summarize the sample input documents",
    "--type", "summarize",
    "--input", "workspace/research-input/sample/",
    "--output", "workspace/research-output/",
    "--provider", "mock",
    "--confirm"
  ], {
    cwd: args.rootDir,
    encoding: "utf8"
  });

  const runDenied = spawnSync("node", [
    "scripts/run-research-task.js",
    "--task", "Summarize the sample input documents",
    "--type", "summarize",
    "--input", "workspace/research-input/sample/",
    "--output", "workspace/research-output/",
    "--provider", "mock"
  ], {
    cwd: args.rootDir,
    encoding: "utf8"
  });

  const interactionLogPath = path.join(args.rootDir, "security", "interaction-log.json");
  const outputIndexPath = path.join(args.rootDir, "workspace", "research-output", "tasks-index.json");

  const files = {
    "schema-snapshot.json": canonicalize({
      taskSchemaVersion: "phase14-task-definition-v1",
      interactionLogVersion: "phase14-interaction-log-v1"
    }),
    "mock-task-execution-sample.json": canonicalize({
      command: "node scripts/run-research-task.js --task ... --confirm",
      status: runApproved.status,
      stdout: String(runApproved.stdout || "").trim(),
      stderr: String(runApproved.stderr || "").trim()
    }),
    "interaction-log-sample.json": canonicalize(
      fs.existsSync(interactionLogPath) ? JSON.parse(fs.readFileSync(interactionLogPath, "utf8")) : {}
    ),
    "research-output-sample.json": canonicalize(
      fs.existsSync(outputIndexPath) ? JSON.parse(fs.readFileSync(outputIndexPath, "utf8")) : {}
    ),
    "governance-bridge-sample.json": canonicalize({
      supervisor_approved_run: {
        exit_status: runApproved.status,
        stdout: String(runApproved.stdout || "").trim()
      },
      supervisor_denied_run: {
        exit_status: runDenied.status,
        stdout: String(runDenied.stdout || "").trim(),
        stderr: String(runDenied.stderr || "").trim()
      }
    }),
    "phase14-gate-results.json": canonicalize({
      command: "bash scripts/verify-phase14-policy.sh",
      result: spawnSync("bash", ["scripts/verify-phase14-policy.sh"], { cwd: args.rootDir, encoding: "utf8" }).status
    })
  };

  for (const [name, value] of Object.entries(files)) {
    writeCanonical(path.join(args.outDir, name), value);
  }

  const sortedFiles = Object.keys(files).sort((left, right) => left.localeCompare(right));
  writeCanonical(path.join(args.outDir, "hash-manifest.json"), canonicalize({
    files: sortedFiles.map((name) => ({ file: name, sha256: hashFile(path.join(args.outDir, name)) }))
  }));

  process.stdout.write(`${JSON.stringify({ ok: true, out_dir: args.outDir, files: [...sortedFiles, "hash-manifest.json"] }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
