"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { nowIso } = require("../../openclaw-bridge/core/time-provider.js");

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
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

function ensureDependencies(apiGovernance, portfolioPlanner) {
  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    const error = new Error("apiGovernance.readState is required");
    error.code = "RLHF_WEEKLY_REPORT_CONFIG_INVALID";
    throw error;
  }
  if (!portfolioPlanner || typeof portfolioPlanner.buildPortfolioPlan !== "function") {
    const error = new Error("portfolioPlanner.buildPortfolioPlan is required");
    error.code = "RLHF_WEEKLY_REPORT_CONFIG_INVALID";
    throw error;
  }
}

function buildWeeklyIntelMarkdown(input = {}) {
  const asOfIso = String(input.asOfIso || "");
  const outcomeSummary = input.outcomeSummary && typeof input.outcomeSummary === "object" ? input.outcomeSummary : {};
  const calibration = input.calibration && typeof input.calibration === "object" ? input.calibration : {};
  const priorities = Array.isArray(input.priorities) ? input.priorities : [];
  const workload = input.workloadBalancing && typeof input.workloadBalancing === "object" ? input.workloadBalancing : {};

  const lines = [
    "# Phase 6 Weekly Intelligence Report",
    "",
    `Generated At: ${asOfIso}`,
    "",
    "## Outcome Summary",
    `- Total Outcomes: ${Number(outcomeSummary.totalOutcomes || 0)}`,
    `- Finalized Outcomes: ${Number(outcomeSummary.finalizedOutcomes || 0)}`,
    `- Pending Outcomes: ${Number(outcomeSummary.pendingOutcomes || 0)}`,
    `- Chain Head Sequence: ${Number(outcomeSummary.chainHeadSequence || 0)}`,
    "",
    "## Calibration Snapshot",
    `- Version: ${String(calibration.version || "v1")}`,
    `- Last Calibrated At: ${String(calibration.lastCalibratedAt || "")}`,
    `- Weights: complexity=${Number(calibration.weights && calibration.weights.complexity ? calibration.weights.complexity : 0)}, monetization=${Number(calibration.weights && calibration.weights.monetization ? calibration.weights.monetization : 0)}, qualitySignal=${Number(calibration.weights && calibration.weights.qualitySignal ? calibration.weights.qualitySignal : 0)}`,
    "",
    "## Portfolio Priorities",
    "| Rank | Domain | EV Score | Complexity Band | Pending | Review Slots |",
    "| ---: | --- | ---: | --- | ---: | ---: |",
    ...priorities.map((item) => `| ${Number(item.priorityRank || 0)} | ${String(item.domainTag || "")} | ${Number(item.expectedValueScore || 0)} | ${String(item.complexityBand || "low")} | ${Number(item.pendingCount || 0)} | ${Number(item.recommendedReviewSlots || 0)} |`),
    "",
    "## Workload Balancing",
    `- Total Pending: ${Number(workload.totalPending || 0)}`,
    `- Recommended Reviewer Load: ${Number(workload.recommendedReviewerLoad || 0)}`,
    "",
    "## Governance Boundaries",
    "- External submission remains manual-only.",
    "- No browser/login automation is used.",
    "- Outcome ingestion is operator-entered only.",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function createWeeklyReportBuilder(options = {}) {
  const apiGovernance = options.apiGovernance;
  const portfolioPlanner = options.portfolioPlanner;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };
  const defaultOutDir = path.resolve(options.outDir || path.join(process.cwd(), "audit", "evidence", "phase6"));

  ensureDependencies(apiGovernance, portfolioPlanner);

  async function buildWeeklyIntelReport(input = {}) {
    const asOfIso = typeof input.asOfIso === "string" && input.asOfIso.trim() ? input.asOfIso.trim() : String(timeProvider.nowIso());
    const state = await apiGovernance.readState();
    const outcomes = Array.isArray(state && state.rlhfOutcomes && state.rlhfOutcomes.records) ? state.rlhfOutcomes.records : [];
    const finalizedOutcomes = outcomes.filter((record) => record && record.result !== "pending").length;
    const pendingOutcomes = outcomes.length - finalizedOutcomes;

    const outcomeSummary = canonicalize({
      totalOutcomes: outcomes.length,
      finalizedOutcomes,
      pendingOutcomes,
      chainHeadHash: String(state && state.rlhfOutcomes && state.rlhfOutcomes.chainHeadHash ? state.rlhfOutcomes.chainHeadHash : ""),
      chainHeadSequence: Number(state && state.rlhfOutcomes && state.rlhfOutcomes.chainHeadSequence ? state.rlhfOutcomes.chainHeadSequence : 0)
    });

    const calibration = canonicalize(state && state.rlhfOutcomes && state.rlhfOutcomes.calibration
      ? state.rlhfOutcomes.calibration
      : {
          version: "v1",
          lastCalibratedAt: "",
          weights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 }
        });

    const portfolioPlan = await portfolioPlanner.buildPortfolioPlan({ asOfIso });
    const priorities = Array.isArray(portfolioPlan.priorities) ? portfolioPlan.priorities : [];

    return {
      ok: true,
      noOp: Boolean(portfolioPlan.noOp),
      asOfIso,
      outcomeSummary,
      calibration,
      priorities,
      workloadBalancing: portfolioPlan.workloadBalancing || { totalPending: 0, recommendedReviewerLoad: 0 },
      markdown: buildWeeklyIntelMarkdown({
        asOfIso,
        outcomeSummary,
        calibration,
        priorities,
        workloadBalancing: portfolioPlan.workloadBalancing || { totalPending: 0, recommendedReviewerLoad: 0 }
      })
    };
  }

  async function writePhase6Artifacts(input = {}) {
    const outDir = path.resolve(input.outDir || defaultOutDir);
    const report = await buildWeeklyIntelReport({ asOfIso: input.asOfIso });
    await fs.mkdir(outDir, { recursive: true });

    const files = {
      "outcome-summary.json": canonicalJson(report.outcomeSummary),
      "calibration-snapshot.json": canonicalJson(report.calibration),
      "portfolio-priorities.json": canonicalJson({ priorities: report.priorities, workloadBalancing: report.workloadBalancing }),
      "weekly-intel-report.md": report.markdown
    };

    const manifestEntries = [];
    for (const [name, body] of Object.entries(files)) {
      const filePath = path.join(outDir, name);
      await fs.writeFile(filePath, body, "utf8");
      manifestEntries.push({
        file: name,
        sha256: sha256(body)
      });
    }

    const manifest = canonicalJson({
      generatedAt: report.asOfIso,
      noOp: Boolean(report.noOp),
      files: manifestEntries.sort((left, right) => left.file.localeCompare(right.file))
    });
    await fs.writeFile(path.join(outDir, "report-hash-manifest.json"), manifest, "utf8");

    return {
      ok: true,
      outDir,
      noOp: Boolean(report.noOp),
      files: [...Object.keys(files), "report-hash-manifest.json"].sort()
    };
  }

  return Object.freeze({
    buildWeeklyIntelReport,
    writePhase6Artifacts
  });
}

module.exports = {
  createWeeklyReportBuilder,
  buildWeeklyIntelMarkdown
};
