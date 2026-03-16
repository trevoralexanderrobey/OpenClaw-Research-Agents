"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createSiderHandoffManager } = require("../openclaw-bridge/bridge/sider-handoff-manager.js");

function parseArgs(argv) {
  const out = {
    exchangeId: "",
    operatorId: "",
    taskReferenceId: "",
    sourceExportHash: "",
    responseFile: "",
    responseText: "",
    confirm: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || "").trim();
    if (arg === "--exchange-id") {
      out.exchangeId = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--operator-id") {
      out.operatorId = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--task-reference-id") {
      out.taskReferenceId = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--source-export-hash") {
      out.sourceExportHash = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--response-file") {
      out.responseFile = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--response-text") {
      out.responseText = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--confirm") {
      out.confirm = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/import-sider-response.js --exchange-id <id> --operator-id <id> --task-reference-id <id> --confirm [options]",
    "",
    "Options:",
    "  --source-export-hash <sha256>  Optional explicit export hash assertion",
    "  --response-file <path>         Approved response markdown file",
    "  --response-text <text>         Approved response markdown text",
    "  --confirm                      Required explicit operator confirmation",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.confirm) {
    throw new Error("Missing --confirm");
  }
  if (!args.exchangeId) {
    throw new Error("Missing --exchange-id");
  }
  if (!args.operatorId) {
    throw new Error("Missing --operator-id");
  }
  if (!args.taskReferenceId) {
    throw new Error("Missing --task-reference-id");
  }

  let responseText = args.responseText;
  if (!responseText && args.responseFile) {
    const filePath = path.resolve(process.cwd(), args.responseFile);
    responseText = fs.readFileSync(filePath, "utf8");
  }
  if (!responseText) {
    throw new Error("Provide --response-file or --response-text");
  }

  const manager = createSiderHandoffManager({ rootDir: process.cwd() });
  const result = await manager.importApprovedResponse({
    exchange_id: args.exchangeId,
    operator_id: args.operatorId,
    task_reference_id: args.taskReferenceId,
    source_export_hash: args.sourceExportHash,
    approved_response_markdown: responseText
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
});
