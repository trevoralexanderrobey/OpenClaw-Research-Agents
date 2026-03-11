"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const {
  createDefaultPublisherAdapterRegistry,
  createPublisherAdapterRegistry
} = require(path.join(root, "openclaw-bridge", "monetization", "publisher-adapter-registry.js"));
const { createManualPlaceholderAdapter } = require(path.join(root, "openclaw-bridge", "monetization", "adapters", "manual-placeholder-adapter.js"));

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), "utf8"));
}

test("phase21 publisher adapter default registry covers every configured platform target", () => {
  const platformTargets = readJson("config/platform-targets.json");
  const configuredTargets = Object.keys(platformTargets.platform_targets || {}).sort((left, right) => left.localeCompare(right));
  const registry = createDefaultPublisherAdapterRegistry({ platformTargets });
  assert.deepEqual(registry.configured_targets, configuredTargets);
  assert.deepEqual(registry.list().map((entry) => entry.platform_target), configuredTargets);
  for (const target of configuredTargets) {
    assert.equal(registry.resolve(target).platform_target, target);
  }
});

test("phase21 publisher adapter registry fails closed on duplicate target registration", () => {
  const platformTargets = {
    platform_targets: {
      kaggle: { manual_only: true, required_artifact_placeholders: ["dataset-metadata.json"] }
    }
  };
  assert.throws(() => createPublisherAdapterRegistry({
    platformTargets,
    adapters: [
      createManualPlaceholderAdapter({
        platform_target: "kaggle",
        adapter_id: "phase21.manual.kaggle.one",
        adapter_version: "phase21-manual-v1"
      }),
      createManualPlaceholderAdapter({
        platform_target: "kaggle",
        adapter_id: "phase21.manual.kaggle.two",
        adapter_version: "phase21-manual-v1"
      })
    ]
  }), /duplicate/i);
});

test("phase21 publisher adapter registry fails closed when configured targets are missing from registrations", () => {
  const platformTargets = {
    platform_targets: {
      kaggle: { manual_only: true, required_artifact_placeholders: ["dataset-metadata.json"] },
      hugging_face: { manual_only: true, required_artifact_placeholders: ["dataset-card.md"] }
    }
  };
  assert.throws(() => createPublisherAdapterRegistry({
    platformTargets,
    adapters: [
      createManualPlaceholderAdapter({
        platform_target: "kaggle",
        adapter_id: "phase21.manual.kaggle",
        adapter_version: "phase21-manual-v1"
      })
    ]
  }), /missing targets/i);
});

test("phase21 publisher adapter registry fails closed on unknown targets", () => {
  const platformTargets = {
    platform_targets: {
      kaggle: { manual_only: true, required_artifact_placeholders: ["dataset-metadata.json"] }
    }
  };
  assert.throws(() => createPublisherAdapterRegistry({
    platformTargets,
    adapters: [
      createManualPlaceholderAdapter({
        platform_target: "unknown_target",
        adapter_id: "phase21.manual.unknown",
        adapter_version: "phase21-manual-v1"
      })
    ]
  }), /unknown target/i);
});
