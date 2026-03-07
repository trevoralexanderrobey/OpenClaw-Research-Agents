# Runtime Core Architecture

## Control-plane responsibilities
- Gateway ingress and transport multiplexing.
- Bridge route normalization.
- Lane Queue sequencing.
- Deterministic state persistence and hydration.

## Queue model
- Per-session FIFO lane semantics.
- State persisted on enqueue/dequeue transitions.
- Restart reinjection from unresolved open loops.

## Failure recovery
- Circuit breaker gates repeated failures.
- Unresolved work remains in `openLoops`.
- Hydration reconstructs context from state + memory logs.

## Preflight validation
- Payload sizes and structures are enforced ahead of execution.
- Prevents egress policy violations by rejecting out-of-bounds requests before the mutation queue.

## RLHF Review Pipeline
- Automates internal draft preparation, formatting, and compliance linting.
- Output explicitly constrained to deterministic manual-handoff packaging; absolutely no automated external submission.

## Outcome Intelligence Pipeline
- Computes deterministic quality scoring and calibration from operator-entered feedback.
- Generates weekly/monthly intelligence artifacts without autonomous external side effects.

## Experiment Governance Pipeline
- Internal deterministic assignment engine, rollout controls, and analysis snapshot generation.
- Validates pre-registration hash locks and applies startup integrity checks before processing requests.

## Compliance and Release Gating
- Attestation logic evaluates evidence bundle generation requirements continuously.
- Applies pre-flight check verifications against compliance chain before handling requests.

## Governance Automation
- Executes deterministic read-only compliance sweeps preventing silent drift.
- Formalizes tamper-evident ledger patterns for override resolution tracking.

## Operational Resilience Pipeline
- Exposes deterministic telemetry and advisory SLO alerting channels.
- Orchestrates operator-gated runbook execution and blocks automated remediation.

## Recovery Assurance Pipeline
- Automatically generates deterministic backup manifests and verifies artifact chain integrity.
- Provides read-only continuity drill validation while enforcing strict operator-only lockouts on actual restore procedures.

## Supply Chain Security
- Validates known-good dependencies and constructs SLSA-compatible build provenance logic.
- Maintains purely advisory vulnerability reports and mandates operator action for any updates.

## Access Control & Identity Governance
- Implements deterministic, local-only access control across all operator-gated workflows using canonical RBAC.
- Governs session state and fail-closed permission boundaries without autonomous external Identity Provider mechanisms.

## Research Agent Execution Engine (Phase 14-15)
- Orchestrates multi-agent topologies utilizing deterministic queue lanes and explicit comms buses.
- Constrains direct task execution behind the Supervisor mandatory approval gate (`supervisorDecision.approved`).

## Runtime Hardening & Data Normalization (Phase 16-17)
- Unifies structured MCP retrieval schemas into the deterministic internal logic pipeline.
- Enforces resilient resume mechanisms orchestrating local session state checkpoints through runtime failures.

## Live Verification & Readiness Pipeline
- Synthesizes read-only health checks orchestrating live LLM endpoints and active MCP components.
- Commits timestamped evidence maps proving current configuration execution safely without breaking determinism rules.

## Mission Orchestration (Phase 18)
- Coordinates multiple spawn lifecycles mapped under a unified blackboard with dependency-aware, deterministic scheduling.
- Routes deterministic agent configurations and registers dynamically generated local dependencies using bounded concurrency limits.
- Incorporates mission execution timeout flags, stall guards, and optional artifact checkpoint synthesis from completed subtask aggregates.

## Dataset Foundation & Monetization (Phase 19)
- Orchestrates reproducible offline conversion from distinct research missions into deterministic staged dataset builds mapping defined metadata, manifests, and strict typing.
- Packagers compile internal content logic, bundles, deliverables, and release-ready staging items under deterministic checksum definitions without autonomously invoking marketplace web interfaces.
