#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { buildMonetizationRuntime } = require("./_monetization-runtime.js");

function crc32(buffer) {
  let crc = ~0;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function parseArgs(argv) {
  const out = {
    offerId: "",
    format: "folder",
    operatorId: process.env.OPERATOR_ID || "operator-cli",
    confirm: false,
    unknown: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--offer-id") { out.offerId = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--format") { out.format = String(argv[index + 1] || "").trim() || "folder"; index += 1; continue; }
    if (token === "--operator-id") { out.operatorId = String(argv[index + 1] || "").trim() || out.operatorId; index += 1; continue; }
    if (token === "--confirm") { out.confirm = true; continue; }
    out.unknown.push(token);
  }
  return out;
}

function copyDir(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function buildDeterministicZip(sourceDir, zipPath) {
  const localEntries = [];
  const centralEntries = [];
  let offset = 0;
  const files = [];

  const stack = [sourceDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries.reverse()) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      files.push(fullPath);
    }
  }
  files.sort((left, right) => left.localeCompare(right));

  for (const filePath of files) {
    const rel = path.relative(sourceDir, filePath).split(path.sep).join("/");
    const nameBuffer = Buffer.from(rel, "utf8");
    const data = fs.readFileSync(filePath);
    const fileCrc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(fileCrc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localEntries.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(fileCrc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralEntries.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralDir = Buffer.concat(centralEntries);
  const localDir = Buffer.concat(localEntries);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDir.length, 12);
  endRecord.writeUInt32LE(localDir.length, 16);
  endRecord.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([localDir, centralDir, endRecord]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !args.offerId || !["folder", "zip"].includes(args.format)) {
    process.stderr.write("Usage: node scripts/export-release.js --offer-id <offer_id> --format zip|folder [--operator-id <operator_id>] --confirm\n");
    process.exit(1);
  }
  if (!args.confirm) {
    process.stderr.write("Release export rejected: --confirm is required\n");
    process.exit(1);
  }

  const runtime = buildMonetizationRuntime();
  const validated = runtime.releaseApprovalManager.validateApprovedRelease(args.offerId);
  const bundleDir = validated.bundle_dir;
  if (args.format === "folder") {
    const targetDir = path.join(runtime.rootDir, "workspace", "releases", `${args.offerId}-export`);
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    copyDir(bundleDir, targetDir);
    const exportArtifactRef = await runtime.submissionEvidenceManager.buildExportArtifactRef({
      export_path: targetDir
    });
    const exportEvent = await runtime.submissionEvidenceManager.recordExportEvent({
      offer_id: args.offerId,
      operator_id: args.operatorId,
      export_format: "folder",
      exported_platform_targets: validated.approval && Array.isArray(validated.approval.approved_platform_targets)
        ? validated.approval.approved_platform_targets
        : [],
      export_artifact_refs: [exportArtifactRef]
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      offer_id: args.offerId,
      export_path: targetDir,
      format: "folder",
      dataset_phase20_status: validated.dataset_phase20_status || {},
      publisher_adapter_status: validated.publisher_adapter_status || {},
      submission_evidence_export_event: exportEvent.event
    }, null, 2)}\n`);
    return;
  }

  const zipPath = path.join(runtime.rootDir, "workspace", "releases", `${args.offerId}-export.zip`);
  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath, { force: true });
  }
  buildDeterministicZip(bundleDir, zipPath);
  const exportArtifactRef = await runtime.submissionEvidenceManager.buildExportArtifactRef({
    export_path: zipPath
  });
  const exportEvent = await runtime.submissionEvidenceManager.recordExportEvent({
    offer_id: args.offerId,
    operator_id: args.operatorId,
    export_format: "zip",
    exported_platform_targets: validated.approval && Array.isArray(validated.approval.approved_platform_targets)
      ? validated.approval.approved_platform_targets
      : [],
    export_artifact_refs: [exportArtifactRef]
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    offer_id: args.offerId,
    export_path: zipPath,
    format: "zip",
    dataset_phase20_status: validated.dataset_phase20_status || {},
    publisher_adapter_status: validated.publisher_adapter_status || {},
    submission_evidence_export_event: exportEvent.event
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
