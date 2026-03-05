"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");
const { validateTaskDefinition } = require("./task-definition-schema.js");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function makeError(code, message, details) {
  const error = new Error(String(message || "Agent engine error"));
  error.code = String(code || "PHASE14_AGENT_ENGINE_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeIso(value) {
  const text = safeString(value);
  if (!text || !Number.isFinite(Date.parse(text))) {
    return "1970-01-01T00:00:00.000Z";
  }
  return text;
}

function readFileText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function walkDirFiles(dirPath) {
  const out = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

function loadInputs(inputs) {
  const normalized = Array.isArray(inputs) ? inputs : [];
  const loaded = [];
  for (const input of normalized) {
    const inputPath = path.resolve(safeString(input.path || input));
    if (!inputPath || !fs.existsSync(inputPath)) {
      continue;
    }
    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      const files = walkDirFiles(inputPath);
      for (const filePath of files) {
        loaded.push({
          path: filePath,
          rel: path.relative(process.cwd(), filePath).split(path.sep).join("/"),
          content: readFileText(filePath)
        });
      }
      continue;
    }

    loaded.push({
      path: inputPath,
      rel: path.relative(process.cwd(), inputPath).split(path.sep).join("/"),
      content: readFileText(inputPath)
    });
  }

  loaded.sort((left, right) => left.rel.localeCompare(right.rel));
  return loaded;
}

function buildPrompt(taskDefinition, inputDocs) {
  const header = [
    "You are a local-first research agent.",
    `Task Type: ${taskDefinition.type}`,
    `Task Description: ${taskDefinition.description}`,
    `Output Format: ${taskDefinition.output_format}`,
    `Constraints: ${JSON.stringify(taskDefinition.constraints || {})}`,
    "Input Documents:"
  ].join("\n");

  const docs = inputDocs.map((doc, index) => [
    `--- DOC ${index + 1}: ${doc.rel} ---`,
    doc.content
  ].join("\n"));

  return `${header}\n${docs.join("\n")}`.trim();
}

function createAgentEngine(options = {}) {
  const logger = isPlainObject(options.logger) ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const config = isPlainObject(options.config) ? options.config : {};

  const governanceBridge = options.governanceBridge;
  const llmAdapter = options.llmAdapter;
  const outputManager = options.outputManager;

  if (!governanceBridge || typeof governanceBridge.requestTaskApproval !== "function") {
    throw makeError("PHASE14_AGENT_ENGINE_CONFIG_INVALID", "governanceBridge.requestTaskApproval is required");
  }
  if (!llmAdapter || typeof llmAdapter.complete !== "function") {
    throw makeError("PHASE14_AGENT_ENGINE_CONFIG_INVALID", "llmAdapter.complete is required");
  }
  if (!outputManager || typeof outputManager.saveOutput !== "function") {
    throw makeError("PHASE14_AGENT_ENGINE_CONFIG_INVALID", "outputManager.saveOutput is required");
  }

  const taskState = new Map();

  function setStatus(taskId, status, details = {}) {
    const existing = taskState.get(taskId) || {};
    const next = canonicalize({
      ...existing,
      task_id: taskId,
      status,
      updated_at: normalizeIso(timeProvider.nowIso()),
      ...details
    });
    taskState.set(taskId, next);
    return next;
  }

  async function executeTask(taskDefinition, context = {}) {
    let normalizedTask;
    try {
      normalizedTask = validateTaskDefinition(taskDefinition);
    } catch (error) {
      throw error;
    }

    const taskId = safeString(normalizedTask.task_id);
    const startedAt = normalizeIso(timeProvider.nowIso());
    setStatus(taskId, "pending", { task_definition: normalizedTask, started_at: startedAt });

    if (!context.supervisorDecision || context.supervisorDecision.approved !== true) {
      setStatus(taskId, "rejected", { reason: "SUPERVISOR_APPROVAL_REQUIRED" });
      throw makeError("SUPERVISOR_APPROVAL_REQUIRED", "Task execution requires a supervisor approval receipt", { task_id: taskId });
    }

    setStatus(taskId, "supervisor_approved", {
      supervisor_decision: canonicalize(context.supervisorDecision)
    });

    const approval = await governanceBridge.requestTaskApproval(normalizedTask, context);
    if (!approval || approval.approved !== true) {
      const rejection = setStatus(taskId, "rejected", {
        reason: safeString(approval && approval.reason) || "governance_rejected"
      });

      await outputManager.saveOutput(taskId, `Task rejected: ${rejection.reason}`, {
        status: "rejected",
        type: normalizedTask.type,
        output_format: normalizedTask.output_format,
        provider: safeString(context.provider) || "mock",
        model: safeString(context.model) || "mock-v1",
        started_at: startedAt,
        completed_at: normalizeIso(timeProvider.nowIso()),
        task_definition: normalizedTask,
        error_code: "PHASE14_TASK_REJECTED",
        error_message: rejection.reason
      });

      await governanceBridge.recordTaskExecution(taskId, {
        status: "rejected",
        reason: rejection.reason
      }, context);

      return canonicalize({ ok: false, task_id: taskId, status: "rejected", reason: rejection.reason });
    }

    setStatus(taskId, "governance_approved", {
      governance_decision: canonicalize(approval)
    });

    try {
      setStatus(taskId, "executing");
      const inputDocs = loadInputs(normalizedTask.inputs);
      const prompt = buildPrompt(normalizedTask, inputDocs);

      const completion = await llmAdapter.complete(prompt, {
        taskId,
        model: safeString(context.model),
        maxTokens: Number(config.maxTokensPerRequest || 0)
      });

      const completedAt = normalizeIso(timeProvider.nowIso());
      const outputWrite = outputManager.saveOutput(taskId, completion.text, {
        status: "completed",
        type: normalizedTask.type,
        output_format: normalizedTask.output_format,
        provider: completion.provider,
        model: completion.model,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: Number(completion.durationMs || 0),
        token_count: Number(completion.tokenCount || 0),
        task_definition: normalizedTask,
        provider_info: llmAdapter.getProviderInfo()
      });

      const rlhfResult = await governanceBridge.generateRLHFEntry(taskId, {
        prompt,
        response: completion.text,
        provider: completion.provider,
        model: completion.model,
        tokenCount: completion.tokenCount,
        durationMs: completion.durationMs
      }, {
        ...context,
        taskOutputDir: outputWrite.task_dir
      });

      outputManager.saveOutput(taskId, completion.text, {
        status: "completed",
        type: normalizedTask.type,
        output_format: normalizedTask.output_format,
        provider: completion.provider,
        model: completion.model,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: Number(completion.durationMs || 0),
        token_count: Number(completion.tokenCount || 0),
        task_definition: normalizedTask,
        provider_info: llmAdapter.getProviderInfo(),
        rlhf_local_mirror_path: safeString(rlhfResult.local_mirror_path)
      });

      const result = canonicalize({
        ok: true,
        task_id: taskId,
        status: "completed",
        output_path: outputWrite.output_path,
        metadata_path: outputWrite.metadata_path,
        manifest_path: outputWrite.manifest_path,
        token_count: Number(completion.tokenCount || 0),
        provider: completion.provider,
        model: completion.model
      });

      await governanceBridge.recordTaskExecution(taskId, result, context);
      setStatus(taskId, "completed", { completed_at: completedAt, result });

      logger.info({ event: "phase14_task_completed", task_id: taskId });
      return result;
    } catch (error) {
      const failedAt = normalizeIso(timeProvider.nowIso());
      const failure = canonicalize({
        status: "failed",
        error_code: safeString(error && error.code) || "PHASE14_TASK_FAILED",
        error_message: safeString(error && error.message) || "Task execution failed"
      });

      outputManager.saveOutput(taskId, `Task failed: ${failure.error_message}`, {
        status: "failed",
        type: normalizedTask.type,
        output_format: normalizedTask.output_format,
        provider: safeString(context.provider) || "mock",
        model: safeString(context.model) || "mock-v1",
        started_at: startedAt,
        completed_at: failedAt,
        task_definition: normalizedTask,
        error_code: failure.error_code,
        error_message: failure.error_message
      });

      await governanceBridge.recordTaskExecution(taskId, failure, context);
      setStatus(taskId, "failed", { completed_at: failedAt, ...failure });
      throw error;
    }
  }

  function getTaskStatus(taskId) {
    const normalizedTaskId = safeString(taskId);
    if (!normalizedTaskId) {
      return null;
    }
    if (taskState.has(normalizedTaskId)) {
      return canonicalize(taskState.get(normalizedTaskId));
    }
    const outputs = outputManager.listOutputs();
    const match = outputs.find((entry) => entry.task_id === normalizedTaskId);
    return match ? canonicalize(match) : null;
  }

  function listCompletedTasks() {
    return canonicalize(outputManager.listOutputs().filter((entry) => entry.status === "completed"));
  }

  function getTaskOutput(taskId) {
    return outputManager.getOutput(taskId);
  }

  return Object.freeze({
    executeTask,
    getTaskStatus,
    listCompletedTasks,
    getTaskOutput
  });
}

module.exports = {
  createAgentEngine
};
