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
const { createSubmissionPackGenerator } = require(path.join(root, "openclaw-bridge", "monetization", "submission-pack-generator.js"));
const { createDefaultPublisherAdapterRegistry } = require(path.join(root, "openclaw-bridge", "monetization", "publisher-adapter-registry.js"));

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), "utf8"));
}

function hashText(text) {
  return require("node:crypto").createHash("sha256").update(String(text || "")).digest("hex");
}

function hashFile(filePath) {
  return hashText(fs.readFileSync(filePath, "utf8"));
}

function relativeFrom(baseDir, filePath) {
  return path.relative(baseDir, filePath).split(path.sep).join("/");
}

function rewriteManifestAndChecksums(bundleDir) {
  const files = [];
  const stack = [bundleDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const rel = relativeFrom(bundleDir, fullPath);
      if (["manifest.json", "checksums.txt", "release-approval.json"].includes(rel)) {
        continue;
      }
      files.push({
        file: rel,
        sha256: hashFile(fullPath)
      });
    }
  }
  files.sort((left, right) => left.file.localeCompare(right.file));
  fs.writeFileSync(path.join(bundleDir, "manifest.json"), `${JSON.stringify({
    schema_version: "phase19-release-manifest-v1",
    files
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(bundleDir, "checksums.txt"), files.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n") + (files.length > 0 ? "\n" : ""), "utf8");
}

function createBundleFixture(rootDir, options = {}) {
  const packager = createDeliverablePackager({ rootDir });
  const platformTargets = readJson("config/platform-targets.json");
  const submissionPackGenerator = createSubmissionPackGenerator({
    platformTargets,
    publisherAdapterRegistry: createDefaultPublisherAdapterRegistry({ platformTargets })
  });
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
  const generatedSubmission = submissionPackGenerator.generateSubmissionPacks(bundleDir, offer, sourceContext);
  packager.writeBundleRoot(
    bundleDir,
    offer,
    sourceContext,
    artifactRefs,
    generatedSubmission.submission_refs,
    generatedSubmission.publisher_adapter_snapshot
  );
  if (options.legacy_mode === true) {
    const metadataPath = path.join(bundleDir, "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    delete metadata.schema_version;
    delete metadata.publisher_adapter_required;
    delete metadata.publisher_adapter_snapshot;
    delete metadata.publisher_adapter_snapshot_hash;
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }
  packager.finalizeBundle(bundleDir);
  return packager.commitBundle(bundleDir, offer.offer_id);
}

test("phase19 release approval manager validates bundle hashes and fails on post-approval changes", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-release-approval-"));
  const bundleDir = createBundleFixture(tmp);
  const manager = createReleaseApprovalManager({
    releasesDir: path.join(tmp, "workspace", "releases"),
    platformTargets: readJson("config/platform-targets.json"),
    timeProvider: { nowIso: () => "2026-03-06T00:00:00.000Z" }
  });

  const approval = manager.approveRelease({
    offer_id: "offer-approval-demo",
    approver: "operator-test"
  });
  assert.equal(approval.offer_id, "offer-approval-demo");
  assert.equal(approval.schema_version, "phase21-release-approval-v1");
  assert.equal(manager.validateApprovedRelease("offer-approval-demo").ok, true);

  fs.appendFileSync(path.join(bundleDir, "deliverables", "report.md"), "\nTampered.\n", "utf8");
  assert.throws(() => manager.validateApprovedRelease("offer-approval-demo"), /manifest|hash/i);
});

test("phase21 release approval manager fails closed when adapter manifest manual_only drifts", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase21-release-approval-adapter-drift-"));
  const bundleDir = createBundleFixture(tmp);
  const manager = createReleaseApprovalManager({
    releasesDir: path.join(tmp, "workspace", "releases"),
    platformTargets: readJson("config/platform-targets.json"),
    timeProvider: { nowIso: () => "2026-03-06T00:00:00.000Z" }
  });

  const manifestPath = path.join(bundleDir, "submission", "gumroad", "adapter-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.manual_only = false;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  rewriteManifestAndChecksums(bundleDir);

  assert.throws(() => manager.approveRelease({
    offer_id: "offer-approval-demo",
    approver: "operator-test"
  }), /manual_only/i);
});

test("phase21 release approval manager keeps backward compatibility for legacy bundles without phase21 metadata marker", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase21-release-approval-legacy-"));
  createBundleFixture(tmp, { legacy_mode: true });
  const manager = createReleaseApprovalManager({
    releasesDir: path.join(tmp, "workspace", "releases"),
    platformTargets: readJson("config/platform-targets.json"),
    timeProvider: { nowIso: () => "2026-03-06T00:00:00.000Z" }
  });

  const approval = manager.approveRelease({
    offer_id: "offer-approval-demo",
    approver: "operator-test"
  });
  assert.equal(approval.offer_id, "offer-approval-demo");
  assert.equal(typeof approval.schema_version, "undefined");
  assert.equal(manager.validateApprovedRelease("offer-approval-demo").ok, true);
});
