# Phase 18 Agent Spawner

Phase 18 adds mission orchestration on top of the validated Phase 14-17 baseline.

## Guardrails
- `state/runtime/state.json` remains the single global runtime index.
- `workspace/missions/<missionId>/...` is the mission-local durable record.
- `agent-spawner` and `spawn-orchestrator` may plan, register, dispatch, aggregate, persist, and resume.
- They may not directly invoke MCP tools, shell execution, container execution, browser automation, or external HTTP requests.
- Phase 18 is disabled by default until live LLM and live MCP evidence is upgraded from partial verification to passing proof.

## Mission Layout
- `workspace/missions/<missionId>/mission.json`
- `workspace/missions/<missionId>/spawn-plan.json`
- `workspace/missions/<missionId>/blackboard.md`
- `workspace/missions/<missionId>/agents/<agentId>/inbox.jsonl`
- `workspace/missions/<missionId>/agents/<agentId>/outbox.jsonl`
- `workspace/missions/<missionId>/artifacts/`
- `workspace/missions/<missionId>/status.json`

## Enabled Template Classes
- `research_only`
- `draft_artifact`

`external_action` templates exist only as disabled stubs in Phase 18.
