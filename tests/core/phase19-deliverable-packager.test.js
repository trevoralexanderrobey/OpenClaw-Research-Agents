"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createDeliverablePackager } = require(path.join(root, "openclaw-bridge", "monetization", "deliverable-packager.js"));
const {
  PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA,
  buildPublisherAdapterSnapshotHash
} = require(path.join(root, "openclaw-bridge", "monetization", "publisher-adapter-contract.js"));

function createMissionFixture() {
  return {
    offer: {
      offer_id: "offer-packager-demo",
      offer_title: "Packager Demo",
      product_line: "research_packs",
      tier: "sample",
      source_kind: "mission",
      source_id: "mission-packager-demo",
      platform_targets: ["gumroad"],
      workflow_roles: ["packaging_agent"],
      artifact_slots: ["primary_deliverable", "sample_preview", "store_copy"],
      required_metadata_fields: ["offer_id"],
      release_status: "packaged"
    },
    sourceContext: {
      source_kind: "mission",
      source_id: "mission-packager-demo",
      description: "Mission summary for packaging",
      summary: {
        subtask_results: [
          {
            subtask_id: "step-1",
            output_path: "/tmp/task-one/output.md",
            status: "completed"
          }
        ]
      },
      artifacts: [
        {
          task_id: "task-packager-1",
          output_rel: "workspace/research-output/task-packager-1/output.md",
          output_excerpt: "A deterministic excerpt for the report."
        }
      ]
    }
  };
}

function createPublisherAdapterSnapshot(targets) {
  const summary = {
    schema_version: PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA,
    targets: targets.map((target) => ({
      adapter_id: `phase21.manual.${target}`,
      adapter_manifest: `submission/${target}/adapter-manifest.json`,
      adapter_version: "phase21-manual-v1",
      generated_files_sha256: [
        {
          file: `submission/${target}/placeholder.txt`,
          sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      ],
      input_snapshot_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      manual_only: true,
      platform_target: target
    }))
  };
  return {
    ...summary,
    publisher_adapter_snapshot_hash: buildPublisherAdapterSnapshotHash(summary)
  };
}

test("phase19 deliverable packager writes deterministic manifests and checksums", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-packager-"));
  const packager = createDeliverablePackager({ rootDir: tmp });
  const fixture = createMissionFixture();

  const firstBundle = packager.createBundleWorkspace(fixture.offer.offer_id);
  const firstRefs = packager.writeDeliverables(firstBundle, fixture.offer, fixture.sourceContext);
  packager.writeBundleRoot(
    firstBundle,
    fixture.offer,
    fixture.sourceContext,
    firstRefs,
    {},
    createPublisherAdapterSnapshot(fixture.offer.platform_targets)
  );
  packager.finalizeBundle(firstBundle);

  const secondBundle = packager.createBundleWorkspace(fixture.offer.offer_id);
  const secondRefs = packager.writeDeliverables(secondBundle, fixture.offer, fixture.sourceContext);
  packager.writeBundleRoot(
    secondBundle,
    fixture.offer,
    fixture.sourceContext,
    secondRefs,
    {},
    createPublisherAdapterSnapshot(fixture.offer.platform_targets)
  );
  packager.finalizeBundle(secondBundle);

  const firstManifest = fs.readFileSync(path.join(firstBundle, "manifest.json"), "utf8");
  const secondManifest = fs.readFileSync(path.join(secondBundle, "manifest.json"), "utf8");
  const firstChecksums = fs.readFileSync(path.join(firstBundle, "checksums.txt"), "utf8");
  const secondChecksums = fs.readFileSync(path.join(secondBundle, "checksums.txt"), "utf8");

  assert.equal(firstManifest, secondManifest);
  assert.equal(firstChecksums, secondChecksums);
});

test("phase19 deliverable packager fails when a required artifact slot is not produced", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-packager-missing-slot-"));
  const packager = createDeliverablePackager({ rootDir: tmp });
  const fixture = createMissionFixture();
  fixture.offer.artifact_slots = ["primary_deliverable", "nonexistent_slot"];

  const bundleDir = packager.createBundleWorkspace(fixture.offer.offer_id);
  assert.throws(() => packager.writeDeliverables(bundleDir, fixture.offer, fixture.sourceContext), /required artifact slots/);
});
