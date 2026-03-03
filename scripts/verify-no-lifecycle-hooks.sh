#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node - "$ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
const pkgPath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const lifecycle = new Set(["preinstall", "install", "postinstall", "prepare"]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(pkgPath)) {
  fail("package.json missing");
}
if (!fs.existsSync(lockPath)) {
  fail("package-lock.json missing");
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

const rootScripts = pkg && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
for (const key of Object.keys(rootScripts)) {
  if (lifecycle.has(key)) {
    fail(`Lifecycle hook '${key}' is forbidden in package.json scripts`);
  }
}

const offenders = [];
const packages = lock && lock.packages && typeof lock.packages === "object" ? lock.packages : {};
for (const [key, value] of Object.entries(packages)) {
  if (!key || key === "") {
    continue;
  }
  if (value && value.hasInstallScript === true) {
    offenders.push(key);
  }
}

if (offenders.length > 0) {
  fail(`Dependencies with install scripts are forbidden: ${offenders.sort().join(", ")}`);
}

process.stdout.write("Lifecycle hook policy check passed\n");
NODE
