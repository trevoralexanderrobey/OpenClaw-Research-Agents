"use strict";

const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");
const {
  DELIVERY_STATES,
  TERMINAL_DELIVERY_STATES,
  sortUnique
} = require("./delivery-evidence-schema.js");

const READY_FOR_MANUAL_DELIVERY = "ready_for_manual_delivery";

const ALLOWED_TRANSITIONS = Object.freeze({
  ready_for_manual_delivery: Object.freeze(["delivery_in_progress", "withdrawn"]),
  delivery_in_progress: Object.freeze(["delivery_completed", "delivery_failed", "needs_redelivery", "withdrawn"]),
  delivery_failed: Object.freeze(["needs_redelivery", "withdrawn"]),
  needs_redelivery: Object.freeze(["delivery_in_progress", "withdrawn"]),
  delivery_completed: Object.freeze([]),
  withdrawn: Object.freeze([])
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isKnownState(state) {
  return DELIVERY_STATES.includes(safeString(state));
}

function isTerminalState(state) {
  return TERMINAL_DELIVERY_STATES.includes(safeString(state));
}

function assertValidTransition(fromState, toState) {
  const from = safeString(fromState);
  const to = safeString(toState);
  if (!isKnownState(from)) {
    const error = new Error(`Unknown from-state '${from || "(empty)"}'`);
    error.code = "PHASE28_STATE_FROM_UNKNOWN";
    throw error;
  }
  if (!isKnownState(to)) {
    const error = new Error(`Unknown to-state '${to || "(empty)"}'`);
    error.code = "PHASE28_STATE_TO_UNKNOWN";
    throw error;
  }
  if (isTerminalState(from)) {
    const error = new Error(`Cannot transition from terminal state '${from}'`);
    error.code = "PHASE28_STATE_TERMINAL";
    throw error;
  }
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    const error = new Error(`Invalid state transition '${from}' -> '${to}'`);
    error.code = "PHASE28_STATE_TRANSITION_INVALID";
    throw error;
  }
  return canonicalize({ from, to });
}

function getExportCoverageForTarget(exportEventsStore, deliveryTarget) {
  const target = safeString(deliveryTarget);
  if (!target) {
    const error = new Error("delivery_target is required");
    error.code = "PHASE28_DELIVERY_TARGET_REQUIRED";
    throw error;
  }
  const events = asArray(exportEventsStore && exportEventsStore.events)
    .filter((event) => event && event.event_type === "bundle_exported")
    .filter((event) => asArray(event.exported_delivery_targets).includes(target));
  return events;
}

function deriveCurrentStateForTarget(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const target = safeString(source.delivery_target);
  if (!target) {
    const error = new Error("delivery_target is required");
    error.code = "PHASE28_DELIVERY_TARGET_REQUIRED";
    throw error;
  }

  const exportEvents = getExportCoverageForTarget(source.export_events_store, target);
  const eligible = exportEvents.length > 0;

  if (!eligible) {
    return canonicalize({
      eligible: false,
      delivery_target: target,
      current_state: "",
      initialized_by_export_sequence: 0,
      initialized_by_export_hash: "",
      latest_sequence: 0,
      latest_event_hash: "",
      evidence_event_count: 0
    });
  }

  let state = READY_FOR_MANUAL_DELIVERY;
  const initializedBy = exportEvents[0];

  const events = asArray(source.evidence_ledger_store && source.evidence_ledger_store.events)
    .filter((event) => safeString(event.delivery_target) === target)
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

  let latestSequence = 0;
  let latestEventHash = "";

  for (const event of events) {
    const transition = event && event.state_transition && typeof event.state_transition === "object"
      ? event.state_transition
      : {};
    const from = safeString(transition.from);
    const to = safeString(transition.to);

    if (from !== state) {
      const error = new Error(`State transition mismatch for target '${target}': expected from '${state}' got '${from || "(empty)"}'`);
      error.code = "PHASE28_STATE_TRANSITION_FROM_MISMATCH";
      throw error;
    }
    assertValidTransition(from, to);
    state = to;
    latestSequence = Number(event.sequence || 0);
    latestEventHash = safeString(event.event_hash);
  }

  return canonicalize({
    eligible: true,
    delivery_target: target,
    current_state: state,
    initialized_by_export_sequence: Number(initializedBy.sequence || 0),
    initialized_by_export_hash: safeString(initializedBy.event_hash),
    latest_sequence: latestSequence,
    latest_event_hash: latestEventHash,
    evidence_event_count: events.length
  });
}

function deriveStatesForTargets(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const configuredTargets = sortUnique(asArray(source.delivery_targets).map((entry) => safeString(entry)).filter(Boolean));

  const allTargets = sortUnique([
    ...configuredTargets,
    ...asArray(source.export_events_store && source.export_events_store.events)
      .flatMap((event) => asArray(event.exported_delivery_targets).map((entry) => safeString(entry))),
    ...asArray(source.evidence_ledger_store && source.evidence_ledger_store.events)
      .map((event) => safeString(event.delivery_target))
  ].filter(Boolean));

  return canonicalize(allTargets.map((deliveryTarget) => deriveCurrentStateForTarget({
    delivery_target: deliveryTarget,
    export_events_store: source.export_events_store,
    evidence_ledger_store: source.evidence_ledger_store
  })));
}

module.exports = {
  ALLOWED_TRANSITIONS,
  READY_FOR_MANUAL_DELIVERY,
  assertValidTransition,
  deriveCurrentStateForTarget,
  deriveStatesForTargets,
  getExportCoverageForTarget,
  isTerminalState
};
