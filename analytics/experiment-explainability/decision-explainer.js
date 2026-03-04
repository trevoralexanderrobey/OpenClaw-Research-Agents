"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");
const { buildRecommendationRationale } = require("./recommendation-rationale.js");

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (!isObject(value)) {
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

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildDecisionExplanation(input = {}) {
  const asOfIso = safeString(input.asOfIso);
  const experiment = isObject(input.experiment) ? input.experiment : {};
  const analysisSnapshot = isObject(input.analysisSnapshot) ? input.analysisSnapshot : {};
  const decision = isObject(input.decision) ? input.decision : {};

  const rationale = buildRecommendationRationale({
    recommendation: safeString(analysisSnapshot.recommendation),
    reasonCode: safeString(analysisSnapshot.reasonCode),
    metrics: analysisSnapshot.metrics,
    guardrailBreaches: analysisSnapshot.guardrailBreaches
  });

  const markdownLines = [
    "# Phase 7 Explainability Report",
    "",
    "AI-assisted analysis disclosure: This report is produced by deterministic internal analytics. External submission remains human-only.",
    "",
    `Generated At: ${asOfIso}`,
    `Experiment: ${safeString(experiment.name) || `#${Number(experiment.sequence || 0)}`}`,
    `Experiment Sequence: ${Number(experiment.sequence || 0)}`,
    `Decision Recommendation: ${safeString(rationale.recommendation)}`,
    `Reason Code: ${safeString(rationale.reasonCode)}`,
    "",
    "## Ranked Factors",
    "| Rank | Factor | Value | Impact |",
    "| ---: | --- | ---: | ---: |",
    ...rationale.factors.map((factor) => `| ${Number(factor.rank)} | ${safeString(factor.label)} | ${Number(factor.value)} | ${Number(factor.impact)} |`),
    "",
    "## Guardrail Breaches",
    ...(Array.isArray(rationale.guardrailBreaches) && rationale.guardrailBreaches.length > 0
      ? rationale.guardrailBreaches.map((item) => `- ${safeString(item)}`)
      : ["- none"]),
    "",
    "## Decision Trace",
    `- Applied Decision: ${safeString(decision.decision) || "n/a"}`,
    `- Decision Sequence: ${Number(decision.sequence || 0)}`,
    `- Decision Hash: ${safeString(decision.decisionHash) || ""}`,
    ""
  ];

  return {
    ok: true,
    asOfIso,
    rationale: canonicalize(rationale),
    markdown: `${markdownLines.join("\n")}\n`
  };
}

async function writePhase7Artifacts(input = {}) {
  const apiGovernance = input.apiGovernance;
  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    throw new Error("apiGovernance.readState is required");
  }

  const asOf = safeString(input.asOfIso) || String(nowIso());
  const outDir = path.resolve(input.outDir || path.join(process.cwd(), "audit", "evidence", "phase7"));
  await fs.mkdir(outDir, { recursive: true });

  const state = await apiGovernance.readState();
  const governance = state && state.experimentGovernance && typeof state.experimentGovernance === "object"
    ? state.experimentGovernance
    : {};

  const experiments = Array.isArray(governance.experiments) ? governance.experiments : [];
  const assignments = Array.isArray(governance.assignments) ? governance.assignments : [];
  const analysisSnapshots = Array.isArray(governance.analysisSnapshots) ? governance.analysisSnapshots : [];
  const rolloutDecisions = Array.isArray(governance.rolloutDecisions) ? governance.rolloutDecisions : [];
  const decisionLedger = governance.decisionLedger && typeof governance.decisionLedger === "object"
    ? governance.decisionLedger
    : { records: [], nextSequence: 0, chainHead: "" };

  const latestAnalysis = analysisSnapshots
    .slice()
    .sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0))[0] || {};
  const latestDecision = rolloutDecisions
    .slice()
    .sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0))[0] || {};
  const latestExperiment = experiments
    .slice()
    .sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0))[0] || {};

  const explanation = buildDecisionExplanation({
    asOfIso: asOf,
    experiment: latestExperiment,
    analysisSnapshot: latestAnalysis,
    decision: latestDecision
  });

  const files = {
    "experiment-catalog.json": canonicalJson({
      policyVersion: safeString(governance.policyVersion) || "v1",
      activeRolloutProfile: governance.activeRolloutProfile || {},
      experiments
    }),
    "assignment-snapshot.json": canonicalJson({ assignments }),
    "analysis-snapshot.json": canonicalJson({ analysisSnapshots }),
    "rollout-decisions.json": canonicalJson({ rolloutDecisions }),
    "decision-ledger-chain.json": canonicalJson({ decisionLedger }),
    "explainability-report.md": explanation.markdown
  };

  const manifestEntries = [];
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(outDir, name), body, "utf8");
    manifestEntries.push({
      file: name,
      sha256: sha256(body)
    });
  }

  const manifestBody = canonicalJson({
    generatedAt: asOf,
    files: manifestEntries.sort((left, right) => left.file.localeCompare(right.file))
  });
  await fs.writeFile(path.join(outDir, "phase7-hash-manifest.json"), manifestBody, "utf8");

  return {
    ok: true,
    outDir,
    files: [...Object.keys(files), "phase7-hash-manifest.json"].sort()
  };
}

module.exports = {
  buildDecisionExplanation,
  writePhase7Artifacts,
  canonicalize,
  canonicalJson,
  sha256
};
