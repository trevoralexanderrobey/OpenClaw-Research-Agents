"use strict";

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean).sort((left, right) => left.localeCompare(right))
    : [];
}

function validateMonetizationMap(config = {}) {
  const source = asPlainObject(config);
  const productLines = asPlainObject(source.product_lines);
  const tiers = asPlainObject(source.tiers);
  if (safeString(source.schema_version) !== "phase19-monetization-map-v1") {
    const error = new Error("monetization map schema_version must be phase19-monetization-map-v1");
    error.code = "PHASE19_MONETIZATION_SCHEMA_INVALID";
    throw error;
  }
  if (Object.keys(productLines).length === 0) {
    const error = new Error("monetization map requires product_lines");
    error.code = "PHASE19_MONETIZATION_PRODUCT_LINES_REQUIRED";
    throw error;
  }
  if (Object.keys(tiers).length === 0) {
    const error = new Error("monetization map requires tiers");
    error.code = "PHASE19_MONETIZATION_TIERS_REQUIRED";
    throw error;
  }

  for (const [productLine, definition] of Object.entries(productLines)) {
    const normalized = asPlainObject(definition);
    if (safeString(normalized.product_line) !== productLine) {
      const error = new Error(`product_line '${productLine}' must declare matching product_line`);
      error.code = "PHASE19_MONETIZATION_PRODUCT_LINE_INVALID";
      throw error;
    }
    if (!["research", "dataset", "mixed"].includes(safeString(normalized.artifact_profile))) {
      const error = new Error(`product_line '${productLine}' has unsupported artifact_profile`);
      error.code = "PHASE19_MONETIZATION_ARTIFACT_PROFILE_INVALID";
      throw error;
    }
    const sourceKinds = asStringArray(normalized.source_kinds);
    if (sourceKinds.length === 0 || sourceKinds.some((entry) => !["mission", "dataset"].includes(entry))) {
      const error = new Error(`product_line '${productLine}' has unsupported source_kinds`);
      error.code = "PHASE19_MONETIZATION_SOURCE_KIND_INVALID";
      throw error;
    }
    const supportedTiers = asStringArray(normalized.supported_tiers);
    if (supportedTiers.length === 0) {
      const error = new Error(`product_line '${productLine}' requires supported_tiers`);
      error.code = "PHASE19_MONETIZATION_SUPPORTED_TIERS_REQUIRED";
      throw error;
    }
    for (const tier of supportedTiers) {
      if (!Object.prototype.hasOwnProperty.call(tiers, tier)) {
        const error = new Error(`product_line '${productLine}' references unknown tier '${tier}'`);
        error.code = "PHASE19_MONETIZATION_TIER_UNKNOWN";
        throw error;
      }
    }
    for (const target of asStringArray(normalized.default_delivery_targets)) {
      if (!/^[A-Za-z0-9._-]+$/.test(target)) {
        const error = new Error(`product_line '${productLine}' has invalid default_delivery_targets entry '${target}'`);
        error.code = "PHASE28_MONETIZATION_DELIVERY_TARGET_INVALID";
        throw error;
      }
    }
  }

  for (const [tierName, definition] of Object.entries(tiers)) {
    const normalized = asPlainObject(definition);
    if (safeString(normalized.tier) !== tierName) {
      const error = new Error(`tier '${tierName}' must declare matching tier`);
      error.code = "PHASE19_MONETIZATION_TIER_INVALID";
      throw error;
    }
    if (normalized.final_release_gate_required !== true) {
      const error = new Error(`tier '${tierName}' must require final release gate`);
      error.code = "PHASE19_MONETIZATION_RELEASE_GATE_REQUIRED";
      throw error;
    }
    if (asStringArray(normalized.required_artifact_slots).length === 0) {
      const error = new Error(`tier '${tierName}' requires required_artifact_slots`);
      error.code = "PHASE19_MONETIZATION_ARTIFACT_SLOTS_REQUIRED";
      throw error;
    }
    if (asStringArray(normalized.required_metadata_fields).length === 0) {
      const error = new Error(`tier '${tierName}' requires required_metadata_fields`);
      error.code = "PHASE19_MONETIZATION_METADATA_FIELDS_REQUIRED";
      throw error;
    }
    if (asStringArray(normalized.allowed_platform_targets).length === 0) {
      const error = new Error(`tier '${tierName}' requires allowed_platform_targets`);
      error.code = "PHASE19_MONETIZATION_PLATFORM_TARGETS_REQUIRED";
      throw error;
    }
  }

  return canonicalize(source);
}

