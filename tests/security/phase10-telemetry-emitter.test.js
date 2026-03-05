"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createTelemetryEmitter } = require("../../workflows/observability/telemetry-emitter.js");

function createFixedTimeProvider() {
  return {
    nowIso() {
      return "2026-03-05T00:00:00.000Z";
    }
  };
}

test("phase10 telemetry emitter emits deterministic event shape", () => {
  const events = [];
  const emitter = createTelemetryEmitter({
    metricsExporter: {
      recordEvent(event) {
        events.push(event);
      }
    },
    timeProvider: createFixedTimeProvider()
  });

  emitter.emitComplianceEvent({
    actor: "system",
    scope: "phase9.compliance-monitor",
    result: "pass"
  });

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.timestamp, "2026-03-05T00:00:00.000Z");
  assert.equal(event.event_type, "compliance.scan");
  assert.equal(event.phase, "phase10");
  assert.equal(event.actor, "system");
  assert.equal(event.scope, "phase9.compliance-monitor");
  assert.equal(event.result, "pass");
});

test("phase10 telemetry emitter emits side-effect events without blocking", () => {
  const events = [];
  const emitter = createTelemetryEmitter({
    metricsExporter: {
      recordEvent(event) {
        events.push(event);
      }
    },
    timeProvider: createFixedTimeProvider()
  });

  emitter.emitDriftEvent({ severity: "critical" });
  emitter.emitRemediationEvent({});
  emitter.emitOverrideEvent({});
  emitter.emitIncidentEvent({});
  emitter.emitAttestationEvent({});

  assert.equal(events.length, 5);
  assert.deepEqual(
    events.map((entry) => entry.event_type),
    [
      "policy.drift",
      "remediation.requested",
      "override.recorded",
      "incident.created",
      "attestation.anchor.attempt"
    ]
  );
});

test("phase10 telemetry emitter does not throw when metrics side-effect fails", () => {
  const emitter = createTelemetryEmitter({
    metricsExporter: {
      recordEvent() {
        throw new Error("metrics failure");
      }
    },
    timeProvider: createFixedTimeProvider()
  });

  assert.doesNotThrow(() => emitter.emitComplianceEvent({}));
});
