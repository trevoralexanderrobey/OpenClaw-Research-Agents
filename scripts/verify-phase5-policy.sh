#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW_DIR="$ROOT/workflows"
GEN_DIR="$ROOT/workflows/rlhf-generator"
REVIEW_FILE="$ROOT/workflows/rlhf-review.js"
STYLE_FILE="$ROOT/STYLE.md"
EGRESS_FILE="$ROOT/openclaw-bridge/execution/egress-policy.js"

fail() {
  echo "$1" >&2
  exit 1
}

[[ -d "$WORKFLOW_DIR" ]] || fail "Missing workflows directory"
[[ -d "$GEN_DIR" ]] || fail "Missing workflows/rlhf-generator directory"
[[ -f "$REVIEW_FILE" ]] || fail "Missing workflows/rlhf-review.js"
[[ -f "$STYLE_FILE" ]] || fail "Missing STYLE.md"

for f in \
  "$GEN_DIR/pipeline-runner.js" \
  "$GEN_DIR/candidate-selector.js" \
  "$GEN_DIR/complexity-analyzer.js" \
  "$GEN_DIR/rlhf-generator.js" \
  "$GEN_DIR/rubric-builder.js" \
  "$GEN_DIR/formatting-engine.js" \
  "$GEN_DIR/compliance-linter.js" \
  "$GEN_DIR/manual-package-builder.js" \
  "$GEN_DIR/rlhf-schema.js"; do
  [[ -f "$f" ]] || fail "Missing Phase 5 workflow module: $f"
done

