# Dependency Review

Lockfile-Review: approved
Reviewer: security-team-initial
Review-Date: 2026-03-03
Risk-Assessment: low

Cache-Rebuild-Reason: phase3 zod dependency addition for strict MCP schemas

## Notes
- Node version pinned to `v22.13.1` via `.nvmrc`.
- Registry pinned to `https://registry.npmjs.org/` via `.npmrc`.
- Install policy requires `npm ci --offline --ignore-scripts`.
- Lifecycle hooks are prohibited and validated by CI.
- Added `zod@3.24.1` for strict MCP input/output schema enforcement.
