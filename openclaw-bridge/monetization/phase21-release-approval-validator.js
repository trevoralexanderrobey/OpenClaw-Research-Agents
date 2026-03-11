"use strict";

const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");
const { PHASE21_RELEASE_APPROVAL_SCHEMA } = require("./publisher-adapter-contract.js");

const PHASE21_PUBLISHER_ADAPTER_STATUS_SCHEMA = "phase21-publisher-adapter-status-v1";

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function validateSha(value, code) {
  const normalized = safeString(value);
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    const error = new Error("phase21 release approval requires sha256 values");
    error.code = code;
    throw error;
  }
  return normalized.toLowerCase();
}

function assertSortedUnique(values, code) {
  const sorted = values.slice().sort((left, right) => left.localeCompare(right));
  const unique = Array.from(new Set(sorted));
  if (JSON.stringify(values) !== JSON.stringify(sorted) || JSON.stringify(values) !== JSON.stringify(unique)) {
    const error = new Error("phase21 release approval arrays must be sorted and unique");
    error.code = code;
    throw error;
  }
}

function validatePhase21ReleaseApproval(input = {}, options = {}) {
  const approval = asPlainObject(input);
  if (safeString(approval.schema_version) !== PHASE21_RELEASE_APPROVAL_SCHEMA) {
    const error = new Error(`phase21 release approval schema_version must be ${PHASE21_RELEASE_APPROVAL_SCHEMA}`);
    error.code = "PHASE21_RELEASE_APPROVAL_SCHEMA_INVALID";
    throw error;
  }
  if (!safeString(approval.offer_id) || !safeString(approval.approved_at) || !safeString(approval.approver)) {
    const error = new Error("phase21 release approval requires offer_id, approved_at, and approver");
    error.code = "PHASE21_RELEASE_APPROVAL_FIELDS_REQUIRED";
    throw error;
  }
  const approvedTargets = asStringArray(approval.approved_platform_targets);
  if (approvedTargets.length === 0) {
    const error = new Error("phase21 release approval requires approved_platform_targets");
    error.code = "PHASE21_RELEASE_APPROVAL_TARGETS_REQUIRED";
    throw error;
  }
  assertSortedUnique(approvedTargets, "PHASE21_RELEASE_APPROVAL_TARGETS_ORDER");
  const status = asPlainObject(approval.publisher_adapter_status);
  if (safeString(status.schema_version) !== PHASE21_PUBLISHER_ADAPTER_STATUS_SCHEMA) {
    const error = new Error(`phase21 release approval publisher_adapter_status.schema_version must be ${PHASE21_PUBLISHER_ADAPTER_STATUS_SCHEMA}`);
    error.code = "PHASE21_RELEASE_APPROVAL_ADAPTER_STATUS_SCHEMA_INVALID";
    throw error;
  }
  if (safeString(status.validation_result) !== "passed") {
    const error = new Error("phase21 release approval publisher_adapter_status.validation_result must be 'passed'");
    error.code = "PHASE21_RELEASE_APPROVAL_ADAPTER_STATUS_RESULT_INVALID";
    throw error;
  }
  const validatedTargets = asStringArray(status.validated_targets);
  assertSortedUnique(validatedTargets, "PHASE21_RELEASE_APPROVAL_ADAPTER_TARGETS_ORDER");
  if (JSON.stringify(validatedTargets) !== JSON.stringify(approvedTargets)) {
    const error = new Error("phase21 release approval publisher_adapter_status.validated_targets must match approved_platform_targets");
    error.code = "PHASE21_RELEASE_APPROVAL_ADAPTER_TARGETS_MISMATCH";
    throw error;
  }
  const expectedTargets = asStringArray(options.expected_targets || options.expectedTargets).sort((left, right) => left.localeCompare(right));
  if (expectedTargets.length > 0 && JSON.stringify(approvedTargets) !== JSON.stringify(expectedTargets)) {
    const error = new Error("phase21 release approval targets do not match expected packaged targets");
    error.code = "PHASE21_RELEASE_APPROVAL_EXPECTED_TARGETS_MISMATCH";
    throw error;
  }
  return canonicalize({
    approved_at: safeString(approval.approved_at),
    approved_platform_targets: approvedTargets,
    approver: safeString(approval.approver),
    dataset_phase20_status: canonicalize(asPlainObject(approval.dataset_phase20_status)),
    hash_of_release_bundle: validateSha(approval.hash_of_release_bundle, "PHASE21_RELEASE_APPROVAL_HASH_INVALID"),
    offer_id: safeString(approval.offer_id),
    publisher_adapter_status: canonicalize({
      publisher_adapter_snapshot_hash: validateSha(status.publisher_adapter_snapshot_hash, "PHASE21_RELEASE_APPROVAL_ADAPTER_SNAPSHOT_HASH_INVALID"),
      schema_version: PHASE21_PUBLISHER_ADAPTER_STATUS_SCHEMA,
      validated_targets: validatedTargets,
      validation_result: "passed"
    }),
    schema_version: PHASE21_RELEASE_APPROVAL_SCHEMA
  });
}

module.exports = {
  PHASE21_PUBLISHER_ADAPTER_STATUS_SCHEMA,
  validatePhase21ReleaseApproval
};
