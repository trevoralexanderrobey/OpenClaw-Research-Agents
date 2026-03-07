#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SELF_DIR}/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || { echo "ERROR: --root requires a path argument" >&2; exit 1; }
      ROOT="$(cd "$2" && pwd)"
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

fail() {
  echo "$1" >&2
  exit 1
}

has_rg() {
  if [[ "${PHASE18_POLICY_FORCE_NO_RG:-0}" == "1" ]]; then
    return 1
  fi
  command -v rg >/dev/null 2>&1
}

search_quiet() {
  local pattern="$1"
  local file_path="$2"
  if has_rg; then
    rg -q -- "$pattern" "$file_path"
    return
  fi
  grep -Eq -- "$pattern" "$file_path"
}

search_lines() {
  local pattern="$1"
  shift
  if has_rg; then
    rg -n --glob '*.js' -- "$pattern" "$@" || true
    return
  fi
  grep -R -nE --include='*.js' -- "$pattern" "$@" || true
}

REQUIRED_FILES=(
  "$ROOT/.gitignore"
  "$ROOT/config/agent-spawner.json"
  "$ROOT/config/mission-templates.json"
  "$ROOT/security/skill-registry.lock.json"
  "$ROOT/openclaw-bridge/core/mission-envelope-schema.js"
  "$ROOT/openclaw-bridge/core/agent-spawner.js"
  "$ROOT/openclaw-bridge/core/spawn-planner.js"
  "$ROOT/openclaw-bridge/core/spawn-orchestrator.js"
  "$ROOT/openclaw-bridge/core/skill-provider.js"
  "$ROOT/openclaw-bridge/core/skill-providers/openclaw-skill-provider.js"
  "$ROOT/openclaw-bridge/core/skill-providers/openai-skill-provider.js"
  "$ROOT/scripts/_research-runtime.js"
  "$ROOT/scripts/run-research-task.js"
  "$ROOT/scripts/verify-phase18-policy.sh"
  "$ROOT/tests/core/phase18-agent-spawner.test.js"
  "$ROOT/tests/core/phase18-skill-provider.test.js"
  "$ROOT/tests/core/phase18-runtime-compat.test.js"
  "$ROOT/tests/security/phase18-policy-gate.test.js"
  "$ROOT/docs/phase18-agent-spawner.md"
  "$ROOT/docs/supervisor-architecture.md"
  "$ROOT/audit/evidence/mission-orchestration/mission-sample.json"
  "$ROOT/audit/evidence/mission-orchestration/hash-manifest.json"
  "$ROOT/workspace/missions/.gitkeep"
)

for file in "${REQUIRED_FILES[@]}"; do
  [[ -f "$file" ]] || fail "Missing Phase 18 file: $file"
done

SCAN_TARGETS=(
  "$ROOT/scripts/_research-runtime.js"
  "$ROOT/scripts/run-research-task.js"
)

while IFS= read -r file; do
  [[ "$file" == "$ROOT/openclaw-bridge/core/llm-adapter.js" ]] && continue
  SCAN_TARGETS+=("$file")
done < <(find "$ROOT/openclaw-bridge/core" -type f -name '*.js' | sort)

UNSAFE_NETWORK="$(search_lines 'fetch\(|axios|http\.request\(|https\.request\(|node:http|node:https|WebSocket|browser\.launch|playwright|puppeteer|selenium|child_process\.exec|child_process\.spawn|docker run' "${SCAN_TARGETS[@]}")"
if [[ -n "$UNSAFE_NETWORK" ]]; then
  echo "$UNSAFE_NETWORK" >&2
  fail "Phase 18 modules must remain free of direct network, browser, shell, or container execution paths"
fi

