#!/usr/bin/env node
"use strict";

const { buildPhase14Runtime } = require("./_phase14-agent-utils.js");
const { createSchemaEngine } = require("../openclaw-bridge/dataset/schema-engine.js");
const { createDatasetBuilder } = require("../openclaw-bridge/dataset/dataset-builder.js");
const { createDatasetOutputManager } = require("../openclaw-bridge/dataset/dataset-output-manager.js");
const { canonicalize, safeString, sha256 } = require("../workflows/governance-automation/common.js");

function parseArgs(argv) {
  const out = {
    taskId: "",
    missionId: "",
    datasetType: "",
    datasetId: "",
    targetSchema: "",
    qualityThreshold: "",
    provenanceRequired: false,
    packagingFormats: "jsonl",
    confirm: false,
    operatorId: process.env.OPERATOR_ID || "operator-cli",
    token: "",
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--task-id") { out.taskId = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--mission-id") { out.missionId = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--dataset-type") { out.datasetType = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--dataset-id") { out.datasetId = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--target-schema") { out.targetSchema = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--quality-threshold") { out.qualityThreshold = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--packaging-formats") { out.packagingFormats = String(argv[index + 1] || "").trim() || "jsonl"; index += 1; continue; }
    if (token === "--token") { out.token = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--operator-id") { out.operatorId = String(argv[index + 1] || "").trim() || out.operatorId; index += 1; continue; }
    if (token === "--provenance-required") { out.provenanceRequired = true; continue; }
    if (token === "--confirm") { out.confirm = true; continue; }
    out.unknown.push(token);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/build-dataset-from-task.js --dataset-type <type> [--task-id <task_id> | --mission-id <mission_id>]",
    "    [--dataset-id <dataset_id>] [--target-schema <schema_version>]",
    "    [--quality-threshold <number>] [--packaging-formats jsonl,csv] [--provenance-required]",
    "    [--token <phase13_token_id>] [--operator-id <operator_id>] --confirm"
  ].join("\n");
}

function computeSyntheticTaskId(args) {
  const seed = canonicalize({
    task_id: safeString(args.taskId),
    mission_id: safeString(args.missionId),
    dataset_type: safeString(args.datasetType),
    dataset_id: safeString(args.datasetId),
    target_schema: safeString(args.targetSchema),
    quality_threshold: safeString(args.qualityThreshold)
  });
  return `dataset-build-${sha256(JSON.stringify(seed)).slice(0, 24)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !args.datasetType || (!args.taskId && !args.missionId)) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }
  if (!args.confirm) {
    process.stderr.write("Dataset build rejected: --confirm is required\n");
    process.exit(1);
  }

  const runtime = await buildPhase14Runtime();
  const taskDefinition = {
    task_id: computeSyntheticTaskId(args),
    description: `Build dataset ${safeString(args.datasetType)} from ${safeString(args.taskId || args.missionId)}`,
    type: "freeform",
    output_format: "json",
    constraints: {
      dataset_type: safeString(args.datasetType),
      source_task_id: safeString(args.taskId),
      source_mission_id: safeString(args.missionId)
    }
  };
  const correlationId = `phase19-dataset-build-${taskDefinition.task_id}`;
  const supervisorDecision = await runtime.governanceBridge.requestSupervisorApproval(taskDefinition, {
    confirm: args.confirm,
    operatorId: args.operatorId,
    correlationId
  });
  if (!supervisorDecision || supervisorDecision.approved !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: "rejected", reason: safeString(supervisorDecision && supervisorDecision.reason) || "supervisor_denied", task_id: taskDefinition.task_id }, null, 2)}\n`);
    process.exit(1);
  }

  const governanceDecision = await runtime.governanceBridge.requestTaskApproval(taskDefinition, {
    operatorId: args.operatorId,
    correlationId,
    token: safeString(args.token),
    supervisorDecision
  });
  if (!governanceDecision || governanceDecision.approved !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: "rejected", reason: safeString(governanceDecision && governanceDecision.reason) || "governance_rejected", task_id: taskDefinition.task_id }, null, 2)}\n`);
    process.exit(1);
  }

  const schemaEngine = createSchemaEngine({ rootDir: runtime.rootDir });
  const outputManager = createDatasetOutputManager({ rootDir: runtime.rootDir });
  const builder = createDatasetBuilder({
    rootDir: runtime.rootDir,
    schemaEngine,
    outputManager
  });

  const result = builder.buildDatasetFromSources({
    task_ids: args.taskId ? [safeString(args.taskId)] : [],
    mission_id: safeString(args.missionId),
    dataset_type: safeString(args.datasetType),
    dataset_id: safeString(args.datasetId),
    target_schema: safeString(args.targetSchema),
    quality_threshold: safeString(args.qualityThreshold),
    provenance_required: args.provenanceRequired,
    packaging_formats: safeString(args.packagingFormats).split(",").map((entry) => safeString(entry)).filter(Boolean)
  });

  await runtime.governanceBridge.recordTaskExecution(taskDefinition.task_id, {
    status: result.ok ? "completed" : "failed",
    dataset_id: result.dataset_id,
    build_id: result.build_id,
    row_count: result.row_count
  }, {
    operatorId: args.operatorId,
    correlationId
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
