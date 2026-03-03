# OpenClaw Research Agents

Local-first, file-based, audit-oriented research orchestration scaffold built on OpenClaw architectural patterns.

## Phase 5 status
- Preflight validation implemented to enforce strict size/payload constraints and safety bounds for outbound mutations.
- Workload integrity guaranteed via SBOM generation, registry/digest verification, and lockfile/cache validation.
- Phase 2 runtime hardening controls preserved
- Controlled MCP ingestion layer remains enabled for research reads
- Controlled outbound mutation layer enabled for newsletter and Notion via operator-only two-phase commit
- Static outbound allowlists enforced for read and write providers
- Deterministic replay protections include sequence/idempotency duplicate blocking
- Mutation governance, kill-switch, and operator authorization enforcement enabled
- Internal RLHF workflow automation enabled for deterministic draft generation, linting, and manual handoff packaging
- RLHF drafts are always AI-assisted and marked human-review-required

## Key directories
- `openclaw-bridge/` runtime/control-plane scaffold
- `workspace/` deterministic runtime state, comms, and memory files
- `audit/` provenance, purge, checklist, and sign-off artifacts

## Current boundary
Automatic publishing is not enabled.
Supervisor direct tool execution remains blocked.
Mutation requires explicit operator approval and governance checks.
External RLHF submission to third-party platforms is manual-only.
Platform login, attestation, and final submission actions are always human-operated.