search_quiet 'executeOrchestratedTask' "$ROOT/openclaw-bridge/core/agent-engine.js" || fail "agent-engine missing orchestrated task wrapper"
search_quiet 'roleRouter\.dispatch' "$ROOT/openclaw-bridge/core/spawn-orchestrator.js" || fail "spawn-orchestrator must route work through role-router"
search_quiet 'Promise\.race' "$ROOT/openclaw-bridge/core/spawn-orchestrator.js" || fail "spawn-orchestrator must provide bounded concurrent dispatch scheduling"
search_quiet 'laneInflight' "$ROOT/openclaw-bridge/core/spawn-orchestrator.js" || fail "spawn-orchestrator must track lane bounded concurrency"
search_quiet 'PHASE18_MISSION_TIMEOUT' "$ROOT/openclaw-bridge/core/spawn-orchestrator.js" || fail "spawn-orchestrator must enforce mission runtime timeout guard"
search_quiet 'PHASE18_MISSION_STALLED' "$ROOT/openclaw-bridge/core/spawn-orchestrator.js" || fail "spawn-orchestrator must enforce mission stall detection guard"
search_quiet 'checkpoint_artifacts' "$ROOT/openclaw-bridge/core/spawn-orchestrator.js" || fail "spawn-orchestrator must emit checkpoint artifact metadata"
search_quiet 'validateTemplateStructure' "$ROOT/openclaw-bridge/core/spawn-planner.js" || fail "spawn-planner must validate template structure before planning"
search_quiet 'agentSpawner\.spawnMission' "$ROOT/scripts/run-research-task.js" || fail "run-research-task missing mission spawn path"
search_quiet 'resumeMission\(' "$ROOT/scripts/run-research-task.js" || fail "run-research-task missing mission resume path"
search_quiet 'supervisor_approved' "$ROOT/openclaw-bridge/core/agent-spawner.js" || fail "agent-spawner must persist supervisor_approved mission status"
search_quiet '^workspace/missions/\*$' "$ROOT/.gitignore" || fail "workspace/missions/* must be gitignored"
search_quiet '^!workspace/missions/\.gitkeep$' "$ROOT/.gitignore" || fail "workspace/missions/.gitkeep exception missing"
search_quiet 'Phase 18 runtime authority remains in-repo \(`supervisor-authority` \+ governance path\)\.' "$ROOT/docs/phase18-agent-spawner.md" || fail "Phase 18 doc must preserve in-repo runtime authority wording"
search_quiet 'mission runtime remains tool-agnostic and does not depend on Cline programmatically\.' "$ROOT/docs/phase18-agent-spawner.md" || fail "Phase 18 doc must preserve tool-agnostic runtime wording"
search_quiet 'canonical runtime supervisor/governance authority remains in-repo' "$ROOT/docs/supervisor-architecture.md" || fail "supervisor architecture must preserve in-repo runtime authority wording"
if search_quiet 'is the supervisor interface for this repository' "$ROOT/docs/supervisor-architecture.md"; then
  fail "supervisor architecture must not describe Cline as the embedded runtime supervisor interface"
fi

ROOT_DIR="$ROOT" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.ROOT_DIR;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

const spawnerConfig = readJson("config/agent-spawner.json");
const missionTemplates = readJson("config/mission-templates.json");
const skillLock = readJson("security/skill-registry.lock.json");
const allowedTaskTypes = new Set(["summarize", "extract", "analyze", "synthesize", "freeform"]);
const allowedInputStrategies = new Set(["mission_inputs", "mission_and_dependency_outputs", "dependency_outputs"]);

