"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const {
  computeOfferId,
  validateMonetizationMap,
  validateOfferDefinition,
  validatePlatformTargets
} = require(path.join(root, "openclaw-bridge", "monetization", "offer-schema.js"));

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), "utf8"));
}

test("phase19 monetization config validates", () => {
  const result = validateMonetizationMap(readJson("config/monetization-map.json"));
  assert.equal(result.schema_version, "phase19-monetization-map-v1");
  assert.ok(result.product_lines.research_packs);
  assert.ok(result.tiers.enterprise);
});

test("phase19 platform targets remain manual-only", () => {
  const config = readJson("config/platform-targets.json");
  config.platform_targets.kaggle.manual_only = false;
  assert.throws(() => validatePlatformTargets(config), /manual_only/);
});

test("phase19 offer ids are deterministic and dataset offers require build_id", () => {
  const seed = {
    source_kind: "dataset",
    source_id: "dataset-demo",
    build_id: "build-demo",
    product_line: "dataset_packs",
    tier: "standard",
    platform_targets: ["kaggle"],
    source_manifest_hash: "abc",
    monetization_snapshot_hash: "def"
  };
  assert.equal(computeOfferId(seed), computeOfferId(seed));
  assert.throws(() => validateOfferDefinition({
    offer_id: "offer-demo",
    offer_title: "Demo",
    product_line: "dataset_packs",
    tier: "standard",
    source_kind: "dataset",
    source_id: "dataset-demo",
    platform_targets: ["kaggle"],
    release_status: "packaged",
    artifact_slots: ["primary_deliverable"],
    required_metadata_fields: ["offer_id"]
  }), /build_id/);
});

