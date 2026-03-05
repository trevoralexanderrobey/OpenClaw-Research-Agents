# Phase 14 Agent Engine

## Overview
Phase 14 introduces the functional core research engine while keeping governance and supervisor controls as hard requirements.

Execution flow:
1. Operator submits a task through `scripts/run-research-task.js`.
2. Supervisor authority decides approval/denial.
3. Governance approval runs after supervisor approval.
4. Agent engine executes prompt construction and LLM completion.
5. Output manager persists output, metadata, and manifests.
6. Governance bridge records execution and emits RLHF dual-write artifacts.

## Core Modules
- `openclaw-bridge/core/agent-engine.js`
- `openclaw-bridge/core/governance-bridge.js`
- `openclaw-bridge/core/supervisor-authority.js`
- `openclaw-bridge/core/llm-adapter.js`
- `openclaw-bridge/core/interaction-log.js`
- `openclaw-bridge/core/task-definition-schema.js`
- `openclaw-bridge/core/research-output-manager.js`

## LLM Provider Configuration
Committed template:
- `config/llm-providers.json`

Local override (gitignored):
- `config/llm-providers.local.json`

Supported providers:
- `mock` (default, deterministic)
- `local` (Ollama)
- `openai`
- `anthropic`
- `openrouter`

Network calls are isolated to `openclaw-bridge/core/llm-adapter.js`.

## Task Definition Reference
Schema version:
- `phase14-task-definition-v1`

Task types:
- `summarize`
- `extract`
- `analyze`
- `synthesize`
- `freeform`

Required fields:
- `type`
- `description`
- `outputFormat` (`markdown`, `json`, `text`)

Task ID is deterministic from canonicalized `{type, description, inputs_hash, created_at}`.

## Output Format Specification
Per task directory:
- `workspace/research-output/<task_id>/output.md|output.json|output.txt`
- `workspace/research-output/<task_id>/metadata.json`
- `workspace/research-output/<task_id>/manifest.json`

Global output index:
- `workspace/research-output/tasks-index.json`

Output catalog hash manifest:
- `workspace/research-output/hash-manifest.json`

## Governance Integration Map
Supervisor and governance checkpoints:
- `requestSupervisorApproval(taskDefinition, context)`
- `requestTaskApproval(taskDefinition, context)`
- `recordTaskExecution(taskId, result, context)`
- `generateRLHFEntry(taskId, interaction, context)`

RLHF mode:
- Pipeline-integrated
- Dual-write:
  - Global governance transaction state
  - Task-local mirror `rlhf-entry.json`

## Cline Supervisor Authority Enforcement
- Supervisor authority composes:
  - `openclaw-bridge/supervisor/supervisor-v1.js`
  - `openclaw-bridge/supervisor/request-queue.js`
  - `openclaw-bridge/supervisor/circuit-breaker.js`
  - `openclaw-bridge/supervisor/supervisor-registry.json`
- Engine execution requires `context.supervisorDecision.approved === true`.
- Missing receipt fails closed with `SUPERVISOR_APPROVAL_REQUIRED`.
- Denied supervisor path terminates before LLM execution.

## Quick Start (Mock Provider)
```bash
node scripts/run-research-task.js \
  --task "Summarize the sample input documents" \
  --type summarize \
  --input workspace/research-input/sample/ \
  --output workspace/research-output/ \
  --provider mock \
  --confirm
```

Inspect artifacts:
```bash
node scripts/list-research-tasks.js
node scripts/view-interaction-log.js
```
