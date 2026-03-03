# Feature Flag Governance (Phase 1)

| Flag | Default | Phase 1 Requirement |
|---|---|---|
| `ENABLE_OPERATOR_MUTATIONS` | `false` | Must remain false |
| `ENABLE_NEWSLETTER_PUBLISHER_MCP` | `false` | Stub-only |
| `ENABLE_NOTION_SYNC_MCP` | `false` | Stub-only |
| `ENABLE_EXTERNAL_POST_PUT_DELETE` | `false` | Prohibited |

## Governance notes
- Flags are control-plane policy objects, not user prompts.
- Non-default values require approved change control.
