# Phase 18 Agent Spawner

Phase 18 adds mission orchestration on top of the validated Phase 14-17 baseline.

## Guardrails
- `state/runtime/state.json` remains the single global runtime index.
- `workspace/missions/<missionId>/...` is the mission-local durable record.
- `agent-spawner` and `spawn-orchestrator` may plan, register, dispatch, aggregate, persist, and resume.
- They may not directly invoke MCP tools, shell execution, container execution, browser automation, or external HTTP requests.
- Phase 18 is disabled by default until live LLM and live MCP evidence is upgraded from partial verification to passing proof.
- Final mission synthesis ownership is explicit: `finalSynthesisMode = orchestrator_aggregation`.

## Mission Layout
- `workspace/missions/<missionId>/mission.json`
- `workspace/missions/<missionId>/spawn-plan.json`
- `workspace/missions/<missionId>/blackboard.md`
- `workspace/missions/<missionId>/agents/<agentId>/inbox.jsonl`
- `workspace/missions/<missionId>/agents/<agentId>/outbox.jsonl`
- `workspace/missions/<missionId>/artifacts/`
- `workspace/missions/<missionId>/status.json`

`status.json` keeps the current state and an append-only `status_history` for lifecycle transitions, including `supervisor_approved`.

## Execution Model
- Subtasks are dispatched through bounded concurrency using lane and concurrency-key inflight counters (`max_inflight` from the spawn plan).
- Scheduling is dependency-aware and deterministic by queue order.
- Mission execution adds timeout and stall guards (`mission_max_runtime_ms`, `default_subtask_timeout_ms`, `stall_interval_ms`) and preserves open-loop state for resumable partial progress.
- Optional checkpoint synthesis writes deterministic intermediate summaries under `workspace/missions/<missionId>/artifacts/checkpoints/` from completed subtask outputs only.
- Lane scaling is deterministic and bounded (`min_inflight`..`max_inflight`), with every scaling decision projected into mission blackboard/status metadata.
- All side effects remain in worker paths routed through `role-router -> agent-engine -> existing execution boundaries`.

## Enabled Template Classes
- `research_only`
- `draft_artifact`

`external_action` templates exist only as disabled stubs in Phase 18.

## Phase 19 Compatibility
- New Phase 19 templates continue to use the existing mission runtime shape:
  - `research_pack`
  - `dataset_sample`
  - `subscription_refresh`
- Allowed task types remain bounded to the existing validated set:
  - `extract`
  - `analyze`
  - `synthesize`
  - `freeform`
- Dataset building and monetization packaging happen after mission completion through dedicated Phase 19 scripts and modules.
- Internal packaging autonomy is expanded for local artifact preparation only.
- External publishing, upload, marketplace submission, and delivery remain manual-only and outside the Phase 18 mission runtime.

## Outer Operator Workflow Compatibility
- Phase 18 runtime authority remains in-repo (`supervisor-authority` + governance path).
- Cline is a recommended outer operator shell for planning/review and approved implementation work.
- The mission runtime remains tool-agnostic and does not depend on Cline programmatically.
- GitHub Actions is the primary enforcement path for policy/test gates in this public repo.
