"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

const INDEX_FILE = "tasks-index.json";

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeIso(value) {
  const text = safeString(value);
  if (!text || !Number.isFinite(Date.parse(text))) {
    return "1970-01-01T00:00:00.000Z";
  }
  return text;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, canonicalJson(canonicalize(value)), "utf8");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath, "utf8"));
}

function detectOutputFile(taskDir) {
  for (const candidate of ["output.md", "output.json", "output.txt"]) {
    const abs = path.join(taskDir, candidate);
    if (fs.existsSync(abs)) {
      return abs;
    }
  }
  return "";
}

function buildTaskIndexRecord(input = {}) {
  return canonicalize({
    task_id: safeString(input.task_id),
    mission_id: safeString(input.mission_id),
    agent_id: safeString(input.agent_id),
    subtask_id: safeString(input.subtask_id),
    status: safeString(input.status) || "completed",
    type: safeString(input.type) || "freeform",
    output_format: safeString(input.output_format) || "markdown",
    provider: safeString(input.provider) || "mock",
    model: safeString(input.model) || "mock-v1",
    started_at: normalizeIso(input.started_at),
    completed_at: normalizeIso(input.completed_at),
    output_path: safeString(input.output_path),
    manifest_path: safeString(input.manifest_path),
    metadata_path: safeString(input.metadata_path),
    error_code: safeString(input.error_code),
    error_message: safeString(input.error_message)
  });
}

