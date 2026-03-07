"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createLicenseReview } = require(path.join(root, "openclaw-bridge", "dataset", "license-review.js"));

test("phase20 license review blocks unknown rights states fail-closed", () => {
  const review = createLicenseReview({ rootDir: root });
  const result = review.classifyBuild({
    provenance_result: {
      row_records: [
        {
          row_hash: "row-hash-1",
          row_number: 1,
          source_task_ids: ["task-1"]
        }
      ]
    },
    source_artifacts: [
      {
        metadata: {
          source_domain: "unknown.example"
        },
        output_path: "/tmp/output.md",
        task_id: "task-1"
      }
    ]
  });

  assert.equal(result.license_state, "blocked");
  assert.match(JSON.stringify(result.license_report.build_summary.blocked_reason_codes), /PHASE20_LICENSE_UNKNOWN_BLOCKED/);
});

test("phase20 license review rolls mixed-source builds up conservatively", () => {
  const review = createLicenseReview({ rootDir: root });
  const result = review.classifyBuild({
    provenance_result: {
      row_records: [
        {
          row_hash: "row-hash-1",
          row_number: 1,
          source_task_ids: ["task-1", "task-2"]
        }
      ]
    },
    source_artifacts: [
      {
        metadata: {
          license: "cc-by-4.0"
        },
        output_path: "/tmp/output-1.md",
        task_id: "task-1"
      },
      {
        metadata: {
          license: "custom-review"
        },
        output_path: "/tmp/output-2.md",
        task_id: "task-2"
      }
    ]
  });

  assert.equal(result.license_state, "review_required");
  assert.match(JSON.stringify(result.license_report.build_summary.review_required_reason_codes), /PHASE20_LICENSE_IDENTIFIER_REVIEW_REQUIRED/);
  assert.equal(result.row_reviews[0].license_state, "review_required");
});
