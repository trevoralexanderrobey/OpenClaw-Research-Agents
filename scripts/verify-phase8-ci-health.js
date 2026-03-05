#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const https = require("node:https");
const path = require("node:path");

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    repo: "trevoralexanderrobey/OpenClaw-Research-Agents",
    workflowName: "phase2-security",
    mergeSha: "",
    historicalRunId: "22658655231",
    fixtureRuns: "",
    fixtureJobs: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--repo") {
      out.repo = safeString(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--workflow-name") {
      out.workflowName = safeString(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--merge-sha") {
      out.mergeSha = safeString(argv[index + 1]).toLowerCase();
      index += 1;
      continue;
    }
    if (token === "--historical-run-id") {
      out.historicalRunId = safeString(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--fixture-runs") {
      out.fixtureRuns = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (token === "--fixture-jobs") {
      out.fixtureJobs = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
  }

  return out;
}

async function readJsonFile(filePath) {
  const body = await fs.readFile(filePath, "utf8");
  return JSON.parse(body);
}

function requestJson(url, token) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "openclaw-phase8-ci-health",
      "Accept": "application/vnd.github+json"
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const req = https.request(url, { method: "GET", headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`GitHub API request failed (${res.statusCode}): ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(data || "{}"));
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function getRuns(payload) {
  if (payload && Array.isArray(payload.workflow_runs)) {
    return payload.workflow_runs;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function getJobs(payload) {
  if (payload && Array.isArray(payload.jobs)) {
    return payload.jobs;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function findLatestRunForMergeSha(runs, mergeSha, workflowName) {
  const filtered = runs
    .filter((run) => safeString(run.head_sha).toLowerCase() === mergeSha)
    .filter((run) => safeString(run.name) === workflowName)
    .sort((left, right) => {
      const leftMs = Date.parse(safeString(left.created_at) || "1970-01-01T00:00:00.000Z");
      const rightMs = Date.parse(safeString(right.created_at) || "1970-01-01T00:00:00.000Z");
      return rightMs - leftMs;
    });
  return filtered[0] || null;
}

function summarizeFailedJobs(jobsPayload) {
  const jobs = getJobs(jobsPayload);
  const failed = [];
  for (const job of jobs) {
    const conclusion = safeString(job.conclusion);
    if (!["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(conclusion)) {
      continue;
    }
    const failedSteps = Array.isArray(job.steps)
      ? job.steps
        .filter((step) => ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(safeString(step.conclusion)))
        .map((step) => safeString(step.name))
        .filter(Boolean)
      : [];

    failed.push({
      jobName: safeString(job.name),
      conclusion,
      failedSteps
    });
  }
  return failed;
}

function classifyHistoricalFailure(runs, historicalRunId, latestMergeRun) {
  const historical = runs.find((run) => String(run.id) === String(historicalRunId)) || null;
  if (!historical) {
    return {
      classification: "UNKNOWN",
      reason: "Historical run not found in fetched run set",
      historicalRun: null
    };
  }

  const conclusion = safeString(historical.conclusion);
  if (conclusion === "success") {
    return {
      classification: "NON_BLOCKING",
      reason: "Historical run concluded successfully",
      historicalRun: historical
    };
  }

  const latestIsGreen = latestMergeRun && safeString(latestMergeRun.conclusion) === "success";
  const historicalSha = safeString(historical.head_sha).toLowerCase();
  const mergeSha = latestMergeRun ? safeString(latestMergeRun.head_sha).toLowerCase() : "";

  if (latestIsGreen && mergeSha && mergeSha !== historicalSha) {
    return {
      classification: "EXPECTED_SUPERSEDED",
      reason: "Historical failure is superseded by newer green merge-SHA run",
      historicalRun: historical
    };
  }

  return {
    classification: "UNEXPECTED_BLOCKING",
    reason: "Historical failure is not superseded by newer green merge-SHA run",
    historicalRun: historical
  };
}

function evaluateCiHealth(input = {}) {
  const mergeSha = safeString(input.mergeSha).toLowerCase();
  const workflowName = safeString(input.workflowName) || "phase2-security";
  const runs = getRuns(input.runsPayload);

  const latestMergeRun = findLatestRunForMergeSha(runs, mergeSha, workflowName);
  if (!latestMergeRun) {
    return {
      ok: false,
      verdict: "UNEXPECTED_BLOCKING",
      message: "No phase2-security run found for merge SHA",
      latestMergeRun: null,
      failedJobs: []
    };
  }

  const failedJobs = summarizeFailedJobs(input.jobsPayload || []);
  const mergeConclusion = safeString(latestMergeRun.conclusion);
  const mergeRunBlocking = mergeConclusion !== "success";

  const historical = classifyHistoricalFailure(runs, input.historicalRunId, latestMergeRun);
  const historicalBlocking = historical.classification === "UNEXPECTED_BLOCKING";

  const ok = !mergeRunBlocking && !historicalBlocking;

  return {
    ok,
    verdict: ok ? "PASS" : "UNEXPECTED_BLOCKING",
    message: ok ? "CI merge-SHA health is green" : "CI merge-SHA health is blocking",
    latestMergeRun: {
      workflowName: safeString(latestMergeRun.name),
      runId: Number(latestMergeRun.id),
      conclusion: mergeConclusion,
      headSha: safeString(latestMergeRun.head_sha).toLowerCase(),
      htmlUrl: safeString(latestMergeRun.html_url)
    },
    failedJobs,
    historical
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.mergeSha) {
    fail("--merge-sha is required");
  }

  let runsPayload;
  let jobsPayload = [];

  if (options.fixtureRuns) {
    runsPayload = await readJsonFile(options.fixtureRuns);
    if (options.fixtureJobs) {
      jobsPayload = await readJsonFile(options.fixtureJobs);
    }
  } else {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
    const runsUrl = `https://api.github.com/repos/${options.repo}/actions/runs?per_page=100`;
    runsPayload = await requestJson(runsUrl, token);

    const runs = getRuns(runsPayload);
    const latestMergeRun = findLatestRunForMergeSha(runs, options.mergeSha, options.workflowName);
    if (latestMergeRun) {
      const jobsUrl = `https://api.github.com/repos/${options.repo}/actions/runs/${latestMergeRun.id}/jobs?per_page=100`;
      jobsPayload = await requestJson(jobsUrl, token);
    }
  }

  const result = evaluateCiHealth({
    runsPayload,
    jobsPayload,
    mergeSha: options.mergeSha,
    workflowName: options.workflowName,
    historicalRunId: options.historicalRunId
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (!result.ok) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  getRuns,
  getJobs,
  findLatestRunForMergeSha,
  summarizeFailedJobs,
  classifyHistoricalFailure,
  evaluateCiHealth
};
