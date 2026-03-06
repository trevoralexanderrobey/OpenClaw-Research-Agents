#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { canonicalize } = require("../workflows/governance-automation/common.js");
const { writeEvidenceSet } = require("./_live-verification-common.js");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "audit", "evidence", "history");

const TARGETS = Object.freeze([
  {
    path: "README.md",
    claim: "Repository seed existed before the Phase 1 scaffold bundle.",
    bucket: "historical-seed",
    kind: "scaffolded",
    confidence: "high"
  },
  {
    path: "PHASE1_ARCHITECTURAL_BLUEPRINT.md",
    claim: "Phase 1 architectural blueprint was introduced as historical design documentation.",
    bucket: "phase1-docs",
    kind: "scaffolded",
    confidence: "high"
  },
  {
    path: "audit/phase1-checklist.md",
    claim: "Phase 1 audit checklist was introduced.",
    bucket: "phase1-audit",
    kind: "scaffolded",
    confidence: "high"
  },
  {
    path: "audit/phase1-signoff.md",
    claim: "Phase 1 sign-off record was introduced.",
    bucket: "phase1-audit",
    kind: "scaffolded",
    confidence: "high"
  },
  {
    path: "audit/run_phase1_checks.sh",
    claim: "Phase 1 shell-based verification harness was introduced.",
    bucket: "phase1-audit",
    kind: "implemented",
    confidence: "high"
  },
  {
    path: "audit/purge-manifest-phase1.md",
    claim: "Phase 1 purge manifest was introduced.",
    bucket: "phase1-audit",
    kind: "scaffolded",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/docs/phase1-build-order.md",
    claim: "Phase 1 chronological build-order documentation was introduced.",
    bucket: "phase1-docs",
    kind: "scaffolded",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/docs/phase1-exit-criteria.md",
    claim: "Phase 1 exit-criteria documentation was introduced.",
    bucket: "phase1-docs",
    kind: "scaffolded",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/docs/phase1-freeze-policy.md",
    claim: "Phase 1 freeze-policy documentation was introduced.",
    bucket: "phase1-docs",
    kind: "scaffolded",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/docs/threat-model-phase1.md",
    claim: "Phase 1 threat-model documentation was introduced.",
    bucket: "phase1-docs",
    kind: "scaffolded",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/docs/state-schema-phase1.md",
    claim: "A state-schema document introduced in the Phase 1 scaffold bundle survived on main, although the content evolved later.",
    bucket: "phase1-docs",
    kind: "scaffolded",
    confidence: "medium"
  },
  {
    path: "openclaw-bridge/docs/mcp-contracts-phase1.md",
    claim: "Phase 1 MCP contract scaffold documentation was introduced.",
    bucket: "phase1-docs",
    kind: "scaffolded",
    confidence: "high"
  },
  {
    path: "security/operator-authorization.js",
    claim: "Operator authorization enforcement code was introduced in the Phase 1 scaffold bundle.",
    bucket: "runtime-skeleton",
    kind: "implemented",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/execution/container-runtime.js",
    claim: "Container runtime code was introduced in the Phase 1 scaffold bundle.",
    bucket: "runtime-skeleton",
    kind: "implemented",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/mcp/mcp-service.js",
    claim: "MCP service code was introduced in the Phase 1 scaffold bundle.",
    bucket: "runtime-skeleton",
    kind: "implemented",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/supervisor/supervisor-v1.js",
    claim: "Supervisor orchestration code was introduced in the Phase 1 scaffold bundle.",
    bucket: "runtime-skeleton",
    kind: "implemented",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/supervisor/request-queue.js",
    claim: "Request queue code was introduced in the Phase 1 scaffold bundle.",
    bucket: "runtime-skeleton",
    kind: "implemented",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/supervisor/circuit-breaker.js",
    claim: "Circuit breaker code was introduced in the Phase 1 scaffold bundle.",
    bucket: "runtime-skeleton",
    kind: "implemented",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/src/core/execution-router.ts",
    claim: "Execution-router code was introduced in the Phase 1 scaffold bundle.",
    bucket: "runtime-skeleton",
    kind: "implemented",
    confidence: "high"
  },
  {
    path: "openclaw-bridge/state/persistent-store.js",
    claim: "Persistent state code was introduced in the Phase 1 scaffold bundle.",
    bucket: "runtime-skeleton",
    kind: "implemented",
    confidence: "high"
  },
  {
    path: "workspace/runtime/state.json",
    claim: "Workspace runtime state scaffold file was introduced.",
    bucket: "workspace-scaffold",
    kind: "implemented",
    confidence: "high"
  },
  {
    path: "workspace/comms/.gitkeep",
    claim: "Workspace comms scaffold path was introduced.",
    bucket: "workspace-scaffold",
    kind: "scaffolded",
    confidence: "high"
  }
]);

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function firstIntroducingCommit(filePath) {
  const output = git(["log", "--diff-filter=A", "--format=%H\t%s", "--", filePath]);
  const line = output.split("\n").filter(Boolean).pop() || "";
  const [sha = "", subject = ""] = line.split("\t");
  return canonicalize({
    sha,
    subject
  });
}

function fileExistsOnMain(filePath) {
  try {
    git(["cat-file", "-e", `HEAD:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

function buildEvidenceMap() {
  const entries = TARGETS.map((target) => {
    const introduced = firstIntroducingCommit(target.path);
    return canonicalize({
      bucket: target.bucket,
      claim: target.claim,
      confidence: target.confidence,
      file_exists_on_main: fileExistsOnMain(target.path),
      introduced_commit: introduced,
      kind: target.kind,
      path: target.path
    });
  });

  const repoSeed = firstIntroducingCommit("README.md");
  return canonicalize({
    generated_at: new Date().toISOString(),
    historical_reconstruction: true,
    limits: [
      "No successful Phase 1-era workflow run is embedded in this artifact.",
      "Current file contents may have evolved after their first introduction; this map proves first-introduction history, not unchanged content."
    ],
    phase1_repo_seed_commit: repoSeed,
    summary: {
      implemented_count: entries.filter((entry) => entry.kind === "implemented").length,
      scaffolded_count: entries.filter((entry) => entry.kind === "scaffolded").length,
      first_phase1_bundle_commit: firstIntroducingCommit("audit/phase1-checklist.md")
    },
    targets: entries
  });
}

function main() {
  const payload = buildEvidenceMap();
  const written = writeEvidenceSet(OUTPUT_DIR, "phase1-evidence-map", payload);
  process.stdout.write(`${JSON.stringify(canonicalize({
    ok: true,
    output: written
  }), null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  TARGETS,
  buildEvidenceMap,
  fileExistsOnMain,
  firstIntroducingCommit
};

module.exports = {
  TARGETS,
  buildEvidenceMap,
  fileExistsOnMain,
  firstIntroducingCommit
};