function validatePlatformTargets(config = {}) {
  const source = asPlainObject(config);
  const targets = asPlainObject(source.platform_targets);
  if (safeString(source.schema_version) !== "phase19-platform-targets-v1") {
    const error = new Error("platform targets schema_version must be phase19-platform-targets-v1");
    error.code = "PHASE19_PLATFORM_TARGETS_SCHEMA_INVALID";
    throw error;
  }
  if (Object.keys(targets).length === 0) {
    const error = new Error("platform targets config requires platform_targets");
    error.code = "PHASE19_PLATFORM_TARGETS_REQUIRED";
    throw error;
  }
  for (const [targetName, definition] of Object.entries(targets)) {
    const normalized = asPlainObject(definition);
    if (normalized.manual_only !== true) {
      const error = new Error(`platform target '${targetName}' must remain manual_only`);
      error.code = "PHASE19_PLATFORM_TARGET_MANUAL_ONLY";
      throw error;
    }
    if (asStringArray(normalized.required_artifact_placeholders).length === 0) {
      const error = new Error(`platform target '${targetName}' requires placeholders`);
      error.code = "PHASE19_PLATFORM_TARGET_PLACEHOLDERS_REQUIRED";
      throw error;
    }
    if (asStringArray(normalized.checklist_requirements).length === 0) {
      const error = new Error(`platform target '${targetName}' requires checklist_requirements`);
      error.code = "PHASE19_PLATFORM_TARGET_CHECKLIST_REQUIRED";
      throw error;
    }
    if (asStringArray(normalized.copy_block_requirements).length === 0) {
      const error = new Error(`platform target '${targetName}' requires copy_block_requirements`);
      error.code = "PHASE19_PLATFORM_TARGET_COPY_BLOCKS_REQUIRED";
      throw error;
    }
    if (asStringArray(normalized.supported_product_lines).length === 0) {
      const error = new Error(`platform target '${targetName}' requires supported_product_lines`);
      error.code = "PHASE19_PLATFORM_TARGET_PRODUCT_LINES_REQUIRED";
      throw error;
    }
    if (asStringArray(normalized.supported_tiers).length === 0) {
      const error = new Error(`platform target '${targetName}' requires supported_tiers`);
      error.code = "PHASE19_PLATFORM_TARGET_TIERS_REQUIRED";
      throw error;
    }
  }
  return canonicalize(source);
}

