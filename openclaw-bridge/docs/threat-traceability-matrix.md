# Threat Traceability Matrix (Phase 1)

| attack_node_id | threat_model_category | control_anchor | test_case_id | evidence_id | status |
|---|---|---|---|---|---|
| A1 | Elevation of Privilege | `src/core/execution-router.ts` supervisor boundary checks | T-A1 | E-A1 | planned |
| A2 | Tampering | `openclaw.json` + freeze flag governance docs | T-A2 | E-A2 | planned |
| B1 | Elevation of Privilege | `execution/container-runtime.js` privileged/host mode constraints | T-B1 | E-B1 | planned |
| B2 | Tampering | `execution/sandbox-policy.js` read-only root filesystem policy | T-B2 | E-B2 | planned |
| C1 | Information Disclosure | token masking policy + audit rules | T-C1 | E-C1 | planned |
| C2 | Information Disclosure | credential broker boundary docs | T-C2 | E-C2 | planned |
| D1 | Tampering | `state/persistent-store.js` atomic write pattern | T-D1 | E-D1 | planned |
| D2 | Denial of Service | state schema reinjection ordering rules | T-D2 | E-D2 | planned |

Mandatory anchors included:
- `execution/tool-image-catalog.js`
- `execution/container-runtime.js`
- supervisor authority boundaries
- outbound mutation feature flags
