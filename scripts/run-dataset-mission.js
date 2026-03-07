#!/usr/bin/env node
"use strict";

const { buildPhase14Runtime } = require("./_phase14-agent-utils.js");
const { validateMissionEnvelope } = require("../openclaw-bridge/core/mission-envelope-schema.js");
const { createSchemaEngine } = require("../openclaw-bridge/dataset/schema-engine.js");
const { createDatasetBuilder } = require("../openclaw-bridge/dataset/dataset-builder.js");
const { createDatasetOutputManager } = require("../openclaw-bridge/dataset/dataset-output-manager.js");
const { safeString } = require("../workflows/governance-automation/common.js");

function parseArgs(argv) {
  const out = {
    task: "",
    input: "",
    missionTemplate: "dataset_sample",
    createdAt: "",
    datasetType: "",
    datasetId: "",
    targetSchema: "",
    qualityThreshold: "",
    packagingFormats: "jsonl",
    confirm: false,
    operatorId: process.env.OPERATOR_ID || "operator-cli",
    token: "",
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--task") { out.task = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--input") { out.input = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--mission-template") { out.missionTemplate = String(argv[index + 1] || "").trim() || "dataset_sample"; index += 1; continue; }
    if (token === "--created-at") { out.createdAt = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--dataset-type") { out.datasetType = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--dataset-id") { out.datasetId = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--target-schema") { out.targetSchema = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--quality-threshold") { out.qualityThreshold = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--packaging-formats") { out.packagingFormats = String(argv[index + 1] || "").trim() || "jsonl"; index += 1; continue; }
    if (token === "--token") { out.token = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--operator-id") { out.operatorId = String(argv[index + 1] || "").trim() || out.operatorId; index += 1; continue; }
    if (token === "--confirm") { out.confirm = true; continue; }
    out.unknown.push(token);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/run-dataset-mission.js --task \"<description>\" --dataset-type <type> [--input <dir|file>]",
    "    [--dataset-id <dataset_id>] [--mission-template dataset_sample]",
    "    [--target-schema <schema_version>] [--quality-threshold <number>]",
    "    [--packaging-formats jsonl,csv] [--created-at <iso8601>] [--token <phase13_token_id>]",
    "    [--operator-id <operator_id>] --confirm"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !args.task || !args.datasetType) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }
  if (!args.confirm) {
    process.stderr.write("Dataset mission rejected: --confirm is required\n");
    process.exit(1);
  }

  const runtime = await buildPhase14Runtime();
  const missionEnvelope = validateMissionEnvelope({
    template_id: safeString(args.missionTemplate) || "dataset_sample",
    description: safeString(args.task),
    inputs: safeString(args.input) ? [{ path: safeString(args.input), type: "path" }] : [],
    created_at: safeString(args.createdAt),
    mission_type: "research_to_dataset",
    dataset_type: safeString(args.datasetType),
    target_schema: safeString(args.targetSchema),
    quality_threshold: safeString(args.qualityThreshold),
    packaging_formats: safeString(args.packagingFormats).split(",").map((entry) => safeString(entry)).filter(Boolean),
    dataset_id: safeString(args.datasetId)
  });
  const correlationId = `phase19-dataset-mission-${missionEnvelope.mission_id}`;
  const supervisorDecision = await runtime.governanceBridge.requestSupervisorApproval({
    task_id: missionEnvelope.mission_id,
    description: missionEnvelope.description,
    type: "freeform",
    output_format: "json"
  }, {
    confirm: args.confirm,
    operatorId: args.operatorId,
    correlationId
  });
  if (!supervisorDecision || supervisorDecision.approved !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: "rejected", reason: safeString(supervisorDecision && supervisorDecision.reason) || "supervisor_denied", mission_id: missionEnvelope.mission_id }, null, 2)}\n`);
    process.exit(1);
  }

  const governanceDecision = await runtime.governanceBridge.requestTaskApproval({
    task_id: missionEnvelope.mission_id,
    description: missionEnvelope.description,
    type: "freeform",
    output_format: "json",
    constraints: {
      mission_template_id: missionEnvelope.template_id,
      mission_type: missionEnvelope.mission_type,
      dataset_type: missionEnvelope.dataset_type
    }
  }, {
    operatorId: args.operatorId,
    correlationId,
    token: safeString(args.token),
    supervisorDecision
  });
  if (!governanceDecision || governanceDecision.approved !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: "rejected", reason: safeString(governanceDecision && governanceDecision.reason) || "governance_rejected", mission_id: missionEnvelope.mission_id }, null, 2)}\n`);
    process.exit(1);
  }

  const missionResult = await runtime.agentSpawner.spawnMission(missionEnvelope, {
    confirm: true,
    operatorId: args.operatorId,
    token: safeString(args.token),
    provider: runtime.config.defaultProvider,
    model: runtime.config.defaultModel,
    supervisorDecision,
    governanceDecision,
    correlationId
  });

  const schemaEngine = createSchemaEngine({ rootDir: runtime.rootDir });
  const outputManager = createDatasetOutputManager({ rootDir: runtime.rootDir });
  const builder = createDatasetBuilder({
    rootDir: runtime.rootDir,
    schemaEngine,
    outputManager
  });

  const datasetResult = builder.buildDatasetFromSources({
    mission_id: missionEnvelope.mission_id,
    dataset_type: missionEnvelope.dataset_type,
    dataset_id: missionEnvelope.dataset_id,
    target_schema: missionEnvelope.target_schema,
    quality_threshold: missionEnvelope.quality_threshold,
    provenance_required: missionEnvelope.provenance_required,
    packaging_formats: missionEnvelope.packaging_formats
  });

  const result = {
    ok: Boolean(missionResult && missionResult.ok === true && datasetResult.ok === true),
    mission: missionResult,
    dataset: datasetResult
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
