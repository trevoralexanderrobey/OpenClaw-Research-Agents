#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeToolDeclaration(input) {
  return String(input || "").trim();
}

function collectDeclarations(root) {
  const declarations = [];

  const supervisorRegistryPath = path.join(root, "openclaw-bridge", "supervisor", "supervisor-registry.json");
  const supervisorRegistry = readJson(supervisorRegistryPath);
  for (const entry of Array.isArray(supervisorRegistry) ? supervisorRegistry : []) {
    declarations.push({
      file: supervisorRegistryPath,
      name: normalizeToolDeclaration(entry && entry.name)
    });
  }

  const methodRegistry = require(path.join(root, "openclaw-bridge", "bridge", "mcp-method-registry.js"));
  for (const name of methodRegistry.MCP_METHOD_ALLOWLIST || []) {
    declarations.push({
      file: path.join(root, "openclaw-bridge", "bridge", "mcp-method-registry.js"),
      name: normalizeToolDeclaration(name)
    });
  }
  for (const name of methodRegistry.MCP_OPERATOR_METHOD_ALLOWLIST || []) {
    declarations.push({
      file: path.join(root, "openclaw-bridge", "bridge", "mcp-method-registry.js"),
      name: normalizeToolDeclaration(name)
    });
  }

  const contractFiles = [
    path.join(root, "openclaw-bridge", "mcp", "semantic-scholar-mcp", "contract.json"),
    path.join(root, "openclaw-bridge", "mcp", "arxiv-scholar-mcp", "contract.json"),
    path.join(root, "openclaw-bridge", "mcp", "newsletter-publisher-mcp", "contract.json"),
    path.join(root, "openclaw-bridge", "mcp", "notion-sync-mcp", "contract.json")
  ];

  for (const contractFile of contractFiles) {
    const contract = readJson(contractFile);
    declarations.push({ file: contractFile, name: normalizeToolDeclaration(contract && contract.name) });
    const tools = Array.isArray(contract && contract.tools) ? contract.tools : [];
    for (const tool of tools) {
      if (tool && typeof tool === "object" && !Array.isArray(tool)) {
        declarations.push({ file: contractFile, name: normalizeToolDeclaration(tool.name) });
        continue;
      }
      declarations.push({ file: contractFile, name: normalizeToolDeclaration(tool) });
    }
  }

  const toolCatalog = require(path.join(root, "openclaw-bridge", "execution", "tool-image-catalog.js"));
  for (const slug of Object.keys(toolCatalog.BUILTIN_TOOL_IMAGES || {}).sort()) {
    declarations.push({
      file: path.join(root, "openclaw-bridge", "execution", "tool-image-catalog.js"),
      name: normalizeToolDeclaration(slug)
    });
  }

  return declarations;
}

function validateDeclarations(declarations) {
  const invalid = declarations
    .filter((entry) => !TOOL_NAME_PATTERN.test(entry.name))
    .sort((left, right) => `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`));
  return {
    invalid,
    validCount: declarations.length - invalid.length,
    totalCount: declarations.length
  };
}

function main() {
  const root = process.cwd();
  const declarations = collectDeclarations(root);
  const result = validateDeclarations(declarations);

  if (result.invalid.length > 0) {
    for (const entry of result.invalid) {
      process.stderr.write(`INVALID_TOOL_NAME file=${entry.file} name=${entry.name}\n`);
    }
    fail(`Tool name regex validation failed (${result.invalid.length} invalid declarations)`);
  }

  process.stdout.write(`Tool name regex validation passed (${result.validCount}/${result.totalCount})\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  TOOL_NAME_PATTERN,
  collectDeclarations,
  validateDeclarations
};
