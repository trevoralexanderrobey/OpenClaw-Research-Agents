"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createSiderHandoffManager } = require("../openclaw-bridge/bridge/sider-handoff-manager.js");

function parseArgs(argv) {
  const out = {
    exchangeId: "",
    operatorId: "",
    sourceTaskIds: [],
    briefFile: "",
    briefText: "",
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
    if (arg === "--source-task-id") {
      const value = String(argv[i + 1] || "").trim();
      if (value) out.sourceTaskIds.push(value);
      i += 1;
      continue;
    }
    if (arg === "--source-task-ids") {
      const raw = String(argv[i + 1] || "").trim();
      out.sourceTaskIds.push(...raw.split(",").map((entry) => entry.trim()).filter(Boolean));
      i += 1;
      continue;
    }
    if (arg === "--brief-file") {
      out.briefFile = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--brief-text") {
      out.briefText = String(argv[i + 1] || "");
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
    "  node scripts/export-sider-brief.js --exchange-id <id> --operator-id <id> --confirm [options]",
    "",
    "Options:",
    "  --source-task-id <taskId>      Repeatable source task reference",
    "  --source-task-ids <csv>        Comma-separated source task references",
    "  --brief-file <path>            Markdown input file",
    "  --brief-text <text>            Markdown input text",
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

  let briefText = args.briefText;
  if (!briefText && args.briefFile) {
    const filePath = path.resolve(process.cwd(), args.briefFile);
    briefText = fs.readFileSync(filePath, "utf8");
  }
  if (!briefText) {
    throw new Error("Provide --brief-file or --brief-text");
  }

  const manager = createSiderHandoffManager({ rootDir: process.cwd() });
  const result = await manager.exportBrief({
    exchange_id: args.exchangeId,
    operator_id: args.operatorId,
    source_task_ids: args.sourceTaskIds,
    brief_markdown: briefText
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
});
