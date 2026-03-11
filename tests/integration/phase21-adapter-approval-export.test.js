"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const { canonicalize } = require(path.join(root, "workflows", "governance-automation", "common.js"));
const { copyMonetizationConfigs, writeJson, writeTaskOutput } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

async function createRepoFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase21-adapter-export-"));
  await copyMonetizationConfigs(tmp);
  return tmp;
}

function runNode(scriptRelPath, args, cwd) {
  return spawnSync("node", [path.join(root, scriptRelPath), ...args], {
    cwd,
    encoding: "utf8"
  });
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath, "utf8"));
}

function relativeFrom(baseDir, filePath) {
  return path.relative(baseDir, filePath).split(path.sep).join("/");
}

function collectBundleFiles(bundleDir) {
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
      files.push(canonicalize({
        file: rel,
        sha256: hashFile(fullPath)
      }));
    }
  }
  return files.sort((left, right) => left.file.localeCompare(right.file));
}

function rewriteBundleManifestAndApprovalHash(bundleDir) {
  const files = collectBundleFiles(bundleDir);
  const manifestPath = path.join(bundleDir, "manifest.json");
  const checksumsPath = path.join(bundleDir, "checksums.txt");
  fs.writeFileSync(manifestPath, `${JSON.stringify(canonicalize({
    schema_version: "phase19-release-manifest-v1",
    files
  }), null, 2)}\n`, "utf8");
  fs.writeFileSync(checksumsPath, files.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n") + (files.length > 0 ? "\n" : ""), "utf8");

  const releaseApprovalPath = path.join(bundleDir, "release-approval.json");
  const releaseApproval = JSON.parse(fs.readFileSync(releaseApprovalPath, "utf8"));
  releaseApproval.hash_of_release_bundle = sha256(`phase19-release-bundle-v1|${JSON.stringify(canonicalize(files))}`);
  fs.writeFileSync(releaseApprovalPath, `${JSON.stringify(releaseApproval, null, 2)}\n`, "utf8");
}

test("phase21 export fails when adapter contract validation fails even with refreshed bundle manifest/hash", async () => {
  const fixtureRoot = await createRepoFixture();
  const missionId = "mission-phase21-adapter-export-demo";
  const outputPath = writeTaskOutput(fixtureRoot, "task-phase21-adapter-export-1", "sample-research-output.md");
  const missionRoot = path.join(fixtureRoot, "workspace", "missions", missionId);
  fs.mkdirSync(path.join(missionRoot, "artifacts"), { recursive: true });
  writeJson(path.join(missionRoot, "mission.json"), {
    mission_id: missionId,
    description: "Phase21 adapter export validation demo"
  });
  writeJson(path.join(missionRoot, "status.json"), {
    mission_id: missionId,
    status: "completed"
  });
  writeJson(path.join(missionRoot, "artifacts", "mission-summary.json"), {
    mission_id: missionId,
    subtask_results: [
      { subtask_id: "step-1", output_path: outputPath, status: "completed" }
    ]
  });

  const generated = runNode("scripts/generate-offer.js", [
    "--source", missionId,
    "--product-line", "research_packs",
    "--tier", "standard",
    "--targets", "gumroad",
    "--confirm"
  ], fixtureRoot);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const generatedBody = JSON.parse(generated.stdout);

  const approved = runNode("scripts/approve-release.js", [
    "--offer-id", generatedBody.offer_id,
    "--confirm"
  ], fixtureRoot);
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);

  const adapterManifestPath = path.join(generatedBody.bundle_dir, "submission", "gumroad", "adapter-manifest.json");
  const adapterManifest = JSON.parse(fs.readFileSync(adapterManifestPath, "utf8"));
  adapterManifest.manual_only = false;
  fs.writeFileSync(adapterManifestPath, `${JSON.stringify(adapterManifest, null, 2)}\n`, "utf8");
  rewriteBundleManifestAndApprovalHash(generatedBody.bundle_dir);

  const exported = runNode("scripts/export-release.js", [
    "--offer-id", generatedBody.offer_id,
    "--format", "zip",
    "--confirm"
  ], fixtureRoot);
  assert.notEqual(exported.status, 0);
  assert.match(exported.stderr, /manual_only|adapter/i);
});
