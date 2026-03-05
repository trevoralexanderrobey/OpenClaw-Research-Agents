#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createApiGovernance } = require("../security/api-governance.js");
const { createOperatorAuthorization } = require("../security/operator-authorization.js");
const { getLegacyAccessBridge } = require("../workflows/access-control/legacy-access-bridge.js");

function parseArgs(argv) {
  const out = {
    approvalToken: "",
    remediationRequest: "",
    confirm: false,
    operatorId: process.env.OPERATOR_ID || "operator-cli"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--approval-token") {
      out.approvalToken = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--remediation-request") {
      out.remediationRequest = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--confirm") {
      out.confirm = true;
      continue;
    }
    if (token === "--operator-id") {
      out.operatorId = String(argv[index + 1] || "").trim() || out.operatorId;
      index += 1;
      continue;
    }
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/apply-remediation-delta.js \\",
    "    --approval-token <token> \\",
    "    --remediation-request <path/to/remediation-request.json> \\",
    "    --confirm"
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function toSafeInsertion(targetFile, clauseText) {
  const ext = path.extname(targetFile).toLowerCase();
  if (ext === ".json") {
    throw new Error(`restore_contract_clause is not supported for JSON file ${targetFile}; use replace_text`);
  }
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs" || ext === ".ts") {
    return `// ${clauseText}`;
  }
  if (ext === ".sh" || ext === ".yml" || ext === ".yaml" || ext === ".toml" || ext === ".py" || ext === ".rb") {
    return `# ${clauseText}`;
  }
  return clauseText;
}

function applyEdit(rootDir, edit) {
  const type = String(edit && edit.type || "").trim();
  const targetFile = path.resolve(rootDir, String(edit && (edit.target_file || edit.file) || "").trim());
  if (!targetFile.startsWith(rootDir)) {
    throw new Error(`Refusing to edit file outside repository root: ${targetFile}`);
  }
  const source = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf8") : "";

  if (type === "replace_text") {
    const find = String(edit.find || "");
    const replace = String(edit.replace || "");
    if (!find) {
      throw new Error(`replace_text missing 'find' for ${targetFile}`);
    }
    if (!source.includes(find)) {
      throw new Error(`replace_text could not find target text in ${targetFile}`);
    }
    const updated = source.replace(find, replace);
    writeText(targetFile, updated);
    return targetFile;
  }

  if (type === "restore_contract_clause") {
    const clauseText = String(edit.required_text || edit.violation_clause || edit.patch_hint || "").trim();
    if (!clauseText) {
      throw new Error(`restore_contract_clause requires required_text, violation_clause, or patch_hint for ${targetFile}`);
    }
    if (source.includes(clauseText)) {
      return "";
    }
    const insertion = toSafeInsertion(targetFile, clauseText);
    const separator = source.endsWith("\n") || source.length === 0 ? "" : "\n";
    const updated = `${source}${separator}${insertion}\n`;
    writeText(targetFile, updated);
    return targetFile;
  }

  if (type === "ensure_contains") {
    const requiredText = String(edit.required_text || "").trim();
    if (!requiredText) {
      throw new Error(`ensure_contains missing 'required_text' for ${targetFile}`);
    }
    if (source.includes(requiredText)) {
      return "";
    }
    const separator = source.endsWith("\n") || source.length === 0 ? "" : "\n";
    const updated = `${source}${separator}${requiredText}\n`;
    writeText(targetFile, updated);
    return targetFile;
  }

  throw new Error(`Unsupported remediation edit type: ${type}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.approvalToken || !args.remediationRequest || !args.confirm) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }

  const rootDir = process.cwd();
  const requestPath = path.resolve(args.remediationRequest);
  const request = readJson(requestPath);

  if (!request || typeof request !== "object") {
    throw new Error("remediation request must be a JSON object");
  }
  if (request.operator_approval_token_required !== true) {
    throw new Error("remediation request missing operator approval requirement");
  }

  const apiGovernance = createApiGovernance();
  const operatorAuthorization = createOperatorAuthorization();
  const legacyAccessBridge = getLegacyAccessBridge();

  const changedFiles = new Set();
  await apiGovernance.withGovernanceTransaction(async () => {
    const legacyAccess = legacyAccessBridge.evaluateLegacyAccess({
      approvalToken: args.approvalToken,
      scope: "governance.remediation.apply",
      role: "",
      action: "legacy.execute",
      resource: "governance.remediation",
      caller: "legacy.script.apply_remediation",
      correlationId: "phase9-remediation-apply"
    });
    if (!legacyAccess.allowed) {
      throw new Error(`Phase 13 boundary denied remediation apply access: ${legacyAccess.reason}`);
    }
    operatorAuthorization.consumeApprovalToken(args.approvalToken, "governance.remediation.apply", {
      correlationId: "phase9-remediation-apply"
    });

    const recommendations = Array.isArray(request.recommendations) ? request.recommendations : [];
    for (const recommendation of recommendations) {
      const edits = Array.isArray(recommendation.recommended_edits) ? recommendation.recommended_edits : [];
      for (const edit of edits) {
        const changed = applyEdit(rootDir, edit);
        if (changed) {
          changedFiles.add(path.relative(rootDir, changed).split(path.sep).join("/"));
        }
      }
    }

    return { ok: true };
  }, { correlationId: "phase9-remediation-apply" });

  const verification = spawnSync("bash", ["scripts/verify-phase9-policy.sh"], {
    cwd: rootDir,
    encoding: "utf8"
  });
  if (verification.status !== 0) {
    throw new Error(`Phase 9 policy verification failed after remediation:\n${verification.stderr || verification.stdout}`);
  }

  const logPath = path.join(rootDir, "audit", "evidence", "governance-automation", "remediation-application-log.json");
  const log = {
    remediation_request: requestPath,
    changed_files: [...changedFiles].sort((left, right) => left.localeCompare(right)),
    verification: {
      command: "bash scripts/verify-phase9-policy.sh",
      status: verification.status
    }
  };

  writeText(logPath, `${JSON.stringify(log, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, changed_files: log.changed_files, log_path: logPath }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
