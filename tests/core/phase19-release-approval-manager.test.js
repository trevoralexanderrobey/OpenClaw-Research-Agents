"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createDeliverablePackager } = require(path.join(root, "openclaw-bridge", "monetization", "deliverable-packager.js"));
const { createReleaseApprovalManager } = require(path.join(root, "openclaw-bridge", "monetization", "release-approval-manager.js"));

function createBundleFixture(rootDir) {
  const packager = createDeliverablePackager({ rootDir });
  const offer = {
    offer_id: "offer-approval-demo",
    offer_title: "Approval Demo",
    product_line: "research_packs",
    tier: "sample",
    source_kind: "mission",
    source_id: "mission-approval-demo",
    platform_targets: ["gumroad"],
    workflow_roles: ["packaging_agent"],
    artifact_slots: ["primary_deliverable", "sample_preview", "store_copy"],
    required_metadata_fields: ["offer_id"],
    release_status: "packaged"
  };
  const sourceContext = {
    source_kind: "mission",
    source_id: "mission-approval-demo",
    description: "Approval fixture",
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
        task_id: "task-approval-1",
        output_rel: "workspace/research-output/task-approval-1/output.md",
        output_excerpt: "Approval fixture excerpt."
      }
    ]
  };
  const bundleDir = packager.createBundleWorkspace(offer.offer_id);
  const artifactRefs = packager.writeDeliverables(bundleDir, offer, sourceContext);
  packager.writeBundleRoot(bundleDir, offer, sourceContext, artifactRefs, {});
  packager.finalizeBundle(bundleDir);
  return packager.commitBundle(bundleDir, offer.offer_id);
}

test("phase19 release approval manager validates bundle hashes and fails on post-approval changes", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-release-approval-"));
  const bundleDir = createBundleFixture(tmp);
  const manager = createReleaseApprovalManager({
    releasesDir: path.join(tmp, "workspace", "releases"),
    timeProvider: { nowIso: () => "2026-03-06T00:00:00.000Z" }
  });

  const approval = manager.approveRelease({
    offer_id: "offer-approval-demo",
    approver: "operator-test"
  });
  assert.equal(approval.offer_id, "offer-approval-demo");
  assert.equal(manager.validateApprovedRelease("offer-approval-demo").ok, true);

  fs.appendFileSync(path.join(bundleDir, "deliverables", "report.md"), "\nTampered.\n", "utf8");
  assert.throws(() => manager.validateApprovedRelease("offer-approval-demo"), /manifest|hash/i);
});
