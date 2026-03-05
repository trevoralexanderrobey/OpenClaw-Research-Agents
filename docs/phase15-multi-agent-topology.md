# Phase 15 Multi-Agent Topology

## Objective
Phase 15 adds deterministic multi-agent topology and file-based communications while preserving supervisor authority and governance-first execution.

## Topology Components
- `openclaw-bridge/core/agent-registry.js`
- `openclaw-bridge/core/role-router.js`
- `openclaw-bridge/core/lane-queue.js`
- `openclaw-bridge/core/comms-bus.js`
- `openclaw-bridge/core/autonomy-ladder.js`
- `openclaw-bridge/core/heartbeat-state.js`

Role model:
- `supervisor`
- `scout`
- `analyst`
- `synthesizer`
- `operator`

## Deterministic Queues and Comms
Lane queue persistence:
- `workspace/comms/events/lane-queue.json`

Comms directories:
- `workspace/comms/inbox/`
- `workspace/comms/outbox/`
- `workspace/comms/blackboard/`
- `workspace/comms/events/`

Comms behavior:
- Atomic writes (`tmp` + rename)
- Ordered sequence allocation
- Envelope hash recording
- Blackboard chain hash linking
- Tamper detection via `detectTamper()`

## Supervisor Authority Enforcement
- `role-router.dispatch()` rejects missing supervisor receipt.
- Supervisor-approved context remains mandatory before role execution.
- Autonomy ladder gates role/action pairs and optional human-approval escalation.

## Config
- `config/agent-topology.json`
- `config/autonomy-ladder.json`

## Verification
```bash
bash scripts/verify-phase15-policy.sh
node --test tests/core/phase15-lane-queue.test.js
node --test tests/security/phase15-policy-gate.test.js
```
