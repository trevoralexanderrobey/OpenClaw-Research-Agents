"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createSubmissionPackGenerator } = require(path.join(root, "openclaw-bridge", "monetization", "submission-pack-generator.js"));
const {
  createDefaultPublisherAdapterRegistry,
  createPublisherAdapterRegistry
} = require(path.join(root, "openclaw-bridge", "monetization", "publisher-adapter-registry.js"));
const { createManualPlaceholderAdapter } = require(path.join(root, "openclaw-bridge", "monetization", "adapters", "manual-placeholder-adapter.js"));

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), "utf8"));
}

test("phase19 submission pack generator creates platform-specific placeholder files", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-submission-pack-"));
  const platformTargets = readJson("config/platform-targets.json");
  const generator = createSubmissionPackGenerator({
    platformTargets,
    publisherAdapterRegistry: createDefaultPublisherAdapterRegistry({ platformTargets })
  });
  const generated = generator.generateSubmissionPacks(tmp, {
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
  const refs = generated.submission_refs;

  assert.ok(fs.existsSync(path.join(tmp, refs.kaggle.platform_metadata)));
  assert.ok(fs.existsSync(path.join(tmp, refs.github_sponsors.platform_metadata)));
  const checklist = fs.readFileSync(path.join(tmp, refs.kaggle.checklist), "utf8");
  assert.match(checklist, /manual submission only/i);
  assert.ok(fs.existsSync(path.join(tmp, refs.kaggle.adapter_manifest)));
  const kaggleManifest = JSON.parse(fs.readFileSync(path.join(tmp, refs.kaggle.adapter_manifest), "utf8"));
  const files = kaggleManifest.generated_files.slice();
  const hashes = kaggleManifest.generated_files_sha256.map((entry) => entry.file);
  assert.deepEqual(files, files.slice().sort((left, right) => left.localeCompare(right)));
  assert.deepEqual(hashes, hashes.slice().sort((left, right) => left.localeCompare(right)));
  assert.equal(generated.publisher_adapter_snapshot.targets.length, 2);
});

test("phase19 submission pack generator enforces required placeholders from config", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-submission-pack-missing-"));
  const platformTargets = {
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
  };
  const generator = createSubmissionPackGenerator({
    platformTargets,
    publisherAdapterRegistry: createPublisherAdapterRegistry({
      platformTargets,
      adapters: [
        createManualPlaceholderAdapter({
          platform_target: "kaggle",
          adapter_id: "phase21.manual.kaggle",
          adapter_version: "phase21-manual-v1"
        })
      ]
    })
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

test("phase21 submission pack generator fails closed when adapter emits path outside submission/<platform>", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase21-submission-pack-path-escape-"));
  const platformTargets = {
    platform_targets: {
      kaggle: {
        manual_only: true,
        required_artifact_placeholders: ["dataset-metadata.json", "checklist.md", "copy-blocks.json"],
        checklist_requirements: ["Manual submission only"],
        copy_block_requirements: ["title"],
        supported_product_lines: ["dataset_packs"],
        supported_tiers: ["standard"]
      }
    }
  };
  const generator = createSubmissionPackGenerator({
    platformTargets,
    publisherAdapterRegistry: createPublisherAdapterRegistry({
      platformTargets,
      adapters: [
        {
          platform_target: "kaggle",
          adapter_id: "phase21.manual.kaggle.bad-path",
          adapter_version: "phase21-manual-v1",
          generateArtifacts(input) {
            input.emitText("../escape.txt", "should fail\n");
            return { generated_files: [], refs: {} };
          }
        }
      ]
    })
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
  }), /path|relative/i);
});

test("phase21 submission pack generator fails when adapter declared outputs do not match emitted files", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase21-submission-pack-declared-files-"));
  const platformTargets = {
    platform_targets: {
      kaggle: {
        manual_only: true,
        required_artifact_placeholders: ["dataset-metadata.json", "checklist.md", "copy-blocks.json"],
        checklist_requirements: ["Manual submission only"],
        copy_block_requirements: ["title"],
        supported_product_lines: ["dataset_packs"],
        supported_tiers: ["standard"]
      }
    }
  };
  const generator = createSubmissionPackGenerator({
    platformTargets,
    publisherAdapterRegistry: createPublisherAdapterRegistry({
      platformTargets,
      adapters: [
        {
          platform_target: "kaggle",
          adapter_id: "phase21.manual.kaggle.bad-declared-files",
          adapter_version: "phase21-manual-v1",
          generateArtifacts(input) {
            const one = input.emitJson("copy-blocks.json", { title: "Demo" });
            const two = input.emitText("checklist.md", "# Checklist\n");
            const three = input.emitJson("dataset-metadata.json", { title: "Demo", id: "x", licenses: [{ name: "other" }] });
            const declared = [one, two].sort((left, right) => left.localeCompare(right));
            return {
              generated_files: declared,
              refs: {
                copy_blocks: one,
                checklist: two,
                platform_metadata: three
              }
            };
          }
        }
      ]
    })
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
  }), /declared files do not match emitted files/i);
});
