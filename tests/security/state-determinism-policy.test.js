"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const { createPersistentStore } = require("../../openclaw-bridge/state/persistent-store.js");
const { createStateManager } = require("../../openclaw-bridge/state/state-manager.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase2-state-"));
}

test("persistent store writes canonical sorted-key JSON", async () => {
  const dir = await makeTmpDir();
  const storePath = path.join(dir, "control-plane-state.json");
  const store = createPersistentStore({ path: storePath, debounceMs: 1 });

  store.scheduleWrite({
    payload: {
      z: 1,
      a: 2,
      nested: {
        c: 3,
        b: 4,
      },
    },
    version: 2,
    persistedAt: 1,
    reason: "test",
  });
  const result = await store.flush();
  assert.equal(result.ok, true);

  const content = fs.readFileSync(storePath, "utf8");
  assert.ok(content.indexOf('"a"') < content.indexOf('"z"'));
  assert.ok(content.indexOf('"b"') < content.indexOf('"c"'));
});

test("invalid state JSON is rejected as corrupted", async () => {
  const dir = await makeTmpDir();
  const storePath = path.join(dir, "control-plane-state.json");
  fs.writeFileSync(storePath, "{bad json", "utf8");

  const store = createPersistentStore({ path: storePath });
  const loaded = await store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, "STATE_FILE_CORRUPTED");
});

test("schema downgrade attempt is rejected", async () => {
  const dir = await makeTmpDir();
  const storePath = path.join(dir, "control-plane-state.json");
  fs.writeFileSync(
    storePath,
    JSON.stringify({ version: 1, persistedAt: 1, reason: "test", payload: {} }, null, 2) + "\n",
    "utf8"
  );

  const manager = createStateManager({
    version: 2,
    path: storePath,
  });

  const initialized = await manager.initialize();
  assert.equal(initialized.loaded, false);
  assert.equal(initialized.reason, "VERSION_DOWNGRADE_REQUIRED");
});
