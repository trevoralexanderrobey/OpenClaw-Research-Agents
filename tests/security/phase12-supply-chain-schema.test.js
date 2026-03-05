"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SUPPLY_CHAIN_SCHEMA_VERSION,
  getSupplyChainSchema,
  validateSupplyChainPayload
} = require("../../workflows/supply-chain/supply-chain-schema.js");

test("phase12 supply-chain schema exposes expected entities", () => {
  const schema = getSupplyChainSchema();
  assert.equal(schema.schema_version, SUPPLY_CHAIN_SCHEMA_VERSION);
  assert.ok(schema.entities.sbom);
  assert.ok(schema.entities.dependency_manifest);
  assert.ok(schema.entities.provenance_record);
  assert.ok(schema.entities.vulnerability_report);
  assert.ok(schema.entities.signature_record);
});

test("phase12 supply-chain schema validates payload shape", () => {
  const valid = validateSupplyChainPayload("dependency_manifest", {
    schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
    generated_at: "2026-03-05T00:00:00.000Z",
    components: []
  });
  assert.equal(valid.valid, true, JSON.stringify(valid.violations, null, 2));

  const invalid = validateSupplyChainPayload("dependency_manifest", {
    schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
    generated_at: "2026-03-05T00:00:00.000Z"
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.violations.some((entry) => entry.field === "components"));
});

test("phase12 supply-chain schema output is deterministic", () => {
  const first = getSupplyChainSchema();
  const second = getSupplyChainSchema();
  assert.deepEqual(second, first);
});
