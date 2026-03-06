#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createTaskDefinition } = require("../openclaw-bridge/core/task-definition-schema.js");
const { validateMissionEnvelope } = require("../openclaw-bridge/core/mission-envelope-schema.js");
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
    missionTemplate: "",
    missionFile: "",
    resumeMission: "",
    createdAt: "",
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
    if (token === "--mission-template") { out.missionTemplate = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (token === "--mission-file") { out.missionFile = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (token === "--resume-mission") { out.resumeMission = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (token === "--created-at") { out.createdAt = String(argv[i + 1] || "").trim(); i += 1; continue; }
    if (token === "--operator-id") { out.operatorId = String(argv[i + 1] || "").trim() || out.operatorId; i += 1; continue; }
    if (token === "--confirm") { out.confirm = true; continue; }
    out.unknown.push(token);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  Legacy task mode:",
    "    node scripts/run-research-task.js --task \"<description>\" --type <task_type> [--input <dir|file>] [--output <dir>] [--provider <provider>] [--model <model>] [--token <phase13_token_id>] [--format markdown|json|text] --confirm",
    "  Mission mode:",
    "    node scripts/run-research-task.js --mission-template <template_id> --task \"<description>\" [--input <dir|file>] [--mission-file <json>] [--created-at <iso8601>] --confirm",
    "  Mission resume mode:",
    "    node scripts/run-research-task.js --resume-mission <mission_id> --confirm"
  ].join("\n");
}

function readMissionFile(filePath) {
  const resolved = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

async function requestSupervisorApproval(runtime, definition, args, correlationId) {
  try {
    return await runtime.governanceBridge.requestSupervisorApproval(definition, {
      confirm: args.confirm,
      operatorId: args.operatorId,
      correlationId
    });
  } catch (error) {
    return {
      approved: false,
      reason: safeString(error && error.code) || "supervisor_unavailable",
      decision_id: "sup-error"
    };
  }
}

async function runLegacyTask(runtime, args) {
  const inputPath = safeString(args.input) || runtime.config.inputDir;
  const taskDefinition = createTaskDefinition({
    type: safeString(args.type) || "freeform",
    description: args.task,
    inputs: inputPath ? [{ path: inputPath, type: "path" }] : [],
    outputFormat: safeString(args.format) || "markdown",
    constraints: {},
    createdAt: "2026-03-05T00:00:00.000Z"
  });
  const correlationId = `phase14-run-${taskDefinition.task_id}`;
  const supervisorDecision = await requestSupervisorApproval(runtime, taskDefinition, args, correlationId);

  if (!supervisorDecision || supervisorDecision.approved !== true) {
    await runtime.governanceBridge.recordTaskExecution(taskDefinition.task_id, {
      status: "rejected",
      reason: safeString(supervisorDecision && supervisorDecision.reason) || "supervisor_denied"
    }, {
      operatorId: args.operatorId,
      correlationId
    });
    return { ok: false, status: "rejected", reason: supervisorDecision.reason, task_id: taskDefinition.task_id };
  }

  return runtime.supervisorAuthority.runApprovedTask(taskDefinition, {
    confirm: true,
    operatorId: args.operatorId,
    token: safeString(args.token),
    provider: safeString(args.provider) || runtime.config.defaultProvider,
    model: safeString(args.model) || runtime.config.defaultModel,
    supervisorDecision,
    correlationId
  });
}

async function runMission(runtime, args) {
  const missionInput = args.missionFile ? readMissionFile(args.missionFile) : {};
  const missionEnvelope = validateMissionEnvelope({
    ...missionInput,
    template_id: safeString(args.missionTemplate) || safeString(missionInput.template_id || missionInput.templateId),
    description: safeString(args.task) || safeString(missionInput.description),
    inputs: safeString(args.input) ? [{ path: safeString(args.input), type: "path" }] : missionInput.inputs,
    constraints: missionInput.constraints || {},
    local_skills: missionInput.local_skills || missionInput.localSkills || [],
    hosted_skill_refs: missionInput.hosted_skill_refs || missionInput.hostedSkillRefs || [],
    created_at: safeString(args.createdAt) || safeString(missionInput.created_at || missionInput.createdAt)
  });
  const correlationId = `phase18-run-${missionEnvelope.mission_id}`;
  const supervisorDecision = await requestSupervisorApproval(runtime, {
    task_id: missionEnvelope.mission_id,
    description: missionEnvelope.description,
    type: "freeform",
    output_format: "json"
  }, args, correlationId);

  if (!supervisorDecision || supervisorDecision.approved !== true) {
    await runtime.governanceBridge.recordTaskExecution(missionEnvelope.mission_id, {
      status: "rejected",
      reason: safeString(supervisorDecision && supervisorDecision.reason) || "supervisor_denied"
    }, {
      operatorId: args.operatorId,
      correlationId
    });
    return { ok: false, status: "rejected", reason: supervisorDecision.reason, mission_id: missionEnvelope.mission_id };
  }

  const governanceDecision = await runtime.governanceBridge.requestTaskApproval({
    task_id: missionEnvelope.mission_id,
    description: missionEnvelope.description,
    type: "freeform",
    output_format: "json",
    constraints: { mission_template_id: missionEnvelope.template_id }
  }, {
    operatorId: args.operatorId,
    correlationId,
    token: safeString(args.token),
    supervisorDecision
  });
  if (!governanceDecision || governanceDecision.approved !== true) {
    await runtime.governanceBridge.recordTaskExecution(missionEnvelope.mission_id, {
      status: "rejected",
      reason: safeString(governanceDecision && governanceDecision.reason) || "governance_rejected"
    }, {
      operatorId: args.operatorId,
      correlationId
    });
    return { ok: false, status: "rejected", reason: governanceDecision.reason, mission_id: missionEnvelope.mission_id };
  }

  return runtime.agentSpawner.spawnMission(missionEnvelope, {
    confirm: true,
    operatorId: args.operatorId,
    token: safeString(args.token),
    provider: safeString(args.provider) || runtime.config.defaultProvider,
    model: safeString(args.model) || runtime.config.defaultModel,
    supervisorDecision,
    governanceDecision,
    correlationId
  });
}

async function resumeMission(runtime, args) {
  return runtime.agentSpawner.resumeMission(args.resumeMission, {
    confirm: true,
    operatorId: args.operatorId,
    correlationId: `phase18-resume-${safeString(args.resumeMission)}`,
    executeResumedTasks: true
  });
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

  const usingMissionMode = Boolean(args.missionTemplate || args.missionFile);
  const usingResumeMode = Boolean(args.resumeMission);

  if (args.unknown.length > 0 || (!args.task && !usingResumeMode && !usingMissionMode)) {
    await runtime.logCliRejection({
      actor: args.operatorId,
      action: "run_research_task",
      resource: "phase14.task",
      scope: "governance.compliance.scan",
      reason: "missing_required_args",
      metadata: {
        missing_task: !args.task && !usingResumeMode,
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
      resource: usingMissionMode || usingResumeMode ? "phase18.mission" : "phase14.task",
      scope: "governance.compliance.scan",
      reason: "missing_confirm",
      metadata: {
        task: args.task,
        type: args.type,
        mission_template: args.missionTemplate,
        resume_mission: args.resumeMission
      }
    });
    process.stderr.write("Task execution rejected: --confirm is required\n");
    process.exit(1);
  }

  let result;
  if (usingResumeMode) {
    result = await resumeMission(runtime, args);
  } else if (usingMissionMode) {
    result = await runMission(runtime, args);
  } else {
    result = await runLegacyTask(runtime, args);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result || result.ok !== true) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
