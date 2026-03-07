"use strict";

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function detectType(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function stableReasonCodes(violations) {
  return Array.from(new Set((Array.isArray(violations) ? violations : [])
    .map((entry) => safeString(entry.code))
    .filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function weightedAverage(parts = {}) {
  const entries = Object.entries(asPlainObject(parts));
  let numerator = 0;
  let denominator = 0;
  for (const [, part] of entries) {
    const score = asNumber(part && part.score, 0);
    const weight = asNumber(part && part.weight, 0);
    if (weight <= 0) {
      continue;
    }
    numerator += score * weight;
    denominator += weight;
  }
  if (denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 100) / 100;
}

function createDatasetValidator(options = {}) {
  const schemaEngine = options.schemaEngine;
  if (!schemaEngine || typeof schemaEngine.getDatasetSchema !== "function" || typeof schemaEngine.getQualityRules !== "function" || typeof schemaEngine.normalizeRow !== "function") {
    throw new Error("schemaEngine with getDatasetSchema/getQualityRules/normalizeRow is required");
  }

  function getDatasetSchema(datasetType) {
    return canonicalize(schemaEngine.getDatasetSchema(datasetType));
  }

  function getQualityRules(datasetType) {
    return canonicalize(schemaEngine.getQualityRules(datasetType));
  }

  function validateMetadata(metadata = {}) {
    const source = asPlainObject(metadata);
    const requiredFields = ["dataset_id", "build_id", "dataset_type", "target_schema"];
    const violations = [];
    for (const field of requiredFields) {
      if (!safeString(source[field])) {
        violations.push(canonicalize({
          code: "PHASE20_DATASET_METADATA_INVALID",
          field,
          message: `Dataset metadata requires '${field}'`
        }));
      }
    }
    return canonicalize({
      ok: violations.length === 0,
      violations
    });
  }

  function validateConfig(datasetType) {
    const schema = getDatasetSchema(datasetType);
    const rules = getQualityRules(datasetType);
    const fields = asPlainObject(schema.fields);
    const requiredFields = asStringArray(schema.required_fields);
    const completenessFields = asStringArray(rules.completeness_required_fields);
    const allowedTypes = new Set(["array", "boolean", "number", "object", "string"]);
    const violations = [];

    if (safeString(schema.dataset_type) !== safeString(datasetType)) {
      violations.push(canonicalize({
        code: "PHASE20_SCHEMA_CONFIG_INVALID",
        message: `Schema dataset_type '${safeString(schema.dataset_type)}' does not match '${safeString(datasetType)}'`
      }));
    }
    if (requiredFields.length === 0) {
      violations.push(canonicalize({
        code: "PHASE20_SCHEMA_CONFIG_INVALID",
        message: `Schema '${safeString(datasetType)}' requires required_fields`
      }));
    }
    for (const field of requiredFields) {
      const definition = asPlainObject(fields[field]);
      if (field !== "row_hash" && !definition.type) {
        violations.push(canonicalize({
          code: "PHASE20_SCHEMA_CONFIG_INVALID",
          field,
          message: `Schema '${safeString(datasetType)}' field '${field}' is missing a type definition`
        }));
      }
      if (definition.type && !allowedTypes.has(safeString(definition.type))) {
        violations.push(canonicalize({
          code: "PHASE20_SCHEMA_CONFIG_INVALID",
          field,
          message: `Schema '${safeString(datasetType)}' field '${field}' has unsupported type '${safeString(definition.type)}'`
        }));
      }
    }
    if (asNumber(rules.min_row_count, -1) < 0) {
      violations.push(canonicalize({
        code: "PHASE20_QUALITY_RULE_INVALID",
        message: `Quality rules for '${safeString(datasetType)}' require a non-negative min_row_count`
      }));
    }
    if (asStringArray(rules.non_empty_fields).length === 0) {
      violations.push(canonicalize({
        code: "PHASE20_QUALITY_RULE_INVALID",
        message: `Quality rules for '${safeString(datasetType)}' require non_empty_fields`
      }));
    }
    for (const field of completenessFields) {
      if (!Object.prototype.hasOwnProperty.call(fields, field)) {
        violations.push(canonicalize({
          code: "PHASE20_QUALITY_RULE_INVALID",
          field,
          message: `Completeness field '${field}' is not present in schema '${safeString(datasetType)}'`
        }));
      }
    }

    return canonicalize({
      ok: violations.length === 0,
      schema,
      quality_rules: rules,
      violations
    });
  }

  function validateRowShape(sourceRow, schema) {
    const fields = Object.keys(asPlainObject(schema.fields)).sort((left, right) => left.localeCompare(right));
    const raw = asPlainObject(sourceRow);
    const rawKeys = Object.keys(raw).sort((left, right) => left.localeCompare(right));
    const extras = rawKeys.filter((field) => !fields.includes(field));
    const missing = fields.filter((field) => field !== "row_hash" && !rawKeys.includes(field));
    return canonicalize({
      expected_fields: fields,
      extras,
      missing,
      raw_keys: rawKeys,
      shape_signature: sha256(JSON.stringify(rawKeys))
    });
  }

  function validateBuild(input = {}) {
    const datasetType = safeString(input.dataset_type || input.datasetType);
    const rowsInput = Array.isArray(input.rows) ? input.rows : [];
    const metadata = asPlainObject(input.metadata);
    const metadataValidation = validateMetadata(metadata);
    const configValidation = validateConfig(datasetType);
    if (!metadataValidation.ok) {
      const error = new Error("Dataset metadata is malformed");
      error.code = "PHASE20_DATASET_METADATA_INVALID";
      error.details = metadataValidation.violations;
      throw error;
    }
    if (!configValidation.ok) {
      const error = new Error("Dataset schema or quality config is malformed");
      error.code = "PHASE20_SCHEMA_CONFIG_INVALID";
      error.details = configValidation.violations;
      throw error;
    }

    const schema = configValidation.schema;
    const qualityRules = configValidation.quality_rules;
    const requiredFields = asStringArray(schema.required_fields).filter((field) => field !== "row_hash");
    const fields = asPlainObject(schema.fields);
    const nonEmptyFields = asStringArray(qualityRules.non_empty_fields);
    const completenessFields = asStringArray(qualityRules.completeness_required_fields);
    const minLengths = asPlainObject(qualityRules.min_lengths);
    const rowResults = [];
    const validRows = [];

    for (const [index, rawRow] of rowsInput.entries()) {
      const sourceRow = asPlainObject(rawRow);
      const normalizedRow = canonicalize(schemaEngine.normalizeRow(datasetType, sourceRow));
      const rowViolations = [];
      const shape = validateRowShape(sourceRow, schema);

      if (shape.extras.length > 0 && schema.allow_additional_fields !== true) {
        rowViolations.push(canonicalize({
          code: "PHASE20_ROW_SHAPE_INCONSISTENT",
          row_number: index + 1,
          field: shape.extras[0],
          message: `Unexpected field '${shape.extras[0]}' is not allowed`
        }));
      }
      for (const field of shape.missing) {
        rowViolations.push(canonicalize({
          code: "PHASE20_REQUIRED_FIELD_MISSING",
          row_number: index + 1,
          field,
          message: `Required field '${field}' is missing`
        }));
      }

      for (const [field, definitionInput] of Object.entries(fields)) {
        if (field === "row_hash") {
          continue;
        }
        const definition = asPlainObject(definitionInput);
        const value = sourceRow[field];
        if (typeof value === "undefined") {
          continue;
        }
        if (value === null && definition.nullable === true) {
          continue;
        }
        const actualType = detectType(value);
        if (safeString(definition.type) && safeString(definition.type) !== actualType) {
          rowViolations.push(canonicalize({
            code: "PHASE20_FIELD_TYPE_INVALID",
            row_number: index + 1,
            field,
            message: `Field '${field}' must be '${safeString(definition.type)}' but received '${actualType}'`
          }));
        }
      }

      for (const field of requiredFields) {
        if (!Object.prototype.hasOwnProperty.call(sourceRow, field)) {
          continue;
        }
        if (sourceRow[field] === null) {
          rowViolations.push(canonicalize({
            code: "PHASE20_NULL_FIELD_BLOCKED",
            row_number: index + 1,
            field,
            message: `Field '${field}' must not be null`
          }));
        }
      }

      for (const field of nonEmptyFields) {
        if (!safeString(normalizedRow[field])) {
          rowViolations.push(canonicalize({
            code: "PHASE20_NON_EMPTY_REQUIRED",
            row_number: index + 1,
            field,
            message: `Field '${field}' must be non-empty`
          }));
        }
      }

      for (const [field, minLengthInput] of Object.entries(minLengths)) {
        const minLength = asNumber(minLengthInput, 0);
        if (safeString(normalizedRow[field]).length < minLength) {
          rowViolations.push(canonicalize({
            code: "PHASE20_MIN_LENGTH",
            row_number: index + 1,
            field,
            message: `Field '${field}' must be at least ${minLength} characters`
          }));
        }
      }

      const completenessScores = {};
      for (const field of completenessFields) {
        completenessScores[field] = safeString(normalizedRow[field]) ? 100 : 0;
      }
      const completenessRatio = completenessFields.length > 0
        ? completenessFields.filter((field) => safeString(normalizedRow[field])).length / completenessFields.length
        : 0;
      const completenessScore = weightedAverage(Object.fromEntries(
        completenessFields.map((field) => [field, { score: completenessScores[field], weight: 1 }])
      ));

      const result = canonicalize({
        completeness_ratio: Math.round(completenessRatio * 10000) / 10000,
        completeness_score: completenessScore,
        normalized_row: normalizedRow,
        ok: rowViolations.length === 0,
        reason_codes: stableReasonCodes(rowViolations),
        row_hash: safeString(normalizedRow.row_hash),
        row_number: index + 1,
        row_shape_signature: safeString(shape.shape_signature),
        source_row: canonicalize(sourceRow),
        violations: rowViolations
      });

      rowResults.push(result);
      if (result.ok) {
        validRows.push(normalizedRow);
      }
    }

    const minRowCount = Math.max(0, Math.trunc(asNumber(qualityRules.min_row_count, 0)));
    const buildViolations = [];
    if (validRows.length < minRowCount) {
      buildViolations.push(canonicalize({
        code: "PHASE20_MIN_VALID_ROW_COUNT",
        message: `Dataset type '${datasetType}' requires at least ${minRowCount} valid rows`
      }));
    }

    const buildSummary = canonicalize({
      candidate_row_count: rowsInput.length,
      invalid_row_count: rowResults.filter((entry) => entry.ok !== true).length,
      reason_codes: stableReasonCodes(buildViolations),
      valid_row_count: validRows.length,
      validation_status: buildViolations.length === 0 ? "passed" : "failed"
    });

    const report = canonicalize({
      build_summary: buildSummary,
      dataset_type: datasetType,
      metadata: canonicalize(metadata),
      quality_rules: qualityRules,
      row_results: rowResults,
      schema
    });

    return canonicalize({
      build_summary: buildSummary,
      ok: buildSummary.validation_status === "passed",
      quality_rules: qualityRules,
      report,
      row_results: rowResults,
      rows: validRows,
      schema,
      validation_status: buildSummary.validation_status
    });
  }

  function getConfigSnapshotHash(datasetType) {
    return sha256(JSON.stringify(canonicalize({
      quality_rules: getQualityRules(datasetType),
      schema: getDatasetSchema(datasetType)
    })));
  }

  return Object.freeze({
    getConfigSnapshotHash,
    getDatasetSchema,
    getQualityRules,
    validateBuild
  });
}

module.exports = {
  createDatasetValidator
};
