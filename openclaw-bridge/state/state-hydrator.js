"use strict";

const { loadRuntimeState } = require("./persistent-store.js");
const { canonicalize } = require("../../workflows/governance-automation/common.js");

function createStateHydrator(options = {}) {
  const statePath = options.path || "state/runtime/state.json";

  async function hydrateFromPersistentState() {
    try {
      const loaded = await loadRuntimeState({ path: statePath });
      if (!loaded || !loaded.state) {
        return canonicalize({ ok: true, hydrated: false, state: null, reason: "STATE_EMPTY" });
      }
      return canonicalize({ ok: true, hydrated: true, state: loaded.state, path: loaded.path });
    } catch (error) {
      return canonicalize({
        ok: false,
        hydrated: false,
        state: null,
        reason: error && error.code ? error.code : "STATE_LOAD_FAILED"
      });
    }
  }

  async function buildResumePlan() {
    const hydrated = await hydrateFromPersistentState();
    const state = hydrated && hydrated.state && typeof hydrated.state === "object" ? hydrated.state : {};
    const openLoops = Array.isArray(state.openLoops) ? state.openLoops : [];
    return canonicalize({
      ok: hydrated.ok !== false,
      open_loop_count: openLoops.length,
      actions: openLoops
        .slice()
        .sort((left, right) => String(left.loopId || "").localeCompare(String(right.loopId || "")))
        .map((loop) => ({
          action: "requeue",
          loop_id: String(loop.loopId || ""),
          session_id: String(loop.sessionId || "default")
        }))
    });
  }

  return Object.freeze({
    hydrateFromPersistentState,
    buildResumePlan
  });
}

module.exports = {
  createStateHydrator
};
