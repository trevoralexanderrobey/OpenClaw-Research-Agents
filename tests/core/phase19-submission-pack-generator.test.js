"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createSubmissionPackGenerator } = require(path.join(root, "openclaw-bridge", "monetization", "submission-pack-generator.js"));

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), "utf8"));
}

test("phase19 submission pack generator creates platform-specific placeholder files", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-submission-pack-"));
  const generator = createSubmissionPackGenerator({
    platformTargets: readJson("config/platform-targets.json")
  });
  const refs = generator.generateSubmissionPacks(tmp, {
    offer_id: "offer-submission-demo",
    offer_title: "Submission Demo",
    product_line: "dataset_packs",
    tier: "standard",
    platform_targets: ["kaggle", "github_sponsors"]
  }, {
    source_kind: "dataset",
    source_id: "dataset-demo",
    build_id: "build-demo",
    description: "Dataset offer",
    metadata: { dataset_type: "instruction_qa" }
  });

  assert.ok(fs.existsSync(path.join(tmp, refs.kaggle.platform_metadata)));
  assert.ok(fs.existsSync(path.join(tmp, refs.github_sponsors.platform_metadata)));
  const checklist = fs.readFileSync(path.join(tmp, refs.kaggle.checklist), "utf8");
  assert.match(checklist, /manual submission only/i);
});

test("phase19 submission pack generator enforces required placeholders from config", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-submission-pack-missing-"));
  const generator = createSubmissionPackGenerator({
    platformTargets: {
      platform_targets: {
        kaggle: {
          manual_only: true,
          required_artifact_placeholders: ["dataset-metadata.json", "checklist.md", "copy-blocks.json", "missing.txt"],
          checklist_requirements: ["Manual submission only"],
          copy_block_requirements: ["title"],
          supported_product_lines: ["dataset_packs"],
          supported_tiers: ["standard"]
        }
      }
    }
  });

  assert.throws(() => generator.generateSubmissionPacks(tmp, {
    offer_id: "offer-submission-demo",
    offer_title: "Submission Demo",
    product_line: "dataset_packs",
    tier: "standard",
    platform_targets: ["kaggle"]
  }, {
    source_kind: "dataset",
    source_id: "dataset-demo",
    build_id: "build-demo",
    description: "Dataset offer",
    metadata: { dataset_type: "instruction_qa" }
  }), /missing required placeholder/);
});

