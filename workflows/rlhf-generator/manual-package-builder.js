"use strict";

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

async function buildManualPackage(input = {}) {
  const draft = input.draft && typeof input.draft === "object" ? input.draft : null;
  const markdown = String(input.markdown || "");
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

  const complianceManifest = {
    draftSequence: draft.sequence,
    generatorVersion: draft.generatorVersion,
    contentHash: draft.contentHash,
    status: draft.status,
    aiAssisted: true,
    manualSubmissionRequired: true,
    automationBoundary: "internal_generation_only",
    externalSubmissionMode: "manual_only"
  };

  await writeFileDeterministic(path.join(packageDir, "draft.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  await writeFileDeterministic(path.join(packageDir, "source-summary.json"), canonicalJson(sourceSummary));
  await writeFileDeterministic(path.join(packageDir, "review-checklist.md"), buildChecklistMarkdown(draft));
  await writeFileDeterministic(path.join(packageDir, "compliance-manifest.json"), canonicalJson(complianceManifest));

  return {
    ok: true,
    packageDir,
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
  canonicalize
};
