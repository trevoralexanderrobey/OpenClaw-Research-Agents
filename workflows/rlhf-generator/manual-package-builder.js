"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function computePackageHash(manifestWithoutHash) {
  return sha256(`rlhf-package-v1|${JSON.stringify(canonicalize(manifestWithoutHash))}`);
}

async function writeFileDeterministic(filePath, body) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body, "utf8");
}

function buildChecklistMarkdown(draft) {
  const lines = [
    "# Review Checklist",
    "",
    `Draft Sequence: ${draft.sequence}`,
    "",
    "- [ ] Disclosure language is present and accurate.",
    "- [ ] Technical content has been fact-checked.",
    "- [ ] Rubric aligns with expected evaluation quality.",
    "- [ ] Manual platform attestation requirements are understood.",
    "- [ ] Manual submission will be performed by a human operator only.",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function normalizeDraftMarkdown(markdown) {
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

function validateManifest(manifest) {
  if (!isPlainObject(manifest)) {
    const error = new Error("Compliance manifest must be an object");
    error.code = "RLHF_PACKAGE_MANIFEST_INVALID";
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(String(manifest.packageHash || ""))) {
    const error = new Error("Compliance manifest packageHash is missing or invalid");
    error.code = "RLHF_PACKAGE_HASH_INVALID";
    throw error;
  }
  if (!isPlainObject(manifest.files)) {
    const error = new Error("Compliance manifest files map is missing");
    error.code = "RLHF_PACKAGE_MANIFEST_INVALID";
    throw error;
  }
}

async function verifyManualPackage(packageDir) {
  const root = path.resolve(packageDir);
  const manifestPath = path.join(root, "compliance-manifest.json");
  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);

  validateManifest(manifest);

  const manifestWithoutHash = { ...manifest };
  delete manifestWithoutHash.packageHash;
  const expectedPackageHash = computePackageHash(manifestWithoutHash);

  if (expectedPackageHash !== manifest.packageHash) {
    const error = new Error("Package manifest hash mismatch");
    error.code = "RLHF_PACKAGE_HASH_MISMATCH";
    error.details = {
      expected: expectedPackageHash,
      actual: manifest.packageHash
    };
    throw error;
  }

  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    const fullPath = path.join(root, relativePath);
    const body = await fs.readFile(fullPath, "utf8");
    const actualHash = sha256(body);
    if (actualHash !== expectedHash) {
      const error = new Error(`Package file hash mismatch for ${relativePath}`);
      error.code = "RLHF_PACKAGE_FILE_HASH_MISMATCH";
      error.details = {
        file: relativePath,
        expected: expectedHash,
        actual: actualHash
      };
      throw error;
    }
  }

  return {
    ok: true,
    packageDir: root,
    packageHash: manifest.packageHash
  };
}

async function buildManualPackage(input = {}) {
  const draft = input.draft && typeof input.draft === "object" ? input.draft : null;
  const markdown = normalizeDraftMarkdown(String(input.markdown || ""));
  const sourceRecord = input.sourceRecord && typeof input.sourceRecord === "object" ? input.sourceRecord : {};
  const rootDir = path.resolve(input.outDir || path.join(process.cwd(), "workspace", "memory", "rlhf-manual-packages"));

  if (!draft || Number(draft.sequence) <= 0) {
    const error = new Error("Draft with valid sequence is required");
    error.code = "RLHF_PACKAGE_DRAFT_REQUIRED";
    throw error;
  }
  if (draft.status !== "approved_for_manual_submission") {
    const error = new Error("Draft must be approved_for_manual_submission before package generation");
    error.code = "RLHF_PACKAGE_STATUS_INVALID";
    throw error;
  }

  const packageDir = path.join(rootDir, `draft-${Number(draft.sequence)}`);

  const sourceSummary = {
    sourcePaperId: draft.sourcePaperId,
    sourceHash: draft.sourceHash,
    domainTag: draft.domainTag,
    sourceRecord: canonicalize(sourceRecord)
  };

  const sourceSummaryBody = canonicalJson(sourceSummary);
  const checklistBody = buildChecklistMarkdown(draft);

  const manifestWithoutHash = {
    draftSequence: draft.sequence,
    generatorVersion: draft.generatorVersion,
    contentHash: draft.contentHash,
    status: draft.status,
    aiAssisted: true,
    manualSubmissionRequired: true,
    automationBoundary: "internal_generation_only",
    externalSubmissionMode: "manual_only",
    files: {
      "draft.md": sha256(markdown),
      "source-summary.json": sha256(sourceSummaryBody),
      "review-checklist.md": sha256(checklistBody)
    }
  };

  const complianceManifest = {
    ...manifestWithoutHash,
    packageHash: computePackageHash(manifestWithoutHash)
  };
  const complianceManifestBody = canonicalJson(complianceManifest);

  await writeFileDeterministic(path.join(packageDir, "draft.md"), markdown);
  await writeFileDeterministic(path.join(packageDir, "source-summary.json"), sourceSummaryBody);
  await writeFileDeterministic(path.join(packageDir, "review-checklist.md"), checklistBody);
  await writeFileDeterministic(path.join(packageDir, "compliance-manifest.json"), complianceManifestBody);

  const verification = await verifyManualPackage(packageDir);

  return {
    ok: true,
    packageDir,
    packageHash: complianceManifest.packageHash,
    verification,
    files: [
      path.join(packageDir, "draft.md"),
      path.join(packageDir, "source-summary.json"),
      path.join(packageDir, "review-checklist.md"),
      path.join(packageDir, "compliance-manifest.json")
    ]
  };
}

module.exports = {
  buildManualPackage,
  verifyManualPackage,
  computePackageHash,
  canonicalize
};
