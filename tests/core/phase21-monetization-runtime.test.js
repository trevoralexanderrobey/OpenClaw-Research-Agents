"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { buildMonetizationRuntime } = require(path.join(root, "scripts", "_monetization-runtime.js"));
const { copyMonetizationConfigs } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

test("phase21 monetization runtime builds with exact adapter coverage by default", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase21-runtime-default-"));
  await copyMonetizationConfigs(tmp);
  const runtime = buildMonetizationRuntime({ rootDir: tmp });
  assert.ok(runtime.publisherAdapterRegistry);
  const listedTargets = runtime.publisherAdapterRegistry.list().map((entry) => entry.platform_target);
  assert.deepEqual(listedTargets.slice().sort((left, right) => left.localeCompare(right)), listedTargets);
  assert.equal(listedTargets.length, Object.keys(runtime.platformTargets.platform_targets || {}).length);
});

test("phase21 monetization runtime fails closed when registry coverage does not match configured platform targets", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase21-runtime-mismatch-"));
  await copyMonetizationConfigs(tmp);
  assert.throws(() => buildMonetizationRuntime({
    rootDir: tmp,
    publisherAdapterRegistry: {
      configured_targets: ["kaggle"],
      list() {
        return [{
          adapter_id: "phase21.manual.kaggle",
          adapter_version: "phase21-manual-v1",
          platform_target: "kaggle"
        }];
      },
      resolve(targetName) {
        if (targetName !== "kaggle") {
          throw new Error("not found");
        }
        return {
          adapter_id: "phase21.manual.kaggle",
          adapter_version: "phase21-manual-v1",
          platform_target: "kaggle",
          generateArtifacts() {
            return { generated_files: [], refs: {} };
          }
        };
      }
    }
  }), /registry.*match/i);
});
