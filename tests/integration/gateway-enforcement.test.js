"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { loadRuntimeConfig, clearRuntimeConfigCacheForTests } = require("../../openclaw-bridge/core/runtime-config.js");

test("gateway config is fixed to localhost:18789", () => {
  const configPath = path.join(root, "openclaw-bridge", "openclaw.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(config.gateway.host, "127.0.0.1");
  assert.equal(config.gateway.port, 18789);
  assert.equal(config.gateway.allowDynamicPort, false);
  assert.equal(config.gateway.allowNonLocalhostBind, false);
});

test("runtime config mutation attempt throws immutable violation", () => {
  clearRuntimeConfigCacheForTests();
  const config = loadRuntimeConfig(root);

  assert.throws(() => {
    config.gateway.port = 9999;
  }, /CONFIG_IMMUTABLE_VIOLATION|immutable/i);
});

test("dynamic port override is rejected", () => {
  clearRuntimeConfigCacheForTests();
  process.env.BRIDGE_PORT = "9999";
  try {
    assert.throws(() => loadRuntimeConfig(root), (error) => error && error.code === "CONFIG_IMMUTABLE_VIOLATION");
  } finally {
    delete process.env.BRIDGE_PORT;
    clearRuntimeConfigCacheForTests();
  }
});

test("non-localhost bind override is rejected", () => {
  clearRuntimeConfigCacheForTests();
  process.env.OPENCLAW_BIND_HOST = "0.0.0.0";
  try {
    assert.throws(() => loadRuntimeConfig(root), (error) => error && error.code === "CONFIG_IMMUTABLE_VIOLATION");
  } finally {
    delete process.env.OPENCLAW_BIND_HOST;
    clearRuntimeConfigCacheForTests();
  }
});
