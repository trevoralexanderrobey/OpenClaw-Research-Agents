"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function normalizeRowValue(value) {
  if (value === null || typeof value === "undefined") {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(canonicalize(value));
}

function createSchemaEngine(options = {}) {
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const schemaPath = path.resolve(safeString(options.schemaPath) || path.join(rootDir, "config", "dataset-schemas.json"));
  const qualityRulesPath = path.resolve(safeString(options.qualityRulesPath) || path.join(rootDir, "config", "dataset-quality-rules.json"));

  const schemaConfig = readJson(schemaPath);
  const qualityConfig = readJson(qualityRulesPath);
  const datasetTypes = asPlainObject(schemaConfig.dataset_types);
  const qualityRules = asPlainObject(qualityConfig.dataset_types);

  function getDatasetSchema(datasetType) {
    const normalizedType = safeString(datasetType);
    const schema = datasetTypes[normalizedType];
    if (!schema) {
      const error = new Error(`Unknown dataset type '${normalizedType || "(empty)"}'`);
      error.code = "PHASE19_DATASET_TYPE_UNKNOWN";
      throw error;
    }
    return canonicalize(schema);
  }

  function getQualityRules(datasetType) {
    const normalizedType = safeString(datasetType);
    return canonicalize(asPlainObject(qualityRules[normalizedType]));
  }

  function normalizeRow(datasetType, row = {}) {
    const schema = getDatasetSchema(datasetType);
    const requiredFields = asStringArray(schema.required_fields)
      .filter((field) => field !== "row_hash")
      .sort((left, right) => left.localeCompare(right));
    const source = asPlainObject(row);
    const normalized = {};

    for (const field of requiredFields) {
      normalized[field] = normalizeRowValue(source[field]);
    }

    const rowHash = sha256(`phase19-dataset-row-v1|${safeString(datasetType)}|${JSON.stringify(canonicalize(normalized))}`);
    return canonicalize({
      ...normalized,
      row_hash: rowHash
    });
  }

  function validateRows(datasetType, rowsInput = []) {
    const schema = getDatasetSchema(datasetType);
    const rules = getQualityRules(datasetType);
    const rows = Array.isArray(rowsInput) ? rowsInput.map((row) => normalizeRow(datasetType, row)) : [];
    const violations = [];
    const requiredFields = asStringArray(schema.required_fields);
    const nonEmptyFields = asStringArray(rules.non_empty_fields);
    const minLengths = asPlainObject(rules.min_lengths);
    const minRowCount = Math.max(0, Number.parseInt(String(rules.min_row_count || 0), 10) || 0);
    const uniqueBy = safeString(rules.unique_by);

    if (rows.length < minRowCount) {
      violations.push(canonicalize({
        code: "PHASE19_DATASET_MIN_ROW_COUNT",
        message: `Dataset type '${safeString(datasetType)}' requires at least ${minRowCount} rows`
      }));
    }

    const seenUnique = new Set();
    for (const [index, row] of rows.entries()) {
      for (const field of requiredFields) {
        if (!Object.prototype.hasOwnProperty.call(row, field)) {
          violations.push(canonicalize({
            code: "PHASE19_DATASET_REQUIRED_FIELD_MISSING",
            row_number: index + 1,
            field,
            message: `Missing required field '${field}'`
          }));
        }
      }

      for (const field of nonEmptyFields) {
        if (!safeString(row[field])) {
          violations.push(canonicalize({
            code: "PHASE19_DATASET_NON_EMPTY_REQUIRED",
            row_number: index + 1,
            field,
            message: `Field '${field}' must be non-empty`
          }));
        }
      }

      for (const [field, minLength] of Object.entries(minLengths)) {
        if (safeString(row[field]).length < Number(minLength || 0)) {
          violations.push(canonicalize({
            code: "PHASE19_DATASET_MIN_LENGTH",
            row_number: index + 1,
            field,
            message: `Field '${field}' must be at least ${Number(minLength || 0)} characters`
          }));
        }
      }

      if (uniqueBy) {
        const key = safeString(row[uniqueBy]);
        if (key && seenUnique.has(key)) {
          violations.push(canonicalize({
            code: "PHASE19_DATASET_DUPLICATE_KEY",
            row_number: index + 1,
            field: uniqueBy,
            message: `Duplicate '${uniqueBy}' value detected`
          }));
        }
        if (key) {
          seenUnique.add(key);
        }
      }
    }

    return canonicalize({
      ok: violations.length === 0,
      dataset_type: safeString(datasetType),
      row_count: rows.length,
      rows,
      schema,
      quality_rules: rules,
      violations
    });
  }

  function getConfigSnapshotHash(datasetType) {
    return sha256(JSON.stringify(canonicalize({
      schema: getDatasetSchema(datasetType),
      quality_rules: getQualityRules(datasetType)
    })));
  }

  function listDatasetTypes() {
    return Object.keys(datasetTypes).sort((left, right) => left.localeCompare(right));
  }

  return Object.freeze({
    getDatasetSchema,
    getQualityRules,
    normalizeRow,
    validateRows,
    getConfigSnapshotHash,
    listDatasetTypes
  });
}

module.exports = {
  createSchemaEngine
};