function validateDirectDeliveryTargets(config = {}) {
  const source = asPlainObject(config);
  const targets = asPlainObject(source.delivery_targets);
  if (safeString(source.schema_version) !== "phase28-direct-delivery-targets-v1") {
    const error = new Error("direct delivery targets schema_version must be phase28-direct-delivery-targets-v1");
    error.code = "PHASE28_DELIVERY_TARGETS_SCHEMA_INVALID";
    throw error;
  }
  if (Object.keys(targets).length === 0) {
    const error = new Error("direct delivery targets config requires delivery_targets");
    error.code = "PHASE28_DELIVERY_TARGETS_REQUIRED";
    throw error;
  }
  for (const [targetName, definition] of Object.entries(targets)) {
    const normalized = asPlainObject(definition);
    if (normalized.manual_only !== true) {
      const error = new Error(`delivery target '${targetName}' must remain manual_only`);
      error.code = "PHASE28_DELIVERY_TARGET_MANUAL_ONLY";
      throw error;
    }
    if (asStringArray(normalized.required_artifact_placeholders).length === 0) {
      const error = new Error(`delivery target '${targetName}' requires placeholders`);
      error.code = "PHASE28_DELIVERY_TARGET_PLACEHOLDERS_REQUIRED";
      throw error;
    }
    if (asStringArray(normalized.checklist_requirements).length === 0) {
      const error = new Error(`delivery target '${targetName}' requires checklist_requirements`);
      error.code = "PHASE28_DELIVERY_TARGET_CHECKLIST_REQUIRED";
      throw error;
    }
    if (asStringArray(normalized.supported_product_lines).length === 0) {
      const error = new Error(`delivery target '${targetName}' requires supported_product_lines`);
      error.code = "PHASE28_DELIVERY_TARGET_PRODUCT_LINES_REQUIRED";
      throw error;
    }
    if (asStringArray(normalized.supported_tiers).length === 0) {
      const error = new Error(`delivery target '${targetName}' requires supported_tiers`);
      error.code = "PHASE28_DELIVERY_TARGET_TIERS_REQUIRED";
      throw error;
    }
  }
  return canonicalize(source);
}

function computeOfferId(seed) {
  return `offer-${sha256(JSON.stringify(canonicalize(seed))).slice(0, 24)}`;
}

function validateOfferDefinition(offer = {}) {
  const source = asPlainObject(offer);
  const normalized = canonicalize({
    ...source,
    platform_targets: asStringArray(source.platform_targets),
    direct_delivery_targets: asStringArray(source.direct_delivery_targets),
    artifact_slots: asStringArray(source.artifact_slots),
    required_metadata_fields: asStringArray(source.required_metadata_fields),
    warnings: asStringArray(source.warnings),
    workflow_roles: asStringArray(source.workflow_roles)
  });
  for (const field of ["offer_id", "offer_title", "product_line", "tier", "source_kind", "source_id", "release_status"]) {
    if (!safeString(normalized[field])) {
      const error = new Error(`offer is missing required field '${field}'`);
      error.code = "PHASE19_OFFER_FIELD_REQUIRED";
      throw error;
    }
  }
  if (!["mission", "dataset"].includes(safeString(normalized.source_kind))) {
    const error = new Error("offer source_kind must be mission or dataset");
    error.code = "PHASE19_OFFER_SOURCE_KIND_INVALID";
    throw error;
  }
  if (!Array.isArray(normalized.platform_targets) || normalized.platform_targets.length === 0) {
    const error = new Error("offer requires platform_targets");
    error.code = "PHASE19_OFFER_PLATFORM_TARGETS_REQUIRED";
    throw error;
  }
  if (!Array.isArray(normalized.direct_delivery_targets)) {
    const error = new Error("offer direct_delivery_targets must be an array");
    error.code = "PHASE28_OFFER_DIRECT_DELIVERY_TARGETS_INVALID";
    throw error;
  }
  if (safeString(normalized.source_kind) === "dataset" && !safeString(normalized.build_id)) {
    const error = new Error("dataset-backed offers require build_id");
    error.code = "PHASE19_OFFER_BUILD_ID_REQUIRED";
    throw error;
  }
  if (!Array.isArray(normalized.artifact_slots) || normalized.artifact_slots.length === 0) {
    const error = new Error("offer requires artifact_slots");
    error.code = "PHASE19_OFFER_ARTIFACT_SLOTS_REQUIRED";
    throw error;
  }
  if (!Array.isArray(normalized.required_metadata_fields) || normalized.required_metadata_fields.length === 0) {
    const error = new Error("offer requires required_metadata_fields");
    error.code = "PHASE19_OFFER_METADATA_FIELDS_REQUIRED";
    throw error;
  }
  return normalized;
}

module.exports = {
  computeOfferId,
  validateDirectDeliveryTargets,
  validateMonetizationMap,
  validateOfferDefinition,
  validatePlatformTargets
};