if (spawnerConfig.missionWorkspaceDir !== "workspace/missions") {
  fail("Phase 18 mission workspace dir must remain workspace/missions");
}
if (spawnerConfig.runtimeStatePath !== "state/runtime/state.json") {
  fail("Phase 18 runtime state path must remain state/runtime/state.json");
}
if (spawnerConfig.finalSynthesisMode !== "orchestrator_aggregation") {
  fail("Phase 18 final synthesis ownership must remain orchestrator_aggregation");
}
if (!spawnerConfig.missionExecution || typeof spawnerConfig.missionExecution !== "object") {
  fail("Phase 18 missionExecution config must exist");
}
if (!spawnerConfig.checkpointing || typeof spawnerConfig.checkpointing !== "object") {
  fail("Phase 18 checkpointing config must exist");
}
if (!spawnerConfig.laneScaling || typeof spawnerConfig.laneScaling !== "object") {
  fail("Phase 18 laneScaling config must exist");
}
for (const key of ["maxRuntimeMs", "defaultSubtaskTimeoutMs", "stallIntervalMs", "schedulerTickMs"]) {
  const value = Number(spawnerConfig.missionExecution[key]);
  if (!Number.isFinite(value) || value < 0) {
    fail(`Phase 18 missionExecution.${key} must be a non-negative number`);
  }
}
if (!spawnerConfig.skillConfig || spawnerConfig.skillConfig.hostedSkillsEnabled !== false) {
  fail("Hosted skill refs must remain disabled by default in config/agent-spawner.json");
}
if (skillLock.hostedSkillsEnabled !== false) {
  fail("Hosted skill refs must remain disabled by default in security/skill-registry.lock.json");
}

const templates = missionTemplates.templates || {};
for (const [templateId, template] of Object.entries(templates)) {
  if (template.safety_class === "external_action" && template.enabled !== false) {
    fail(`External action template '${templateId}' must remain disabled`);
  }
  if (template.enabled === true && !["research_only", "draft_artifact"].includes(template.safety_class)) {
    fail(`Enabled template '${templateId}' must be research_only or draft_artifact`);
  }
  const roles = Array.isArray(template.spawned_roles) ? template.spawned_roles : [];
  const steps = Array.isArray(template.steps) ? template.steps : [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] || {};
    if (!roles.includes(step.role)) {
      fail(`Template '${templateId}' step ${index + 1} uses undeclared role '${step.role || ""}'`);
    }
    if (!step.action_type || typeof step.action_type !== "string") {
      fail(`Template '${templateId}' step ${index + 1} must declare a non-empty action_type`);
    }
    if (!allowedTaskTypes.has(step.task_type)) {
      fail(`Template '${templateId}' step ${index + 1} uses unsupported task_type '${step.task_type || ""}'`);
    }
    if (!allowedInputStrategies.has(step.input_strategy)) {
      fail(`Template '${templateId}' step ${index + 1} uses unsupported input_strategy '${step.input_strategy || ""}'`);
    }
    const dependsOn = Array.isArray(step.depends_on) ? step.depends_on : [];
    for (const dependency of dependsOn) {
      if (!Number.isInteger(dependency) || dependency < 1 || dependency >= index + 1) {
        fail(`Template '${templateId}' step ${index + 1} has invalid dependency '${dependency}'`);
      }
    }
  }
}

if (spawnerConfig.enabled === true) {
  const llmSummaryPath = path.join(root, spawnerConfig.liveEvidence.llmSummaryPath);
  const mcpSummaryPath = path.join(root, spawnerConfig.liveEvidence.mcpSummaryPath);
  if (!fs.existsSync(llmSummaryPath) || !fs.existsSync(mcpSummaryPath)) {
    fail("Phase 18 cannot be enabled before live evidence summaries exist");
  }
  const llmSummary = JSON.parse(fs.readFileSync(llmSummaryPath, "utf8"));
  const mcpSummary = JSON.parse(fs.readFileSync(mcpSummaryPath, "utf8"));
  const llmSuccess = Array.isArray(llmSummary.results) && llmSummary.results.some((entry) => entry && entry.status === "success" && entry.provider !== "mock");
  const mcpSuccess = Array.isArray(mcpSummary.results) && mcpSummary.results.some((entry) => entry && entry.mcp_service_live && entry.mcp_service_live.status === "success");
  if (!llmSuccess) {
    fail("Phase 18 cannot be enabled before a non-mock live LLM success is recorded");
  }
  if (!mcpSuccess) {
    fail("Phase 18 cannot be enabled before a live MCP service-path success is recorded");
  }
}
NODE

echo "Phase 18 policy verification passed"
