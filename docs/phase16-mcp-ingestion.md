# Phase 16 MCP Ingestion

## Objective
Phase 16 adds research ingestion connectors and deterministic normalization/indexing pipelines for local knowledge processing.

## Connectors
- `integrations/mcp/mcp-client.js`
- `integrations/mcp/arxiv-client.js`
- `integrations/mcp/semantic-scholar-client.js`

## Ingestion Workflow
- `workflows/research-ingestion/ingestion-pipeline.js`
- `workflows/research-ingestion/normalizer.js`
- `workflows/research-ingestion/citation-metrics.js`
- `workflows/research-ingestion/source-ledger.js`

Output paths:
- `workspace/research-raw/`
- `workspace/research-normalized/`
- `workspace/research-index/`

## Determinism and Integrity
- Canonical paper keys for stable dedupe.
- Stable sorting of normalized records.
- Source ledger append-only chain hash.
- Tamper detection through `verifyChainIntegrity()`.

## Network Isolation
Allowed network paths for Phase 14–17 code:
- `openclaw-bridge/core/llm-adapter.js`
- `integrations/mcp/*`

All other newly added modules are network-free.

## Supervisor and Governance Boundaries
- Ingestion remains orchestrated under supervisor/governance pipelines.
- Export/publish actions remain dry-run unless explicit operator confirmation is provided.

## Verification
```bash
bash scripts/verify-phase16-policy.sh
node --test tests/core/phase16-ingestion-pipeline.test.js
node --test tests/security/phase16-policy-gate.test.js
```
