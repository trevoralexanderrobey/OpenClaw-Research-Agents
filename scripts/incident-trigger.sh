#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SEVERITY=""
COMPONENT=""
REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --severity)
      SEVERITY="${2:-}"
      shift 2
      ;;
    --component)
      COMPONENT="${2:-}"
      shift 2
      ;;
    --reason)
      REASON="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$SEVERITY" || -z "$COMPONENT" || -z "$REASON" ]]; then
  cat >&2 <<'USAGE'
Usage:
  bash scripts/incident-trigger.sh \
    --severity <low|medium|high|critical> \
    --component "<component-name>" \
    --reason "<manual reason>"
USAGE
  exit 1
fi

SEVERITY="$SEVERITY" COMPONENT="$COMPONENT" REASON="$REASON" node <<'NODE'
"use strict";

const { createApiGovernance } = require("./security/api-governance.js");
const { createIncidentArtifactCreator } = require("./workflows/incident-management/incident-artifact-creator.js");

(async () => {
  const governance = createApiGovernance();
  const creator = createIncidentArtifactCreator({
    apiGovernance: governance
  });

  const result = await creator.createIncidentArtifact("manual_operator_escalation", process.env.SEVERITY, {
    actor: process.env.OPERATOR_ID || "operator-cli",
    affected_components: [String(process.env.COMPONENT || "unknown-component")],
    recommended_action: `Operator escalation requested: ${String(process.env.REASON || "")}`,
    escalation_path: ["operator-email", "cline-notification", "pager"],
    reason: String(process.env.REASON || "")
  });

  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
NODE
