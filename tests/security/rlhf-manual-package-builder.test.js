"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");

const { buildManualPackage, verifyManualPackage } = require("../../workflows/rlhf-generator/manual-package-builder.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase5-manual-package-"));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("manual package builder output is deterministic across repeated runs", async () => {
  const dir = await makeTmpDir();
  const draft = {
    sequence: 42,
    sourcePaperId: "paper-42",
    sourceHash: "e".repeat(64),
    domainTag: "security",
    complexityScore: 50,
    monetizationScore: 50,
    generatedAt: "2026-03-03T00:00:00.000Z",
    generatorVersion: "v1",
    contentHash: "f".repeat(64),
    status: "approved_for_manual_submission",
    aiAssisted: true,
    reviewedBy: "operator",
    reviewedAt: "2026-03-03T01:00:00.000Z",
    notes: "ready",
    manualSubmissionRequired: true
  };

  const markdown = "# AI-Assisted RLHF Draft (Human Review Required)\n\nBody\n";
  const sourceRecord = {
    paper_id: "paper-42",
    title: "Deterministic Packaging"
  };

  const first = await buildManualPackage({ draft, markdown, sourceRecord, outDir: dir });
  const firstHashes = first.files.map((filePath) => sha256File(filePath));

  const second = await buildManualPackage({ draft, markdown, sourceRecord, outDir: dir });
  const secondHashes = second.files.map((filePath) => sha256File(filePath));

  assert.deepEqual(firstHashes, secondHashes);
  assert.equal(typeof first.packageHash, "string");
  assert.equal(first.packageHash.length, 64);
  await verifyManualPackage(first.packageDir);
});

test("manual package verification detects tampering", async () => {
  const dir = await makeTmpDir();
  const draft = {
    sequence: 7,
    sourcePaperId: "paper-7",
    sourceHash: "1".repeat(64),
    domainTag: "security",
    complexityScore: 45,
    monetizationScore: 35,
    generatedAt: "2026-03-03T00:00:00.000Z",
    generatorVersion: "v1",
    contentHash: "2".repeat(64),
    status: "approved_for_manual_submission",
    aiAssisted: true,
    reviewedBy: "operator",
    reviewedAt: "2026-03-03T01:00:00.000Z",
    notes: "",
    manualSubmissionRequired: true
  };

  const pkg = await buildManualPackage({
    draft,
    markdown: "# AI-Assisted RLHF Draft (Human Review Required)\n\nBody\n",
    sourceRecord: { paper_id: "paper-7" },
    outDir: dir
  });

  await fsp.writeFile(path.join(pkg.packageDir, "draft.md"), "# tampered\n", "utf8");
  await assert.rejects(
    () => verifyManualPackage(pkg.packageDir),
    (error) => error && error.code === "RLHF_PACKAGE_FILE_HASH_MISMATCH"
  );
});
