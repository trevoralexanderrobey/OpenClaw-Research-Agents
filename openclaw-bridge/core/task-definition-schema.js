"use strict";

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

const TASK_DEFINITION_SCHEMA_VERSION = "phase14-task-definition-v1";
const TASK_TYPES = Object.freeze(["summarize", "extract", "analyze", "synthesize", "freeform"]);
const OUTPUT_FORMATS = Object.freeze(["markdown", "json", "text"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeIso(value) {
  const text = safeString(value);
  if (!text) {
    return "1970-01-01T00:00:00.000Z";
  }
  if (!Number.isFinite(Date.parse(text))) {
    return "1970-01-01T00:00:00.000Z";
  }
  return text;
}

function normalizeInputs(value) {
  return asArray(value)
    .map((entry) => {
      if (typeof entry === "string") {
        return { path: safeString(entry), type: "path" };
      }
      if (entry && typeof entry === "object") {
        return {
          path: safeString(entry.path),
          type: safeString(entry.type) || "path"
        };
      }
      return { path: "", type: "path" };
    })
    .filter((entry) => entry.path)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function computeInputsHash(inputs) {
  return sha256(`task-inputs-v1|${JSON.stringify(canonicalize(normalizeInputs(inputs)))}`);
}

function computeTaskId(task) {
  const source = task && typeof task === "object" ? task : {};
  const idSeed = canonicalize({
    type: safeString(source.type),
    description: safeString(source.description),
    inputs_hash: computeInputsHash(source.inputs),
    created_at: normalizeIso(source.created_at || source.createdAt)
  });
  return `task-${sha256(`task-definition-v1|${JSON.stringify(idSeed)}`).slice(0, 24)}`;
}

function validateTaskDefinition(task) {
  const source = task && typeof task === "object" ? task : {};
  const type = safeString(source.type) || "freeform";
  const description = safeString(source.description);
  const outputFormat = safeString(source.outputFormat || source.output_format) || "markdown";
  const createdAt = normalizeIso(source.created_at || source.createdAt || "1970-01-01T00:00:00.000Z");
  const inputs = normalizeInputs(source.inputs);
  const constraints = source.constraints && typeof source.constraints === "object" ? canonicalize(source.constraints) : {};

  if (!TASK_TYPES.includes(type)) {
    const error = new Error(`Unsupported task type '${type}'`);
    error.code = "PHASE14_TASK_TYPE_INVALID";
    throw error;
  }

  if (!description || description.length < 3) {
    const error = new Error("Task description must be at least 3 characters");
    error.code = "PHASE14_TASK_DESCRIPTION_INVALID";
    throw error;
  }

  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    const error = new Error(`Unsupported output format '${outputFormat}'`);
    error.code = "PHASE14_TASK_OUTPUT_FORMAT_INVALID";
    throw error;
  }

  if (["summarize", "extract", "analyze", "synthesize"].includes(type) && inputs.length === 0) {
    const error = new Error(`Task type '${type}' requires at least one input`);
    error.code = "PHASE14_TASK_INPUT_REQUIRED";
    throw error;
  }

  const normalized = canonicalize({
    schema_version: TASK_DEFINITION_SCHEMA_VERSION,
    task_id: safeString(source.task_id) || computeTaskId({ type, description, inputs, created_at: createdAt }),
    type,
    description,
    inputs,
    output_format: outputFormat,
    constraints,
    created_at: createdAt,
    inputs_hash: computeInputsHash(inputs)
  });

  return normalized;
}

function createTaskDefinition(input = {}) {
  return validateTaskDefinition(input);
}

module.exports = {
  TASK_DEFINITION_SCHEMA_VERSION,
  TASK_TYPES,
  OUTPUT_FORMATS,
  computeInputsHash,
  computeTaskId,
  validateTaskDefinition,
  createTaskDefinition
};
