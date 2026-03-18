# Phase 27 Sider + Hatchify Governed Integration

Phase 27 builds on Phase 26A and keeps OpenClaw as the governed core.

## Scope
- Hatchify uses a dedicated read-only integration lane (`integration_hatchify`).
- Integration auth uses existing Phase 13 token lifecycle and scope validation contracts.
- Server-side operation exposure remains read-only for the integration lane.
- Sider workflow is manual-only:
  - export redacted brief artifacts
  - operator reviews outside OpenClaw
  - operator manually re-enters approved response as deterministic artifacts

## Contracts
- Export artifacts:
  - `workspace/operator-briefs/sider/<exchange_id>/export/brief.md`
  - `workspace/operator-briefs/sider/<exchange_id>/export/export-manifest.json`
- Re-entry artifacts:
  - `workspace/operator-briefs/sider/<exchange_id>/reentry/approved-response.md`
  - `workspace/operator-briefs/sider/<exchange_id>/reentry/reentry-manifest.json`
- Re-entry manifest must include source export hash linkage and task reference id.

## Non-goals
- No browser automation.
- No login automation.
- No background sync.
- No bidirectional integration.
- No mutation access for Hatchify.
