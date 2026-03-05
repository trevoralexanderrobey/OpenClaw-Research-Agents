# Phase 10 Operational Resilience & Response

## Scope
Phase 10 extends Phase 9 governance automation with deterministic observability, advisory alerting, human-gated runbook execution, incident artifacts/escalation workflows, and optional operator-initiated external attestation anchoring.

Non-negotiable boundaries:
- Alerting is advisory-only.
- Runbook execution requires operator approval token and explicit confirmation.
- Incident workflows are notification-only (no auto-remediation).
- External attestation is blocked by default and requires explicit opt-in parameters.
- No autonomous login, browser automation, or dynamic egress expansion.

## Canonical Metrics Schema
Module: `workflows/observability/metrics-schema.js`

Canonical metric names:
- `compliance_scan_count` (counter)
- `compliance_scan_duration_ms` (histogram)
- `compliance_violations_total` (gauge)
- `policy_drift_incidents_total` (counter)
- `policy_drift_severity` (gauge, label: `severity`)
- `override_ledger_entry_count` (counter)
- `override_decision_latency_ms` (histogram)
- `remediation_request_count` (counter)
- `remediation_request_applied_count` (counter)
- `remediation_request_rejected_count` (counter)
- `runbook_execution_count` (counter)
- `runbook_approval_latency_ms` (histogram)
- `runbook_action_success_count` (counter)
- `runbook_action_failure_count` (counter)
- `incident_event_count` (counter)
- `incident_escalation_latency_ms` (histogram)
- `attestation_anchor_attempt_count` (counter)
- `attestation_anchor_success_count` (counter)
- `policy_gate_check_duration_ms` (histogram)
- `policy_gate_violations_detected` (counter)

Fixed histogram buckets:
- `[1,5,10,25,50,100,250,500,1000,2500,5000,10000,30000,60000,300000]`

## SLO Definitions and Alert Rules
Module: `workflows/observability/slo-alert-engine.js`

Default SLO thresholds:
- `compliance_scan_frequency`: target min 1 scan/24h, alert if gap > 48h.
- `compliance_violation_threshold`: max 0 violations in production.
- `policy_drift_critical_threshold`: max 0 critical drifts.
- `override_decision_latency_p99`: target < 5m, alert if p99 > 10m.
- `remediation_request_success_rate`: target > 95%, alert if < 90%.
- `incident_escalation_latency_p95`: target < 1m, alert if p95 > 2m.
- `runbook_action_success_rate`: target > 99%, alert if < 95%.

Alert payload contract:
- `severity`
- `metric`
- `threshold`
- `breach_duration`
- `operator_action_recommended`
- `advisory_only: true`
- `auto_remediation_blocked: true`

## Telemetry and Alert Routing Workflow
Modules:
- `workflows/observability/telemetry-emitter.js`
- `workflows/observability/alert-router.js`

Event shape:
- `timestamp`
- `event_type`
- `phase`
- `actor`
- `scope`
- `result`

Supported operator channels:
- `cline`
- `email`
- `webhook`
- `slack`
- `pager`

Acknowledgment flow:
1. Alert routed to operator-configured channels.
2. Operator acknowledges via `recordAlertAcknowledgment`.
3. Acknowledgment is written to operational decision ledger.
4. No remediation is triggered automatically.

## Runbook Orchestrator
Module: `workflows/runbook-automation/runbook-orchestrator.js`  
CLI: `scripts/runbook-orchestrator.js`

Execution requirements:
- `--remediation-request <path>`
- `--approval-token <token>`
- `--confirm`

Flow:
1. Present remediation recommendation, rationale, acceptance criteria, and risk.
2. Require explicit operator confirmation and scoped token consumption.
3. Invoke `scripts/apply-remediation-delta.js` only after approval.
4. Write immutable records to:
   - Phase 9 override ledger
   - Phase 10 operational decision ledger

Rollback:
1. Stop additional runbook actions.
2. Restore affected contracts/files from approved baseline.
3. Re-run Phase 8/9/10 policy gates.
4. Re-run full test suite and regenerate evidence.

## Incident Artifact Workflow
Module: `workflows/incident-management/incident-artifact-creator.js`  
CLI: `scripts/incident-trigger.sh`

Artifact structure:
- deterministic `incident_id` (`INC-YYYYMMDD-###`)
- trigger, severity, affected components
- recommended action and escalation path
- `requires_operator_action: true`
- `auto_remediation_blocked: true`
- decision-ledger reference

## Incident Escalation Policy
Module: `workflows/incident-management/escalation-orchestrator.js`

Severity to tier mapping:
- `low` -> `email`
- `medium` -> `email`, `slack`
- `high` -> `email`, `slack`, `cline`
- `critical` -> `email`, `slack`, `cline`, `pager`

Re-escalation:
- Supported only when operator sets explicit opt-in policy flag.
- Never triggers auto-remediation.

## External Attestation Policy
Module: `workflows/attestation/external-attestation-anchor.js`  
CLI: `scripts/external-attestation-anchor.js`  
Allowlist: `security/phase10-attestation-egress-allowlist.json`

Required controls:
- `--approval-token`
- `--scope governance.attestation.anchor`
- `--external-service <https://...>`
- `--evidence-bundle <path>`
- `--confirm`

Enforcement:
- Host must match static allowlist.
- HTTPS URL required.
- Blocked by default when not explicitly approved.
- Anchor attempts/results logged to override + operational decision ledgers.

Verification:
- `verifyAttestationAnchor(anchorId)` recomputes deterministic proof and returns:
  - `valid`
  - `external_reference`

## On-Call Procedure
1. Run SLO evaluation and review active advisory alerts.
2. Acknowledge alerts in operator channel.
3. Create incident artifact for high/critical conditions.
4. Escalate by severity tier.
5. Execute runbook only with explicit token + confirmation.
6. Optionally anchor evidence externally only with explicit attestation approval.
7. Regenerate evidence artifacts and verify policy gates.

## Deterministic Evidence Outputs
Generated by `scripts/generate-phase10-artifacts.js` under `audit/evidence/observability/`:
- metrics schema/sample/json/prometheus
- SLO definitions and alert rules
- runbook templates/execution sample
- incident and escalation policy samples
- external attestation policy and anchor sample
- decision ledger sample
- hash manifest
