"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const {
  attachEvidenceEventHashes,
  attachExportEventHashes,
  createEmptyEvidenceLedgerStore,
  createEmptyExportEventsStore,
  validateEvidenceLedgerStore,
  validateExportEventsStore
} = require(path.join(root, "openclaw-bridge", "monetization", "delivery-evidence-schema.js"));

test("phase28 export store validates chain-hashed bundle_exported event", () => {
  const event = attachExportEventHashes({
    event_type: "bundle_exported",
    offer_id: "offer-phase28-schema",
    approved_bundle_hash: "a".repeat(64),
    exported_at: "2026-03-15T00:00:00.000Z",
    export_format: "zip",
    operator_id: "operator-1",
    exported_delivery_targets: ["manual_secure_transfer"],
    export_artifact_refs: [
      {
        path: "workspace/releases/offer-phase28-schema-export.zip",
        file_type: ".zip",
        byte_size: 123,
        sha256: "b".repeat(64)
      }
    ]
  }, 1, "0".repeat(64));

  const store = {
    ...createEmptyExportEventsStore(),
    next_sequence: 1,
    chain_head: event.event_hash,
    events: [event]
  };

  const validated = validateExportEventsStore(store);
  assert.equal(validated.events.length, 1);
  assert.equal(validated.events[0].event_type, "bundle_exported");
});

test("phase28 export store fails closed on event hash tamper", () => {
  const event = attachExportEventHashes({
    event_type: "bundle_exported",
    offer_id: "offer-phase28-schema",
    approved_bundle_hash: "a".repeat(64),
    exported_at: "2026-03-15T00:00:00.000Z",
    export_format: "folder",
    operator_id: "operator-1",
    exported_delivery_targets: ["manual_secure_transfer"],
    export_artifact_refs: [
      {
        path: "workspace/releases/offer-phase28-schema-export",
        file_type: "folder",
        byte_size: 0,
        sha256: "c".repeat(64)
      }
    ]
  }, 1, "0".repeat(64));

  const tampered = {
    ...event,
    event_hash: "d".repeat(64)
  };

  const store = {
    ...createEmptyExportEventsStore(),
    next_sequence: 1,
    chain_head: tampered.event_hash,
    events: [tampered]
  };

  assert.throws(() => validateExportEventsStore(store), (error) => {
    assert.equal(error.code, "PHASE28_EXPORT_EVENT_HASH_MISMATCH");
    return true;
  });
});

test("phase28 evidence store validates evidence ref metadata and state transition fields", () => {
  const event = attachEvidenceEventHashes({
    recorded_at: "2026-03-15T00:00:00.000Z",
    event_type: "delivery_outcome_recorded",
    offer_id: "offer-phase28-schema",
    delivery_target: "manual_secure_transfer",
    operator_id: "operator-1",
    state_transition: {
      from: "ready_for_manual_delivery",
      to: "delivery_in_progress"
    },
    approved_bundle_hash: "a".repeat(64),
    external_ref: "ticket-123",
    notes: "manual handoff started",
    evidence_refs: [
      {
        stored_path: "delivery-evidence/manual_secure_transfer/evidence/1-1-aaaaaaaaaaaaaaaa.png",
        original_filename: "proof.png",
        sha256: "e".repeat(64),
        byte_size: 512,
        file_type: ".png"
      }
    ],
    idempotency_key: "idem-1"
  }, 1, "0".repeat(64));

  const store = {
    ...createEmptyEvidenceLedgerStore(),
    next_sequence: 1,
    chain_head: event.event_hash,
    events: [event]
  };

  const validated = validateEvidenceLedgerStore(store);
  assert.equal(validated.events.length, 1);
  assert.equal(validated.events[0].state_transition.to, "delivery_in_progress");
});

test("phase28 evidence store enforces non-empty payload rule", () => {
  assert.throws(() => attachEvidenceEventHashes({
    recorded_at: "2026-03-15T00:00:00.000Z",
    event_type: "delivery_outcome_recorded",
    offer_id: "offer-phase28-schema",
    delivery_target: "manual_secure_transfer",
    operator_id: "operator-1",
    state_transition: {
      from: "ready_for_manual_delivery",
      to: "withdrawn"
    },
    approved_bundle_hash: "a".repeat(64),
    external_ref: "",
    notes: "",
    evidence_refs: [],
    idempotency_key: "idem-empty"
  }, 1, "0".repeat(64)), (error) => {
    assert.equal(error.code, "PHASE28_EVIDENCE_PAYLOAD_EMPTY");
    return true;
  });
});
