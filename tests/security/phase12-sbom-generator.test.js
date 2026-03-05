"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createSbomGenerator } = require("../../workflows/supply-chain/sbom-generator.js");

const root = path.resolve(__dirname, "../..");

test("phase12 sbom generator is deterministic", () => {
  const generator = createSbomGenerator({
    rootDir: root,
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  const first = generator.generateSbom();
  const second = generator.generateSbom();

  assert.equal(first.sbom_hash, second.sbom_hash);
  assert.deepEqual(second.sbom, first.sbom);
  assert.equal(first.generated_at, "2026-03-05T00:00:00.000Z");
});

test("phase12 sbom generator includes required component fields", () => {
  const generator = createSbomGenerator({
    rootDir: root,
    timeProvider: { nowIso: () => "2026-03-05T00:00:00.000Z" }
  });

  const result = generator.generateSbom();
  assert.ok(result.component_count > 0);

  const component = result.sbom.components[0];
  assert.ok(component.name);
  assert.ok(component.version);
  assert.ok(component.purl);
  assert.ok(component.license);
  assert.ok(component.package_hash_sha256);
  assert.equal(typeof component.dependency_depth, "number");
});
