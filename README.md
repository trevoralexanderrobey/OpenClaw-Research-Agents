# OpenClaw Research Agents

Local-first, file-based, audit-oriented research orchestration scaffold built on OpenClaw architectural patterns.

## What It Does Now
- Runs operator-initiated research tasks through a supervisor-gated agent engine.
- Supports deterministic mock LLM execution out of the box (`mock` provider).
- Supports optional real providers (`local`/Ollama, `openai`, `anthropic`, `openrouter`) via local config.
- Persists task outputs, manifests, interaction logs, and governance artifacts on local disk.
- Enforces Cline supervisor authority and governance checks before execution.
- Includes multi-agent topology scaffolding, deterministic lane queues, comms bus, MCP ingestion connectors, and runtime resume modules.

## Quick Start

1. Install dependencies:
```bash
npm ci --offline --ignore-scripts --cache ./.ci/npm-cache
```

2. Run a mock research task (no API keys required):
```bash
node scripts/run-research-task.js \
  --task "Summarize the sample input documents" \
  --type summarize \
  --input workspace/research-input/sample/ \
  --output workspace/research-output/ \
  --provider mock \
  --confirm
```

3. Inspect results:
```bash
node scripts/list-research-tasks.js
node scripts/view-interaction-log.js
```

## Provider Configuration

Committed template:
- `config/llm-providers.json`

Local secrets/config (gitignored):
- `config/llm-providers.local.json`

Runtime interaction log (gitignored):
- `security/interaction-log.json`

Default provider is `mock` for safe deterministic local execution.

## Supervisor Model (Cline)
- Supervisor mediation is mandatory for task execution.
- Required lifecycle:
  - `pending -> supervisor_approved -> governance_approved -> executing -> completed|failed|rejected`
- Direct engine execution without `context.supervisorDecision.approved === true` fails closed (`SUPERVISOR_APPROVAL_REQUIRED`).
- `scripts/run-research-task.js` routes execution through supervisor approval and `runApprovedTask` only.
- External submission, platform login, attestation, and final submission actions are manual-only.

## Architecture

Core Phase 14 path:
- `scripts/run-research-task.js`
- `openclaw-bridge/core/supervisor-authority.js`
- `openclaw-bridge/core/governance-bridge.js`
- `openclaw-bridge/core/agent-engine.js`
- `openclaw-bridge/core/llm-adapter.js`
- `openclaw-bridge/core/research-output-manager.js`
- `openclaw-bridge/core/interaction-log.js`

Phase 15 extensions:
- `openclaw-bridge/core/agent-registry.js`
- `openclaw-bridge/core/role-router.js`
- `openclaw-bridge/core/lane-queue.js`
- `openclaw-bridge/core/comms-bus.js`
- `openclaw-bridge/core/autonomy-ladder.js`
- `openclaw-bridge/core/heartbeat-state.js`

Phase 16 extensions:
- `integrations/mcp/*`
- `workflows/research-ingestion/*`

Phase 17 extensions:
- `openclaw-bridge/execution/*`
- `openclaw-bridge/state/*`
- `openclaw-bridge/core/restart-resume-orchestrator.js`

Live Verification extensions:
- `scripts/run-live-llm-verification.js`
- `scripts/run-live-mcp-verification.js`
- `scripts/generate-phase1-evidence-map.js`
- `.github/workflows/live-verification.yml`

## Security and Governance Invariants
- No autonomous publishing/submission.
- No browser/login credential automation.
- Operator confirmation required for protected actions.
- Deterministic hashing/canonical JSON for audit artifacts.
- Network isolation for new phases:
  - Allowed only in `openclaw-bridge/core/llm-adapter.js` and `integrations/mcp/*`.
- Startup integrity is fail-closed.

## Phase Status

| Phase | Focus | Status |
|---|---|---|
| 2–13 | Governance/security foundation | Complete |
| 14 | Core research agent engine | Implemented |
| 15 | Multi-agent topology and comms/queue | Implemented |
| 16 | MCP ingestion and normalization | Implemented |
| 17 | Runtime hardening and resume orchestration | Implemented |

## Important Paths
- `workspace/research-input/` sample task inputs
- `workspace/research-output/` task outputs and index
- `workspace/comms/` multi-agent comms artifacts
- `workspace/research-raw/`, `workspace/research-normalized/`, `workspace/research-index/` ingestion artifacts
- `state/runtime/state.json` runtime resume state (gitignored)
- `audit/evidence/` deterministic evidence bundles

## Validation Commands
```bash
bash scripts/verify-phase14-policy.sh
bash scripts/verify-phase15-policy.sh
bash scripts/verify-phase16-policy.sh
bash scripts/verify-phase17-policy.sh
node scripts/run-live-llm-verification.js
node scripts/run-live-mcp-verification.js
node --test tests/**/*.test.js
node --test tests/scripts/**/*.test.js
npm run phase2:gates
```