function createResearchOutputManager(options = {}) {
  const logger = isPlainObject(options.logger) ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const outputDir = path.resolve(safeString(options.outputDir) || path.join(process.cwd(), "workspace", "research-output"));
  const indexPath = path.join(outputDir, INDEX_FILE);

  function loadIndex() {
    const state = readJson(indexPath, { schema_version: "phase14-output-index-v1", tasks: [] });
    const tasks = Array.isArray(state.tasks) ? state.tasks.map((item) => buildTaskIndexRecord(item)) : [];
    tasks.sort((left, right) => left.task_id.localeCompare(right.task_id));
    return { schema_version: "phase14-output-index-v1", tasks };
  }

  function persistIndex(index) {
    writeJson(indexPath, canonicalize(index));
  }

  function renderOutputContent(output, outputFormat) {
    if (outputFormat === "json") {
      const body = isPlainObject(output) || Array.isArray(output) ? output : { content: String(output || "") };
      return `${JSON.stringify(canonicalize(body), null, 2)}\n`;
    }
    return `${String(output || "").trim()}\n`;
  }

  function resolveOutputFileName(outputFormat) {
    if (outputFormat === "json") return "output.json";
    if (outputFormat === "text") return "output.txt";
    return "output.md";
  }

  function saveOutput(taskId, output, metadata = {}) {
    const normalizedTaskId = safeString(taskId);
    if (!normalizedTaskId) {
      const error = new Error("taskId is required");
      error.code = "PHASE14_OUTPUT_TASK_ID_REQUIRED";
      throw error;
    }

    const taskDir = path.join(outputDir, normalizedTaskId);
    ensureDir(taskDir);

    const outputFormat = safeString(metadata.output_format || metadata.outputFormat) || "markdown";
    const outputFile = resolveOutputFileName(outputFormat);
    const outputPath = path.join(taskDir, outputFile);
    fs.writeFileSync(outputPath, renderOutputContent(output, outputFormat), "utf8");

    const metadataPath = path.join(taskDir, "metadata.json");
    const normalizedMetadata = canonicalize({
      task_id: normalizedTaskId,
      mission_id: safeString(metadata.mission_id || metadata.missionId),
      agent_id: safeString(metadata.agent_id || metadata.agentId),
      subtask_id: safeString(metadata.subtask_id || metadata.subtaskId),
      status: safeString(metadata.status) || "completed",
      type: safeString(metadata.type) || "freeform",
      output_format: outputFormat,
      provider: safeString(metadata.provider) || "mock",
      model: safeString(metadata.model) || "mock-v1",
      started_at: normalizeIso(metadata.started_at || metadata.startedAt || timeProvider.nowIso()),
      completed_at: normalizeIso(metadata.completed_at || metadata.completedAt || timeProvider.nowIso()),
      duration_ms: Math.max(0, Number.parseInt(String(metadata.duration_ms || metadata.durationMs || 0), 10) || 0),
      token_count: Math.max(0, Number.parseInt(String(metadata.token_count || metadata.tokenCount || 0), 10) || 0),
      task_definition: isPlainObject(metadata.task_definition || metadata.taskDefinition)
        ? canonicalize(metadata.task_definition || metadata.taskDefinition)
        : {},
      provider_info: isPlainObject(metadata.provider_info || metadata.providerInfo)
        ? canonicalize(metadata.provider_info || metadata.providerInfo)
        : {},
      error_code: safeString(metadata.error_code),
      error_message: safeString(metadata.error_message),
      rlhf_local_mirror_path: safeString(metadata.rlhf_local_mirror_path)
    });
    writeJson(metadataPath, normalizedMetadata);

    const manifestPath = path.join(taskDir, "manifest.json");
    const manifest = canonicalize({
      schema_version: "phase14-output-manifest-v1",
      task_id: normalizedTaskId,
      files: [
        { file: outputFile, sha256: hashFile(outputPath) },
        { file: "metadata.json", sha256: hashFile(metadataPath) }
      ].sort((left, right) => left.file.localeCompare(right.file))
    });
    writeJson(manifestPath, manifest);

    const index = loadIndex();
    const record = buildTaskIndexRecord({
      task_id: normalizedTaskId,
      mission_id: normalizedMetadata.mission_id,
      agent_id: normalizedMetadata.agent_id,
      subtask_id: normalizedMetadata.subtask_id,
      status: normalizedMetadata.status,
      type: normalizedMetadata.type,
      output_format: outputFormat,
      provider: normalizedMetadata.provider,
      model: normalizedMetadata.model,
      started_at: normalizedMetadata.started_at,
      completed_at: normalizedMetadata.completed_at,
      output_path: path.relative(outputDir, outputPath).split(path.sep).join("/"),
      manifest_path: path.relative(outputDir, manifestPath).split(path.sep).join("/"),
      metadata_path: path.relative(outputDir, metadataPath).split(path.sep).join("/"),
      error_code: normalizedMetadata.error_code,
      error_message: normalizedMetadata.error_message
    });

    const withoutCurrent = index.tasks.filter((entry) => entry.task_id !== normalizedTaskId);
    withoutCurrent.push(record);
    withoutCurrent.sort((left, right) => left.task_id.localeCompare(right.task_id));
    index.tasks = withoutCurrent;
    persistIndex(index);

    logger.info({ event: "phase14_output_saved", task_id: normalizedTaskId, output_format: outputFormat });

    return canonicalize({
      task_id: normalizedTaskId,
      task_dir: taskDir,
      output_path: outputPath,
      metadata_path: metadataPath,
      manifest_path: manifestPath,
      index_path: indexPath
    });
  }

  function getOutput(taskId) {
    const normalizedTaskId = safeString(taskId);
    if (!normalizedTaskId) {
      return null;
    }

    const taskDir = path.join(outputDir, normalizedTaskId);
    const outputPath = detectOutputFile(taskDir);
    if (!outputPath) {
      return null;
    }

    const metadataPath = path.join(taskDir, "metadata.json");
    const manifestPath = path.join(taskDir, "manifest.json");

    return canonicalize({
      task_id: normalizedTaskId,
      output_path: outputPath,
      output: fs.readFileSync(outputPath, "utf8"),
      metadata: readJson(metadataPath, {}),
      manifest: readJson(manifestPath, {})
    });
  }

  function listOutputs() {
    return canonicalize(loadIndex().tasks);
  }

  function generateOutputManifest() {
    ensureDir(outputDir);
    const taskIds = fs.readdirSync(outputDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    const files = [];
    for (const taskId of taskIds) {
      const taskDir = path.join(outputDir, taskId);
      const outputPath = detectOutputFile(taskDir);
      const metadataPath = path.join(taskDir, "metadata.json");
      const manifestPath = path.join(taskDir, "manifest.json");

      for (const filePath of [outputPath, metadataPath, manifestPath]) {
        if (!filePath || !fs.existsSync(filePath)) {
          continue;
        }
        const rel = path.relative(outputDir, filePath).split(path.sep).join("/");
        files.push({ file: rel, sha256: hashFile(filePath) });
      }
    }

    files.sort((left, right) => left.file.localeCompare(right.file));
    const manifest = canonicalize({ schema_version: "phase14-output-catalog-v1", files });
    const outPath = path.join(outputDir, "hash-manifest.json");
    writeJson(outPath, manifest);

    return canonicalize({ path: outPath, files });
  }

  return Object.freeze({
    outputDir,
    indexPath,
    saveOutput,
    getOutput,
    listOutputs,
    generateOutputManifest
  });
}

module.exports = {
  INDEX_FILE,
  createResearchOutputManager
};
