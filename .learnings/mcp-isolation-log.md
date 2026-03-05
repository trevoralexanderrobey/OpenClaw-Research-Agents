# MCP Isolation Log

## Baseline (all disabled)

- timestamp: 2026-03-04T22:25:42Z
- attempt: baseline-1
- server: ALL_DISABLED
- enabled_set: []
- result: fail
- error_text: Replay automation did not create a new Cline task within timeout
- failing_tool_index: null
- failing_tool_name: null
- source_task_id: 1772662059593
- replay_task_id: null

- timestamp: 2026-03-04T22:30:34Z
- attempt: baseline-2-confirm
- server: ALL_DISABLED
- enabled_set: []
- result: fail
- error_text: Timed out waiting for replay task completion signal
- failing_tool_index: null
- failing_tool_name: null
- source_task_id: 1772662059593
- replay_task_id: 1772663474192
- notes: No regex invalid tool-name error observed before timeout.

## Attempts (alphabetical)

- timestamp: 2026-03-04T22:28:29Z
- attempt: 1
- server: openclaw-local
- enabled_set: [openclaw-local]
- result: fail
- error_text: Invalid 'tools[14].name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.\",\"modelId\":\"gpt-5.3-codex\",\"providerId\":\"openai-codex\"}"}
- failing_tool_index: 14
- failing_tool_name: null
- source_task_id: 1772662059593
- replay_task_id: 1772663394490

## Stop condition

- First regex failure reproduced with enabled-only server: openclaw-local
- Marked: SUSPECT_SERVER=openclaw-local
- Additional servers not tested (none remaining).
