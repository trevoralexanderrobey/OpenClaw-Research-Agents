#!/usr/bin/env node
"use strict";

const { createTaskDefinition } = require("../openclaw-bridge/core/task-definition-schema.js");
const { buildPhase14Runtime } = require("./_phase14-agent-utils.js");

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseArgs(argv) {
  const out = {
    task: "",
    type: "freeform",
    input: "",
    output: "",
    provider: "",
    model: "",
    token: "",
    format: "markdown",
    confirm: false,
    operatorId: process.env.OPERATOR_ID || "operator-cli",
    unknown: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--task") { out.task = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (token === "--type") { out.type = String(argv[i + 1] || "").trim() || "freeform"; i += 1; continue; }
    if (token === "--input") { out.input = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (token === "--output") { out.output = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (token === "--provider") { out.provider = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (token === "--model") { out.model = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (token === "--token") { out.token = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (token === "--format") { out.format = String(argv[i + 1] || "").trim() || "markdown"; i += 1; continue; }
    if (token === "--operator-id") { out.operatorId = String(argv[i + 1] || "").trim() || out.operatorId; i += 1; continue; }
    if (token === "--confirm") { out.confirm = true; continue; }
    out.unknown.push(token);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/run-research-task.js --task \"<description>\" --type <task_type> [--input <dir|file>] [--output <dir>] [--provider <provider>] [--model <model>] [--token <phase13_token_id>] [--format markdown|json|text] --confirm"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await buildPhase14Runtime({
    config: {
      inputDir: safeString(args.input),
      outputDir: safeString(args.output),
      provider: safeString(args.provider),
      model: safeString(args.model)
    }
  });

  if (args.unknown.length > 0 || !args.task) {
    await runtime.logCliRejection({
      actor: args.operatorId,
      action: "run_research_task",
      resource: "phase14.task",
      scope: "governance.compliance.scan",
      reason: "missing_required_args",
      metadata: {
        missing_task: !args.task,
        unknown: args.unknown
      }
    });
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }

  if (!args.confirm) {
    await runtime.logCliRejection({
      actor: args.operatorId,
      action: "run_research_task",
      resource: "phase14.task",
      scope: "governance.compliance.scan",
      reason: "missing_confirm",
      metadata: {
        task: args.task,
        type: args.type
      }
    });
    process.stderr.write("Task execution rejected: --confirm is required\n");
    process.exit(1);
  }

  const inputPath = safeString(args.input) || runtime.config.inputDir;
  const taskDefinition = createTaskDefinition({
    type: safeString(args.type) || "freeform",
    description: args.task,
    inputs: inputPath ? [{ path: inputPath, type: "path" }] : [],
    outputFormat: safeString(args.format) || "markdown",
    constraints: {},
    createdAt: "2026-03-05T00:00:00.000Z"
  });

  let supervisorDecision;
  try {
    supervisorDecision = await runtime.governanceBridge.requestSupervisorApproval(taskDefinition, {
      confirm: args.confirm,
      operatorId: args.operatorId,
      correlationId: `phase14-run-${taskDefinition.task_id}`
    });
  } catch (error) {
    supervisorDecision = {
      approved: false,
      reason: safeString(error && error.code) || "supervisor_unavailable",
      decision_id: "sup-error"
    };
  }

  if (!supervisorDecision || supervisorDecision.approved !== true) {
    await runtime.governanceBridge.recordTaskExecution(taskDefinition.task_id, {
      status: "rejected",
      reason: safeString(supervisorDecision && supervisorDecision.reason) || "supervisor_denied"
    }, {
      operatorId: args.operatorId,
      correlationId: `phase14-run-${taskDefinition.task_id}`
    });
    process.stdout.write(`${JSON.stringify({ ok: false, status: "rejected", reason: supervisorDecision.reason, task_id: taskDefinition.task_id }, null, 2)}\n`);
    process.exit(1);
  }

  const result = await runtime.supervisorAuthority.runApprovedTask(taskDefinition, {
    confirm: true,
    operatorId: args.operatorId,
    token: safeString(args.token),
    provider: safeString(args.provider) || runtime.config.defaultProvider,
    model: safeString(args.model) || runtime.config.defaultModel,
    supervisorDecision,
    correlationId: `phase14-run-${taskDefinition.task_id}`
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result || result.ok !== true) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