NETWORK_HITS="$(rg -n --glob '*.js' "fetch\(|axios|https\.request\(|http\.request\(|node:https|node:http|playwright|puppeteer|selenium|webdriver|browser\.launch" "$WORKFLOW_DIR" || true)"
if [[ -n "$NETWORK_HITS" ]]; then
  echo "$NETWORK_HITS" >&2
  fail "Phase 5 workflows must not include network/browser automation clients"
fi

node - "$WORKFLOW_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const workflowDir = process.argv[2];
const bannedModuleMatchers = [
  "node:http",
  "http",
  "node:https",
  "https",
  "axios",
  "undici",
  "node-fetch",
  "cross-fetch",
  "playwright",
  "playwright-core",
  "@playwright/test",
  "puppeteer",
  "puppeteer-core",
  "selenium-webdriver",
  "webdriverio",
  "wd",
  "cypress"
];

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out.sort();
}

function isBanned(specifier) {
  const value = String(specifier || "").trim().toLowerCase();
  return bannedModuleMatchers.some((needle) => value === needle || value.startsWith(`${needle}/`));
}

function collectImports(source) {
  const imports = new Set();
  const patterns = [
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /import\s+(?:.+?\s+from\s+)?["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      imports.add(match[1]);
    }
  }
  return [...imports];
}

const hits = [];
for (const filePath of listJsFiles(workflowDir)) {
  const source = fs.readFileSync(filePath, "utf8");
  for (const specifier of collectImports(source)) {
    if (isBanned(specifier)) {
      hits.push(`${filePath}: banned import '${specifier}'`);
    }
  }
}

if (hits.length > 0) {
  process.stderr.write(`${hits.join("\n")}\n`);
  process.exit(1);
}
NODE

HTTPS_LITERAL_HITS="$(rg -n --glob '*.js' "https?://" "$WORKFLOW_DIR" || true)"
if [[ -n "$HTTPS_LITERAL_HITS" ]]; then
  echo "$HTTPS_LITERAL_HITS" >&2
  fail "Phase 5 workflows must not contain hardcoded external endpoints"
fi

AUTONOMY_HITS="$(rg -n --pcre2 --glob '*.js' "\\b(autoSubmit|autonomousSubmit|submitToPlatform|loginAutomation|browserAutomation|credentialStore|storeCredentials|platformApiToken)\\b\\s*[(:=]" "$WORKFLOW_DIR" || true)"
if [[ -n "$AUTONOMY_HITS" ]]; then
  echo "$AUTONOMY_HITS" >&2
  fail "Phase 5 workflows must not include auto-submission or login automation logic"
fi

if ! rg -q "role === \"supervisor\"" "$REVIEW_FILE"; then
  fail "rlhf-review.js missing explicit supervisor boundary check"
fi
if ! rg -q "RLHF_REVIEW_ROLE_DENIED" "$REVIEW_FILE"; then
  fail "rlhf-review.js missing deny code for unauthorized status mutation"
fi
for scope in "rlhf.review.review" "rlhf.review.approve_manual_submission" "rlhf.review.archive"; do
  if ! rg -q "$scope" "$REVIEW_FILE"; then
    fail "rlhf-review.js missing explicit transition scope: $scope"
  fi
done

RESTRICTED_GLOBALS="$(rg -n "Date\.now\(|new Date\(|Math\.random\(|randomUUID\(" "$WORKFLOW_DIR" || true)"
if [[ -n "$RESTRICTED_GLOBALS" ]]; then
  echo "$RESTRICTED_GLOBALS" >&2
  fail "Determinism violation: restricted globals found in Phase 5 workflows"
fi

for marker in \
  "AI-assistance disclosure" \
  "human-review-required" \
  "Structured reasoning" \
  "LaTeX-compatible" \
  "forbid concealment" \
  "forbid impersonation" \
  "forbid detection evasion" \
  "forbid masking synthetic origin"; do
  if ! rg -qi "$marker" "$STYLE_FILE"; then
    fail "STYLE.md missing required policy marker: $marker"
  fi
done

node - "$EGRESS_FILE" <<'NODE'
const policy = require(process.argv[2]);
const allowed = new Set(["api.semanticscholar.org", "export.arxiv.org", "api.beehiiv.com", "api.notion.com"]);
const seen = new Set();
for (const value of Object.values(policy.TOOL_EGRESS_POLICIES || {})) {
  if (!value || typeof value !== "object") continue;
  for (const host of Array.isArray(value.allowedHosts) ? value.allowedHosts : []) {
    const normalized = String(host || "").trim().toLowerCase();
    if (!normalized) continue;
    seen.add(normalized);
    if (!allowed.has(normalized)) {
      process.stderr.write(`Unexpected egress domain detected: ${normalized}\n`);
      process.exit(1);
    }
  }
}
if (JSON.stringify([...seen].sort()) !== JSON.stringify([...allowed].sort())) {
  process.stderr.write(`Egress allowlist set mismatch. seen=${JSON.stringify([...seen].sort())}\n`);
  process.exit(1);
}
NODE

node - "$ROOT/package-lock.json" "$ROOT/package.json" <<'NODE'
const fs = require("node:fs");

const lockPath = process.argv[2];
const packageJsonPath = process.argv[3];
const deny = new Set([
  "playwright",
  "playwright-core",
  "@playwright/test",
  "puppeteer",
  "puppeteer-core",
  "selenium-webdriver",
  "webdriverio",
  "wd",
  "cypress"
]);

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function deniedName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return deny.has(normalized);
}

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
  const map = pkg[section] && typeof pkg[section] === "object" ? pkg[section] : {};
  for (const name of Object.keys(map)) {
    if (deniedName(name)) {
      fail(`Denied browser automation dependency in package.json: ${name}`);
    }
  }
}

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const transitiveHits = new Set();

const packages = lock.packages && typeof lock.packages === "object" ? lock.packages : {};
for (const [key, value] of Object.entries(packages)) {
  const pkgName = value && typeof value === "object" && typeof value.name === "string"
    ? value.name
    : String(key || "").split("node_modules/").pop();
  if (deniedName(pkgName)) {
    transitiveHits.add(pkgName);
  }
}

const dependencies = lock.dependencies && typeof lock.dependencies === "object" ? lock.dependencies : {};
const stack = Object.entries(dependencies);
while (stack.length > 0) {
  const [name, meta] = stack.pop();
  if (deniedName(name)) {
    transitiveHits.add(name);
  }
  const children = meta && typeof meta === "object" && meta.dependencies && typeof meta.dependencies === "object"
    ? meta.dependencies
    : {};
  for (const child of Object.entries(children)) {
    stack.push(child);
  }
}

if (transitiveHits.size > 0) {
  fail(`Denied transitive browser automation dependencies detected: ${JSON.stringify([...transitiveHits].sort())}`);
}
NODE

echo "Phase 5 policy verification passed"
