"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BUILTIN_TOOL_IMAGES,
  calculateToolRegistryChecksum,
  assertRegistryChecksumLocked,
} = require("../../openclaw-bridge/execution/tool-image-catalog.js");

test("registry checksum lock validates baseline catalog", () => {
  const lockPath = path.join(process.cwd(), "security", "tool-registry.lock.json");
  assert.doesNotThrow(() => assertRegistryChecksumLocked(lockPath));

  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(lock.registrySha256, calculateToolRegistryChecksum(BUILTIN_TOOL_IMAGES));
});

test("registry tamper attempt is detected", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-registry-lock-"));
  const badLockPath = path.join(tempDir, "tool-registry.lock.json");
  fs.writeFileSync(
    badLockPath,
    JSON.stringify({ schemaVersion: 1, registrySha256: "deadbeef" }, null, 2) + "\n",
    "utf8"
  );

  assert.throws(() => assertRegistryChecksumLocked(badLockPath), (error) => error && error.code === "TOOL_REGISTRY_MUTATION_DETECTED");
});
