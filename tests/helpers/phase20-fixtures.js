"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function copyRepoFiles(targetRoot, relPaths) {
  for (const rel of relPaths) {
    const source = path.join(repoRoot, rel);
    const target = path.join(targetRoot, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
  }
}

async function copyDatasetConfigs(targetRoot) {
  await copyRepoFiles(targetRoot, [
    "config/dataset-schemas.json",
    "config/dataset-quality-rules.json",
    "config/dataset-license-rules.json"
  ]);
}

async function copyMonetizationConfigs(targetRoot) {
  await copyRepoFiles(targetRoot, [
    "config/monetization-map.json",
    "config/platform-targets.json"
  ]);
}

function readFixtureText(fixtureName) {
  return fs.readFileSync(path.join(repoRoot, "tests", "fixtures", "phase19", fixtureName), "utf8");
}

function writeTaskOutput(rootDir, taskId, fixtureName, metadataExtras = {}) {
  const taskDir = path.join(rootDir, "workspace", "research-output", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "output.md"), readFixtureText(fixtureName), "utf8");
  writeJson(path.join(taskDir, "metadata.json"), {
    task_id: taskId,
    status: "completed",
    type: "extract",
    output_format: "markdown",
    ...metadataExtras
  });
  writeJson(path.join(taskDir, "manifest.json"), {
    schema_version: "phase14-output-manifest-v1",
    task_id: taskId,
    files: [
      { file: "metadata.json", sha256: "meta" },
      { file: "output.md", sha256: "body" }
    ]
  });
  return path.join(taskDir, "output.md");
}

function writeTaskText(rootDir, taskId, text, metadataExtras = {}) {
  const taskDir = path.join(rootDir, "workspace", "research-output", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "output.md"), String(text || ""), "utf8");
  writeJson(path.join(taskDir, "metadata.json"), {
    task_id: taskId,
    status: "completed",
    type: "extract",
    output_format: "markdown",
    ...metadataExtras
  });
  writeJson(path.join(taskDir, "manifest.json"), {
    schema_version: "phase14-output-manifest-v1",
    task_id: taskId,
    files: [
      { file: "metadata.json", sha256: "meta" },
      { file: "output.md", sha256: "body" }
    ]
  });
  return path.join(taskDir, "output.md");
}

function createDatasetBuildInput(overrides = {}) {
  return {
    dataset_id: "dataset-phase20-demo",
    build_id: "build-0001",
    dataset_type: "instruction_qa",
    target_schema: "phase19-instruction-qa-v1",
    rows: [
      {
        answer: "Enterprise buyers prioritize integration depth and auditability.",
        context: "Enterprise buyers are prioritizing integration depth and auditability.",
        instruction: "Explain the buyer signal.",
        row_hash: "row-hash-1"
      }
    ],
    schema: {
      dataset_type: "instruction_qa",
      schema_version: "phase19-instruction-qa-v1"
    },
    build_report: {
      ok: true
    },
    validation_report: {
      build_summary: {
        validation_status: "passed"
      }
    },
    dedupe_report: {
      build_summary: {
        exact_duplicate_count: 0
      }
    },
    provenance: {
      build_summary: {
        row_count: 1
      }
    },
    quality_report: {
      build_summary: {
        build_score: 100,
        quality_status: "passed"
      }
    },
    license_report: {
      build_summary: {
        license_state: "allowed"
      }
    },
    validation_status: "passed",
    quality_status: "passed",
    license_state: "allowed",
    commercialization_ready: true,
    source_task_ids: ["task-1"],
    build_started_at: "2026-03-06T00:00:00.000Z",
    build_completed_at: "2026-03-06T00:00:00.000Z",
    ...overrides
  };
}

module.exports = {
  copyDatasetConfigs,
  copyMonetizationConfigs,
  copyRepoFiles,
  createDatasetBuildInput,
  repoRoot,
  writeJson,
  writeTaskOutput,
  writeTaskText
};
