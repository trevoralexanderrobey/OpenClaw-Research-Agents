"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../../workflows/governance-automation/common.js");
const { PHASE21_RELEASE_METADATA_SCHEMA } = require("./publisher-adapter-contract.js");
const { validatePublisherAdapterSnapshot } = require("./publisher-adapter-snapshot-validator.js");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, body) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(body || ""), "utf8");
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, canonicalJson(canonicalize(value)), "utf8");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath, "utf8"));
}

function renderCsv(rows) {
  const lines = rows.map((row) => row.map((value) => {
    const normalized = String(value || "");
    return /[,"\n]/.test(normalized) ? `"${normalized.replace(/"/g, "\"\"")}"` : normalized;
  }).join(","));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function shortText(value, length = 800) {
  return String(value || "").trim().slice(0, length);
}

function relativeFrom(baseDir, filePath) {
  return path.relative(baseDir, filePath).split(path.sep).join("/");
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean).sort((left, right) => left.localeCompare(right))
    : [];
}

function copyIfExists(sourcePath, targetPath) {
  if (!safeString(sourcePath) || !fs.existsSync(sourcePath)) {
    return false;
  }
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function createDeliverablePackager(options = {}) {
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const releasesDir = path.resolve(safeString(options.releasesDir) || path.join(rootDir, "workspace", "releases"));

  function renderStoreCopy(offer, sourceContext) {
    return [
      `# ${safeString(offer.offer_title)}`,
      "",
      `Product line: ${safeString(offer.product_line)}`,
      `Tier: ${safeString(offer.tier)}`,
      `Source: ${safeString(sourceContext.source_kind)} ${safeString(sourceContext.source_id)}`,
      ...(sourceContext.source_kind === "dataset" ? [`Commercialization ready: ${sourceContext.phase20_status && sourceContext.phase20_status.commercialization_ready === true ? "yes" : "no"}`] : []),
      "",
      "This release bundle is a packaging artifact prepared for manual review and manual submission only.",
      ...(Array.isArray(sourceContext.warnings) && sourceContext.warnings.length > 0 ? ["", "Warnings:", ...sourceContext.warnings.map((entry) => `- ${entry}`)] : []),
      "",
      "## Description",
      safeString(sourceContext.description) || safeString(offer.offer_title),
      ""
    ].join("\n");
  }

  function renderResearchReport(offer, sourceContext) {
    const lines = [
      `# ${safeString(offer.offer_title)}`,
      "",
      "Manual-only packaging artifact.",
      "",
      `Source mission: ${safeString(sourceContext.source_id)}`,
      `Product line: ${safeString(offer.product_line)}`,
      `Tier: ${safeString(offer.tier)}`,
      "",
      "## Source Summary",
      safeString(sourceContext.description) || "Mission summary unavailable.",
      ""
    ];

    for (const artifact of Array.isArray(sourceContext.artifacts) ? sourceContext.artifacts : []) {
      lines.push(`## ${safeString(artifact.task_id)}`);
      lines.push("");
      lines.push(shortText(artifact.output_excerpt, 2400) || "No output excerpt available.");
      lines.push("");
    }
    return `${lines.join("\n")}\n`;
  }

  function renderEvidenceAppendix(sourceContext) {
    const lines = [
      "# Evidence Appendix",
      "",
      "Source task outputs included in this manual-only package:",
      ""
    ];
    for (const artifact of Array.isArray(sourceContext.artifacts) ? sourceContext.artifacts : []) {
      lines.push(`- ${safeString(artifact.task_id)} :: ${safeString(artifact.output_rel)}`);
    }
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  function renderDatasetCard(offer, sourceContext) {
    const phase20 = sourceContext.phase20_status || {};
    const warnings = Array.isArray(sourceContext.warnings) ? sourceContext.warnings : [];
    return [
      `# ${safeString(offer.offer_title)}`,
      "",
      "This dataset card is generated for manual review and manual submission only.",
      "",
      `Dataset ID: ${safeString(sourceContext.source_id)}`,
      `Build ID: ${safeString(sourceContext.build_id)}`,
      `Dataset Type: ${safeString(sourceContext.metadata.dataset_type)}`,
      `Rows: ${String(sourceContext.metadata.row_count || 0)}`,
      `Validation status: ${safeString(phase20.validation_status) || "failed"}`,
      `Quality status: ${safeString(phase20.quality_status) || "failed"}`,
      `License state: ${safeString(phase20.license_state) || "blocked"}`,
      `Commercialization ready: ${phase20.commercialization_ready === true ? "true" : "false"}`,
      "",
      "## Intended Use",
      "Prepared for deterministic local packaging and manual review before any external submission.",
      "",
      "## Limitations",
      phase20.license_state === "review_required"
        ? "This build requires manual legal/commercial review before any external listing or distribution."
        : "External publication and submission remain manual-only.",
      "",
      "## Provenance",
      "Row-level provenance is included in the packaged provenance artifact.",
      "",
      "## Licensing",
      `Current deterministic license review state: ${safeString(phase20.license_state) || "blocked"}.`,
      ...(warnings.length > 0 ? ["", "## Warnings", ...warnings.map((entry) => `- ${entry}`)] : []),
      ""
    ].join("\n");
  }

  function renderPrivateDeliveryNote(offer) {
    return [
      "# Private Delivery Note",
      "",
      `Offer ${safeString(offer.offer_id)} is prepared for manual-only delivery or manual-only listing review.`,
      "",
      "No external publication or submission has occurred as part of this package build.",
      ""
    ].join("\n");
  }

  function createBundleWorkspace(offerId) {
    ensureDir(releasesDir);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-phase19-release-"));
    const tempBundleDir = path.join(tempRoot, offerId);
    ensureDir(tempBundleDir);
    return tempBundleDir;
  }

  function writeDeliverables(bundleDir, offer, sourceContext) {
    const deliverablesDir = path.join(bundleDir, "deliverables");
    ensureDir(deliverablesDir);
    const artifactRefs = {};

    if (safeString(sourceContext.source_kind) === "mission") {
      const reportPath = path.join(deliverablesDir, "report.md");
      const appendixPath = path.join(deliverablesDir, "evidence-appendix.md");
      const tablesPath = path.join(deliverablesDir, "tables.csv");
      const previewPath = path.join(deliverablesDir, "sample-preview.md");
      writeText(reportPath, renderResearchReport(offer, sourceContext));
      writeText(appendixPath, renderEvidenceAppendix(sourceContext));
      writeText(tablesPath, renderCsv([
        ["task_id", "output_path", "status"],
        ...(Array.isArray(sourceContext.summary.subtask_results) ? sourceContext.summary.subtask_results : []).map((entry) => [
          safeString(entry.subtask_id || entry.task_id),
          safeString(entry.output_path),
          safeString(entry.status) || "completed"
        ])
      ]));
      writeText(previewPath, shortText(renderResearchReport(offer, sourceContext), 1200));
      artifactRefs.primary_deliverable = relativeFrom(bundleDir, reportPath);
      artifactRefs.structured_support = relativeFrom(bundleDir, tablesPath);
      artifactRefs.supporting_appendix = relativeFrom(bundleDir, appendixPath);
      artifactRefs.sample_preview = relativeFrom(bundleDir, previewPath);
    } else {
      const datasetPath = path.join(deliverablesDir, "dataset.jsonl");
      const schemaPath = path.join(deliverablesDir, "schema.json");
      const buildReportPath = path.join(deliverablesDir, "build-report.json");
      const validationReportPath = path.join(deliverablesDir, "validation-report.json");
      const dedupeReportPath = path.join(deliverablesDir, "dedupe-report.json");
      const provenancePath = path.join(deliverablesDir, "provenance.json");
      const qualityReportPath = path.join(deliverablesDir, "quality-report.json");
      const licenseReportPath = path.join(deliverablesDir, "license-report.json");
      const cardPath = path.join(deliverablesDir, "dataset-card.md");
      const previewPath = path.join(deliverablesDir, "sample-preview.jsonl");
      fs.copyFileSync(sourceContext.dataset_path, datasetPath);
      fs.copyFileSync(sourceContext.schema_path, schemaPath);
      fs.copyFileSync(sourceContext.build_report_path, buildReportPath);
      copyIfExists(sourceContext.validation_report_path, validationReportPath);
      copyIfExists(sourceContext.dedupe_report_path, dedupeReportPath);
      copyIfExists(sourceContext.provenance_path, provenancePath);
      copyIfExists(sourceContext.quality_report_path, qualityReportPath);
      copyIfExists(sourceContext.license_report_path, licenseReportPath);
      writeText(cardPath, renderDatasetCard(offer, sourceContext));
      const previewLines = fs.readFileSync(sourceContext.dataset_path, "utf8").split("\n").filter(Boolean).slice(0, 5).join("\n");
      writeText(previewPath, previewLines ? `${previewLines}\n` : "");
      artifactRefs.primary_deliverable = relativeFrom(bundleDir, datasetPath);
      artifactRefs.structured_support = relativeFrom(bundleDir, schemaPath);
      artifactRefs.supporting_appendix = relativeFrom(bundleDir, cardPath);
      artifactRefs.sample_preview = relativeFrom(bundleDir, previewPath);
      artifactRefs.build_report = relativeFrom(bundleDir, buildReportPath);
      if (fs.existsSync(validationReportPath)) {
        artifactRefs.validation_report = relativeFrom(bundleDir, validationReportPath);
      }
      if (fs.existsSync(dedupeReportPath)) {
        artifactRefs.dedupe_report = relativeFrom(bundleDir, dedupeReportPath);
      }
      if (fs.existsSync(provenancePath)) {
        artifactRefs.provenance = relativeFrom(bundleDir, provenancePath);
      }
      if (fs.existsSync(qualityReportPath)) {
        artifactRefs.quality_report = relativeFrom(bundleDir, qualityReportPath);
      }
      if (fs.existsSync(licenseReportPath)) {
        artifactRefs.license_report = relativeFrom(bundleDir, licenseReportPath);
      }
    }

    const storeCopyPath = path.join(deliverablesDir, "store-copy.md");
    const submissionMetadataPath = path.join(deliverablesDir, "submission-metadata.json");
    const deliveryManifestPath = path.join(deliverablesDir, "delivery-manifest.json");
    const privateDeliveryNotePath = path.join(deliverablesDir, "private-delivery-note.md");
    writeText(storeCopyPath, renderStoreCopy(offer, sourceContext));
    writeJson(submissionMetadataPath, canonicalize({
      offer_id: safeString(offer.offer_id),
      offer_title: safeString(offer.offer_title),
      manual_only: true,
      packaging_artifact: true,
      source_kind: safeString(sourceContext.source_kind),
      source_id: safeString(sourceContext.source_id),
      build_id: safeString(sourceContext.build_id),
      commercialization_ready: sourceContext.source_kind === "dataset" && sourceContext.phase20_status
        ? sourceContext.phase20_status.commercialization_ready === true
        : false,
      license_state: sourceContext.source_kind === "dataset" && sourceContext.phase20_status
        ? safeString(sourceContext.phase20_status.license_state)
        : "",
      platform_targets: Array.isArray(offer.platform_targets) ? offer.platform_targets : []
    }));
    writeJson(deliveryManifestPath, canonicalize({
      offer_id: safeString(offer.offer_id),
      product_line: safeString(offer.product_line),
      tier: safeString(offer.tier),
      source_kind: safeString(sourceContext.source_kind),
      source_id: safeString(sourceContext.source_id),
      build_id: safeString(sourceContext.build_id),
      manual_only: true,
      source_status: sourceContext.source_kind === "dataset" ? canonicalize(sourceContext.phase20_status || {}) : {}
    }));
    writeText(privateDeliveryNotePath, renderPrivateDeliveryNote(offer));
    artifactRefs.store_copy = relativeFrom(bundleDir, storeCopyPath);
    artifactRefs.submission_metadata = relativeFrom(bundleDir, submissionMetadataPath);
    artifactRefs.delivery_manifest = relativeFrom(bundleDir, deliveryManifestPath);
    artifactRefs.private_delivery_note = relativeFrom(bundleDir, privateDeliveryNotePath);

    const missingSlots = asStringArray(offer.artifact_slots).filter((slot) => !safeString(artifactRefs[slot]));
    if (missingSlots.length > 0) {
      const error = new Error(`Bundle is missing required artifact slots: ${missingSlots.join(", ")}`);
      error.code = "PHASE19_RELEASE_ARTIFACT_SLOT_MISSING";
      throw error;
    }

    return canonicalize(artifactRefs);
  }

  function writeBundleRoot(bundleDir, offer, sourceContext, artifactRefs, submissionRefs = {}, publisherAdapterSnapshot = {}) {
    const offerPath = path.join(bundleDir, "offer.json");
    const metadataPath = path.join(bundleDir, "metadata.json");
    const releaseNotesPath = path.join(bundleDir, "release-notes.md");
    const expectedTargets = Array.isArray(offer.platform_targets) ? offer.platform_targets.slice().sort((left, right) => left.localeCompare(right)) : [];
    const validatedAdapterSnapshot = validatePublisherAdapterSnapshot(publisherAdapterSnapshot, {
      expected_targets: expectedTargets
    });
    writeJson(offerPath, canonicalize({
      ...offer,
      artifact_refs: canonicalize({
        ...artifactRefs,
        submission: submissionRefs
      })
    }));
    writeJson(metadataPath, canonicalize({
      schema_version: PHASE21_RELEASE_METADATA_SCHEMA,
      offer_id: safeString(offer.offer_id),
      offer_title: safeString(offer.offer_title),
      product_line: safeString(offer.product_line),
      tier: safeString(offer.tier),
      source_kind: safeString(sourceContext.source_kind),
      source_id: safeString(sourceContext.source_id),
      build_id: safeString(sourceContext.build_id),
      platform_targets: Array.isArray(offer.platform_targets) ? offer.platform_targets : [],
      workflow_roles: Array.isArray(offer.workflow_roles) ? offer.workflow_roles : [],
      release_status: safeString(offer.release_status) || "packaged",
      packaging_artifact: true,
      publication_state: "not_published",
      manual_submission_only: true,
      publisher_adapter_required: true,
      publisher_adapter_snapshot_hash: safeString(validatedAdapterSnapshot.publisher_adapter_snapshot_hash),
      publisher_adapter_snapshot: validatedAdapterSnapshot,
      source_status: sourceContext.source_kind === "dataset" ? canonicalize(sourceContext.phase20_status || {}) : {},
      warnings: Array.isArray(sourceContext.warnings) ? sourceContext.warnings : []
    }));
    writeText(releaseNotesPath, [
      `# Release Notes: ${safeString(offer.offer_id)}`,
      "",
      "This bundle is prepared for manual-only delivery or manual-only listing submission.",
      "",
      `Product line: ${safeString(offer.product_line)}`,
      `Tier: ${safeString(offer.tier)}`,
      `Source: ${safeString(sourceContext.source_kind)} ${safeString(sourceContext.source_id)}`,
      `Targets: ${(Array.isArray(offer.platform_targets) ? offer.platform_targets : []).join(", ")}`,
      ...(sourceContext.source_kind === "dataset" ? [`License state: ${safeString(sourceContext.phase20_status && sourceContext.phase20_status.license_state) || "blocked"}`] : []),
      ...(Array.isArray(sourceContext.warnings) && sourceContext.warnings.length > 0 ? sourceContext.warnings.map((entry) => `Warning: ${entry}`) : []),
      ""
    ].join("\n"));
  }

  function finalizeBundle(bundleDir) {
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
    files.sort((left, right) => left.file.localeCompare(right.file));
    const manifestPath = path.join(bundleDir, "manifest.json");
    const checksumsPath = path.join(bundleDir, "checksums.txt");
    writeJson(manifestPath, canonicalize({
      schema_version: "phase19-release-manifest-v1",
      files
    }));
    writeText(checksumsPath, files.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n") + (files.length > 0 ? "\n" : ""));
    return canonicalize({
      manifest_path: manifestPath,
      checksums_path: checksumsPath,
      files
    });
  }

  function commitBundle(tempBundleDir, offerId) {
    const finalBundleDir = path.join(releasesDir, offerId);
    if (fs.existsSync(finalBundleDir)) {
      fs.rmSync(finalBundleDir, { recursive: true, force: true });
    }
    ensureDir(path.dirname(finalBundleDir));
    fs.renameSync(tempBundleDir, finalBundleDir);
    return finalBundleDir;
  }

  return Object.freeze({
    createBundleWorkspace,
    writeDeliverables,
    writeBundleRoot,
    finalizeBundle,
    commitBundle,
    releasesDir
  });
}

module.exports = {
  createDeliverablePackager
};
