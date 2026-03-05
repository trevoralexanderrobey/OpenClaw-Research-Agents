# Phase 17 Runtime Hardening and Resume

## Objective
Phase 17 extends runtime hardening with deterministic persistent state and restart/resume orchestration.

## Runtime Modules
- `openclaw-bridge/execution/tool-image-catalog.js`
- `openclaw-bridge/execution/container-runtime.js`

State/resume modules:
- `openclaw-bridge/state/persistent-store.js`
- `openclaw-bridge/state/state-hydrator.js`
- `openclaw-bridge/state/open-loop-manager.js`
- `openclaw-bridge/core/restart-resume-orchestrator.js`

State paths:
- Runtime store (gitignored): `state/runtime/state.json`
- Committed template: `state/runtime/state.sample.json`
- Existing governance canonical state remains at `workspace/runtime/state.json`

## Hardening Controls
- Tool image allowlist and digest-pinning policy.
- Runtime policy validation and security config assertions.
- No direct unsafe shell execution paths for containers.
- Deterministic open-loop registration and resolution.

## Resume Behavior
- Hydrates persistent runtime state.
- Builds deterministic resume plan from open loops.
- Requeues unresolved loops with stable ordering.
- Re-applies supervisor approval and governance approval before resumed execution.

## Cline Supervisor Authority Enforcement
- Resumed execution path requires supervisor authority and governance approval contracts.
- Missing supervisor/governance approval contracts fail closed.

## Verification
```bash
bash scripts/verify-phase17-policy.sh
node --test tests/core/phase17-resume-orchestrator.test.js
node --test tests/security/phase17-policy-gate.test.js
```
