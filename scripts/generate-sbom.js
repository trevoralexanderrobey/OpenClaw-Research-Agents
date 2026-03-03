#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const pkgPath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const outPath = path.join(root, "audit", "evidence", "phase2", "sbom.cyclonedx.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function componentFromLockEntry(name, entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  if (!entry.version || typeof entry.version !== "string") {
    return null;
  }

  const purlName = encodeURIComponent(String(name).replace(/^node_modules\//, ""));
  const version = entry.version.trim();
  const component = {
    type: "library",
    name: String(name).replace(/^node_modules\//, ""),
    version,
    purl: `pkg:npm/${purlName}@${encodeURIComponent(version)}`,
  };

  if (entry.integrity && typeof entry.integrity === "string") {
    component.hashes = [{ alg: "SHA-512", content: entry.integrity.replace(/^sha512-/, "") }];
  }

  return component;
}

function buildSbom(pkg, lock) {
  const packages = lock && lock.packages && typeof lock.packages === "object" ? lock.packages : {};
  const components = [];

  for (const [name, entry] of Object.entries(packages)) {
    if (!name || name === "") {
      continue;
    }
    const component = componentFromLockEntry(name, entry);
    if (component) {
      components.push(component);
    }
  }

  components.sort((a, b) => {
    if (a.name !== b.name) {
      return a.name.localeCompare(b.name);
    }
    return a.version.localeCompare(b.version);
  });

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:00000000-0000-0000-0000-000000000002",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: "application",
        name: pkg.name,
        version: pkg.version,
      },
      tools: [{
        vendor: "OpenClaw",
        name: "generate-sbom.js",
        version: "2.0.0",
      }],
    },
    components,
  };
}

function main() {
  if (!fs.existsSync(pkgPath)) {
    throw new Error("package.json not found");
  }
  if (!fs.existsSync(lockPath)) {
    throw new Error("package-lock.json not found");
  }

  const pkg = readJson(pkgPath);
  const lock = readJson(lockPath);
  const sbom = buildSbom(pkg, lock);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  process.stdout.write(`SBOM written to ${outPath}\n`);
}

main();
