"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  canonicalize,
  findLineNumber,
  readTextIfExists,
  safeString,
  stableSortStrings,
  PHASE2_GATE_MANIFEST
} = require("./common.js");

const PHASE2_REQUIRED = Object.freeze([
  "security/operator-authorization.js",
  "tests/security/operator-authorization.test.js",
  "scripts/cleanroom-purge-validate.sh"
]);

const PHASE3_REQUIRED = Object.freeze([
  "security/api-governance.js",
  "scripts/verify-mcp-policy.sh",
  "tests/security/api-governance.test.js"
]);

const PHASE4_REQUIRED = Object.freeze([
  "security/mutation-control.js",
  "scripts/verify-mutation-policy.sh",
  "tests/security/mutation-control.test.js"
]);

const PHASE5_REQUIRED = Object.freeze([
  "workflows/rlhf-generator/pipeline-runner.js",
  "scripts/verify-phase5-policy.sh",
  "tests/security/rlhf-draft-generation.test.js"
]);

const PHASE6_REQUIRED = Object.freeze([
  "workflows/rlhf-outcomes/outcome-capture.js",
  "scripts/verify-phase6-policy.sh",
  "tests/security/rlhf-outcome-capture.test.js"
]);

const PHASE7_REQUIRED = Object.freeze([
  "workflows/experiment-governance/experiment-manager.js",
  "security/phase7-startup-integrity.js",
  "scripts/verify-phase7-policy.sh",
  "tests/security/phase7-startup-integrity.test.js"
]);

const PHASE8_REQUIRED = Object.freeze([
  "workflows/compliance-governance/compliance-decision-ledger.js",
  "workflows/compliance-governance/compliance-schema.js",
  "workflows/compliance-governance/compliance-validator.js",
  "workflows/compliance-governance/evidence-bundle-builder.js",
  "workflows/compliance-governance/release-gate-governor.js",
  "workflows/compliance-governance/runtime-attestation-engine.js",
  "analytics/compliance-explainability/attestation-explainer.js",
  "analytics/compliance-explainability/gate-rationale.js",
  "security/phase8-startup-integrity.js",
  "scripts/generate-phase8-artifacts.js",
  "scripts/migrate-state-v7-to-v8.js",
  "scripts/verify-phase8-policy.sh",
  "scripts/verify-phase8-ci-health.js",
  "docs/phase8-compliance-attestation.md",
  "tests/security/_phase8-helpers.js",
  "tests/security/compliance-decision-ledger.test.js",
  "tests/security/compliance-explainability.test.js",
  "tests/security/evidence-bundle-builder.test.js",
  "tests/security/phase8-ci-health.test.js",
  "tests/security/phase8-policy-gate.test.js",
  "tests/security/phase8-startup-integrity.test.js",
  "tests/security/release-gate-governor.test.js",
  "tests/security/runtime-attestation-engine.test.js",
  "tests/security/state-schema-v8.test.js",
  "tests/fixtures/phase8-ci/jobs-blocking.json",
  "tests/fixtures/phase8-ci/runs-merge-sha-blocking.json",
  "tests/fixtures/phase8-ci/runs-merge-sha-success.json",
  "tests/fixtures/phase8-ci/runs-superseded-failure-then-success.json"
]);

const PHASE9_REQUIRED = Object.freeze([
  "workflows/governance-automation/common.js",
  "workflows/governance-automation/compliance-monitor.js",
  "workflows/governance-automation/policy-drift-detector.js",
  "workflows/governance-automation/remediation-recommender.js",
  "workflows/governance-automation/operator-override-ledger.js",
  "workflows/governance-automation/phase-completeness-validator.js",
  "workflows/governance-automation/phase9-baseline-contracts.js",
  "security/phase9-startup-integrity.js",
  "scripts/verify-phase9-policy.sh",
  "scripts/apply-operator-override.js",
  "scripts/apply-remediation-delta.js",
  "scripts/generate-phase9-artifacts.js",
  "tests/security/_phase9-helpers.js",
  "tests/security/phase9-compliance-monitor.test.js",
  "tests/security/phase9-drift-detector.test.js",
  "tests/security/phase9-remediation-recommender.test.js",
  "tests/security/phase9-override-ledger.test.js",
  "tests/security/phase9-completeness-validator.test.js",
  "tests/security/phase9-policy-gate.test.js",
  "docs/phase9-governance-automation.md"
]);

const PHASE10_REQUIRED = Object.freeze([
  "workflows/observability/metrics-schema.js",
  "workflows/observability/telemetry-emitter.js",
  "workflows/observability/slo-alert-engine.js",
  "workflows/observability/alert-router.js",
  "workflows/observability/operational-decision-ledger.js",
  "workflows/runbook-automation/runbook-orchestrator.js",
  "workflows/incident-management/incident-artifact-creator.js",
  "workflows/incident-management/escalation-orchestrator.js",
  "workflows/attestation/external-attestation-anchor.js",
  "security/phase10-startup-integrity.js",
  "security/phase10-attestation-egress-allowlist.json",
  "scripts/runbook-orchestrator.js",
  "scripts/incident-trigger.sh",
  "scripts/external-attestation-anchor.js",
  "scripts/generate-phase10-artifacts.js",
  "scripts/verify-phase10-policy.sh",
  "tests/security/_phase10-helpers.js",
  "tests/security/phase10-metrics-schema.test.js",
  "tests/security/phase10-telemetry-emitter.test.js",
  "tests/security/phase10-slo-alert-engine.test.js",
  "tests/security/phase10-runbook-orchestrator.test.js",
  "tests/security/phase10-alert-router.test.js",
  "tests/security/phase10-incident-artifact-creator.test.js",
  "tests/security/phase10-escalation-orchestrator.test.js",
  "tests/security/phase10-external-attestation-anchor.test.js",
  "tests/security/phase10-policy-gate.test.js",
  "tests/security/phase10-startup-integrity.test.js",
  "docs/phase10-operational-runbook.md"
]);

const PHASE11_REQUIRED = Object.freeze([
  "workflows/recovery-assurance/recovery-schema.js",
  "workflows/recovery-assurance/recovery-common.js",
  "workflows/recovery-assurance/checkpoint-coordinator.js",
  "workflows/recovery-assurance/backup-manifest-manager.js",
  "workflows/recovery-assurance/backup-integrity-verifier.js",
  "workflows/recovery-assurance/restore-orchestrator.js",
  "workflows/recovery-assurance/continuity-slo-engine.js",
  "workflows/recovery-assurance/chaos-drill-simulator.js",
  "workflows/recovery-assurance/failover-readiness-validator.js",
  "security/phase11-startup-integrity.js",
  "scripts/create-recovery-checkpoint.js",
  "scripts/verify-backup-integrity.js",
  "scripts/execute-restore.js",
  "scripts/run-recovery-drill.js",
  "scripts/generate-phase11-artifacts.js",
  "scripts/verify-phase11-policy.sh",
  "tests/security/phase11-recovery-schema.test.js",
  "tests/security/phase11-checkpoint-coordinator.test.js",
  "tests/security/phase11-backup-manifest-manager.test.js",
  "tests/security/phase11-backup-integrity-verifier.test.js",
  "tests/security/phase11-restore-orchestrator.test.js",
  "tests/security/phase11-continuity-slo-engine.test.js",
  "tests/security/phase11-chaos-drill-simulator.test.js",
  "tests/security/phase11-failover-readiness-validator.test.js",
  "tests/security/phase11-policy-gate.test.js",
  "tests/security/phase11-startup-integrity.test.js",
  "docs/phase11-recovery-assurance.md"
]);

const PHASE12_REQUIRED = Object.freeze([
  "workflows/supply-chain/supply-chain-schema.js",
  "workflows/supply-chain/supply-chain-common.js",
  "workflows/supply-chain/sbom-generator.js",
  "workflows/supply-chain/dependency-integrity-verifier.js",
  "workflows/supply-chain/build-provenance-attestor.js",
  "workflows/supply-chain/dependency-update-governor.js",
  "workflows/supply-chain/vulnerability-reporter.js",
  "workflows/supply-chain/supply-chain-policy-engine.js",
  "workflows/supply-chain/artifact-signing-manager.js",
  "security/phase12-startup-integrity.js",
  "security/known-good-dependencies.json",
  "security/vulnerability-advisories.json",
  "security/artifact-signing-key.sample.json",
  "security/supply-chain-policy.json",
  "scripts/generate-sbom.js",
  "scripts/verify-dependency-integrity.js",
  "scripts/generate-build-provenance.js",
  "scripts/approve-dependency-update.js",
  "scripts/scan-vulnerabilities.js",
  "scripts/sign-artifact.js",
  "scripts/verify-artifact-signature.js",
  "scripts/generate-phase12-artifacts.js",
  "scripts/verify-phase12-policy.sh",
  "tests/security/_phase12-helpers.js",
  "tests/security/phase12-supply-chain-schema.test.js",
  "tests/security/phase12-sbom-generator.test.js",
  "tests/security/phase12-dependency-integrity-verifier.test.js",
  "tests/security/phase12-build-provenance-attestor.test.js",
  "tests/security/phase12-dependency-update-governor.test.js",
  "tests/security/phase12-vulnerability-reporter.test.js",
  "tests/security/phase12-supply-chain-policy-engine.test.js",
  "tests/security/phase12-artifact-signing-manager.test.js",
  "tests/security/phase12-policy-gate.test.js",
  "tests/security/phase12-startup-integrity.test.js",
  "docs/phase12-supply-chain-security.md",
  "audit/evidence/supply-chain/supply-chain-schema.json",
  "audit/evidence/supply-chain/sbom-sample.json",
  "audit/evidence/supply-chain/dependency-integrity-results.json",
  "audit/evidence/supply-chain/build-provenance-sample.json",
  "audit/evidence/supply-chain/dependency-update-plan-sample.json",
  "audit/evidence/supply-chain/dependency-update-approval-sample.json",
  "audit/evidence/supply-chain/vulnerability-report-sample.json",
  "audit/evidence/supply-chain/supply-chain-policy-results.json",
  "audit/evidence/supply-chain/artifact-signature-sample.json",
  "audit/evidence/supply-chain/artifact-verification-sample.json",
  "audit/evidence/supply-chain/phase12-policy-gate-results.json",
  "audit/evidence/supply-chain/hash-manifest.json"
]);

const PHASE13_REQUIRED = Object.freeze([
  "workflows/access-control/access-control-schema.js",
  "workflows/access-control/access-control-common.js",
  "workflows/access-control/role-permission-registry.js",
  "workflows/access-control/scope-registry.js",
  "workflows/access-control/token-lifecycle-manager.js",
  "workflows/access-control/access-decision-ledger.js",
  "workflows/access-control/permission-boundary-enforcer.js",
  "workflows/access-control/privilege-escalation-detector.js",
  "workflows/access-control/session-governance-manager.js",
  "workflows/access-control/legacy-access-bridge.js",
  "security/phase13-startup-integrity.js",
  "security/rbac-policy.json",
  "security/scope-registry.json",
  "security/token-store.sample.json",
  "scripts/_phase13-access-utils.js",
  "scripts/issue-token.js",
  "scripts/rotate-token.js",
  "scripts/revoke-token.js",
  "scripts/validate-token.js",
  "scripts/list-active-tokens.js",
  "scripts/create-session.js",
  "scripts/validate-session.js",
  "scripts/check-access.js",
  "scripts/detect-escalation.js",
  "scripts/generate-phase13-artifacts.js",
  "scripts/verify-phase13-policy.sh",
  "tests/security/_phase13-helpers.js",
  "tests/security/phase13-access-control-schema.test.js",
  "tests/security/phase13-role-permission-registry.test.js",
  "tests/security/phase13-scope-registry.test.js",
  "tests/security/phase13-token-lifecycle-manager.test.js",
  "tests/security/phase13-permission-boundary-enforcer.test.js",
  "tests/security/phase13-privilege-escalation-detector.test.js",
  "tests/security/phase13-access-decision-ledger.test.js",
  "tests/security/phase13-session-governance-manager.test.js",
  "tests/security/phase13-policy-gate.test.js",
  "tests/security/phase13-startup-integrity.test.js",
  "docs/phase13-access-control-governance.md",
  "audit/evidence/access-control/access-control-schema.json",
  "audit/evidence/access-control/rbac-policy-snapshot.json",
  "audit/evidence/access-control/scope-registry-snapshot.json",
  "audit/evidence/access-control/token-issuance-sample.json",
  "audit/evidence/access-control/token-rotation-sample.json",
  "audit/evidence/access-control/token-revocation-sample.json",
  "audit/evidence/access-control/access-decision-sample.json",
  "audit/evidence/access-control/access-decision-ledger-sample.json",
  "audit/evidence/access-control/permission-boundary-results.json",
  "audit/evidence/access-control/escalation-detection-sample.json",
  "audit/evidence/access-control/session-governance-sample.json",
  "audit/evidence/access-control/phase13-policy-gate-results.json",
  "audit/evidence/access-control/hash-manifest.json"
]);

const PHASE14_REQUIRED = Object.freeze([
  "config/agent-config.json",
  "config/llm-providers.json",
  "openclaw-bridge/core/agent-engine.js",
  "openclaw-bridge/core/governance-bridge.js",
  "openclaw-bridge/core/supervisor-authority.js",
  "openclaw-bridge/core/llm-adapter.js",
  "openclaw-bridge/core/interaction-log.js",
  "openclaw-bridge/core/task-definition-schema.js",
  "openclaw-bridge/core/research-output-manager.js",
  "security/phase14-startup-integrity.js",
  "scripts/_phase14-agent-utils.js",
  "scripts/verify-phase14-baseline.js",
  "scripts/run-research-task.js",
  "scripts/list-research-tasks.js",
  "scripts/view-research-output.js",
  "scripts/view-interaction-log.js",
  "scripts/test-llm-connection.js",
  "scripts/generate-phase14-artifacts.js",
  "scripts/verify-phase14-policy.sh",
  "tests/core/_phase14-helpers.js",
  "tests/core/phase14-llm-adapter.test.js",
  "tests/core/phase14-interaction-log.test.js",
  "tests/core/phase14-task-definition.test.js",
  "tests/core/phase14-research-output.test.js",
  "tests/core/phase14-governance-bridge.test.js",
  "tests/core/phase14-agent-engine.test.js",
  "tests/core/phase14-supervisor-authority.test.js",
  "tests/security/phase14-policy-gate.test.js",
  "tests/security/phase14-startup-integrity.test.js",
  "docs/phase14-agent-engine.md",
  "audit/evidence/agent-engine/schema-snapshot.json",
  "audit/evidence/agent-engine/mock-task-execution-sample.json",
  "audit/evidence/agent-engine/interaction-log-sample.json",
  "audit/evidence/agent-engine/research-output-sample.json",
  "audit/evidence/agent-engine/governance-bridge-sample.json",
  "audit/evidence/agent-engine/phase14-gate-results.json",
  "audit/evidence/agent-engine/hash-manifest.json"
]);

const PHASE15_REQUIRED = Object.freeze([
  "config/agent-topology.json",
  "config/autonomy-ladder.json",
  "openclaw-bridge/core/agent-registry.js",
  "openclaw-bridge/core/role-router.js",
  "openclaw-bridge/core/lane-queue.js",
  "openclaw-bridge/core/comms-bus.js",
  "openclaw-bridge/core/autonomy-ladder.js",
  "openclaw-bridge/core/heartbeat-state.js",
  "scripts/verify-phase15-policy.sh",
  "tests/core/phase15-lane-queue.test.js",
  "tests/security/phase15-policy-gate.test.js",
  "docs/phase15-multi-agent-topology.md",
  "audit/evidence/multi-agent-topology/queue-order-sample.json",
  "audit/evidence/multi-agent-topology/hash-manifest.json"
]);

const PHASE16_REQUIRED = Object.freeze([
  "integrations/mcp/mcp-client.js",
  "integrations/mcp/arxiv-client.js",
  "integrations/mcp/semantic-scholar-client.js",
  "workflows/research-ingestion/ingestion-pipeline.js",
  "workflows/research-ingestion/normalizer.js",
  "workflows/research-ingestion/citation-metrics.js",
  "workflows/research-ingestion/source-ledger.js",
  "scripts/verify-phase16-policy.sh",
  "tests/core/phase16-ingestion-pipeline.test.js",
  "tests/security/phase16-policy-gate.test.js",
  "docs/phase16-mcp-ingestion.md",
  "audit/evidence/research-ingestion/source-ledger-sample.json",
  "audit/evidence/research-ingestion/hash-manifest.json"
]);

const PHASE17_REQUIRED = Object.freeze([
  "openclaw-bridge/execution/tool-image-catalog.js",
  "openclaw-bridge/execution/container-runtime.js",
  "openclaw-bridge/state/persistent-store.js",
  "openclaw-bridge/state/state-hydrator.js",
  "openclaw-bridge/state/open-loop-manager.js",
  "openclaw-bridge/core/restart-resume-orchestrator.js",
  "state/runtime/state.sample.json",
  "scripts/verify-phase17-policy.sh",
  "tests/core/phase17-resume-orchestrator.test.js",
  "tests/security/phase17-policy-gate.test.js",
  "docs/phase17-runtime-hardening-and-resume.md",
  "audit/evidence/runtime-resume/resume-sample.json",
  "audit/evidence/runtime-resume/hash-manifest.json"
]);

const PHASE18_REQUIRED = Object.freeze([
  "config/agent-spawner.json",
  "config/mission-templates.json",
  "security/skill-registry.lock.json",
  "openclaw-bridge/core/mission-envelope-schema.js",
  "openclaw-bridge/core/agent-spawner.js",
  "openclaw-bridge/core/spawn-planner.js",
  "openclaw-bridge/core/spawn-orchestrator.js",
  "openclaw-bridge/core/skill-provider.js",
  "openclaw-bridge/core/skill-providers/openclaw-skill-provider.js",
  "openclaw-bridge/core/skill-providers/openai-skill-provider.js",
  "scripts/_research-runtime.js",
  "scripts/verify-phase18-policy.sh",
  "tests/core/phase18-agent-spawner.test.js",
  "tests/core/phase18-skill-provider.test.js",
  "tests/core/phase18-runtime-compat.test.js",
  "tests/security/phase18-policy-gate.test.js",
  "docs/phase18-agent-spawner.md",
  "audit/evidence/mission-orchestration/mission-sample.json",
  "audit/evidence/mission-orchestration/hash-manifest.json",
  "workspace/missions/.gitkeep"
]);

const CLINE_REQUIRED = Object.freeze([
  "docs/supervisor-architecture.md",
  ".clinerules",
  "security/cline-extension-allowlist.json",
  "scripts/verify-cline-supervisor-policy.sh"
]);

const CONTRADICTION_RULES = Object.freeze([
  {
    id: "supervisor-boundary-contradiction",
    file: "docs/supervisor-architecture.md",
    pattern: /supervisor may execute protected mutations|is a privileged mutation executor/i,
    message: "Supervisor boundary contradiction detected"
  },
  {
    id: "operator-only-weakening",
    file: "docs/supervisor-architecture.md",
    pattern: /approval token optional|without operator approval/i,
    message: "Operator-only boundary weakening detected"
  },
  {
    id: "kill-switch-bypass-language",
    file: "docs/failure-modes.md",
    pattern: /kill-switch bypass|ignore kill-switch/i,
    message: "Kill-switch bypass language detected"
  }
]);

function missingFromSet(rootDir, files) {
  const out = [];
  for (const rel of files) {
    if (!fs.existsSync(path.join(rootDir, rel))) {
      out.push(rel);
    }
  }
  return out;
}

function phaseStatus(name, missing) {
  return {
    phase: name,
    complete: missing.length === 0,
    missing_artifacts: stableSortStrings(missing)
  };
}

function createPhaseCompletenessValidator(options = {}) {
  const allPhaseBaselines = options.allPhaseBaselines && typeof options.allPhaseBaselines === "object"
    ? options.allPhaseBaselines
    : {};
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  function validatePhaseCompleteness(input = {}) {
    const rootDir = path.resolve(safeString(input.rootDir) || process.cwd());

    const phase2Missing = missingFromSet(rootDir, PHASE2_REQUIRED);
    const phase3Missing = missingFromSet(rootDir, PHASE3_REQUIRED);
    const phase4Missing = missingFromSet(rootDir, PHASE4_REQUIRED);
    const phase5Missing = missingFromSet(rootDir, PHASE5_REQUIRED);
    const phase6Missing = missingFromSet(rootDir, PHASE6_REQUIRED);
    const phase7Missing = missingFromSet(rootDir, PHASE7_REQUIRED);
    const phase8Missing = missingFromSet(rootDir, PHASE8_REQUIRED);
    const phase9Missing = missingFromSet(rootDir, PHASE9_REQUIRED);
    const phase10Missing = missingFromSet(rootDir, PHASE10_REQUIRED);
    const phase11Missing = missingFromSet(rootDir, PHASE11_REQUIRED);
    const phase12Missing = missingFromSet(rootDir, PHASE12_REQUIRED);
    const phase13Missing = missingFromSet(rootDir, PHASE13_REQUIRED);
    const phase14Missing = missingFromSet(rootDir, PHASE14_REQUIRED);
    const phase15Missing = missingFromSet(rootDir, PHASE15_REQUIRED);
    const phase16Missing = missingFromSet(rootDir, PHASE16_REQUIRED);
    const phase17Missing = missingFromSet(rootDir, PHASE17_REQUIRED);
    const phase18Missing = missingFromSet(rootDir, PHASE18_REQUIRED);
    const clineMissing = missingFromSet(rootDir, CLINE_REQUIRED);

    const workflowText = readTextIfExists(path.join(rootDir, PHASE2_GATE_MANIFEST));
    const buildVerifyText = readTextIfExists(path.join(rootDir, "scripts/build-verify.sh"));
    const packageText = readTextIfExists(path.join(rootDir, "package.json"));

    const contradictions = [];

    for (const rule of CONTRADICTION_RULES) {
      const content = readTextIfExists(path.join(rootDir, rule.file));
      const hit = content.match(rule.pattern);
      if (!hit) {
        continue;
      }
      contradictions.push(canonicalize({
        id: rule.id,
        file: rule.file,
        line: findLineNumber(content, hit[0]),
        message: rule.message
      }));
    }

    if (workflowText.includes("if [[ -f scripts/verify-phase")) {
      contradictions.push(canonicalize({
        id: "policy-gate-silent-skip",
        file: PHASE2_GATE_MANIFEST,
        line: findLineNumber(workflowText, "if [[ -f scripts/verify-phase"),
        message: "Conditional skip logic for policy gates is not allowed"
      }));
    }

    for (const marker of [
      "bash scripts/verify-cline-supervisor-policy.sh",
      "bash scripts/verify-phase8-policy.sh",
      "bash scripts/verify-phase9-policy.sh",
      "bash scripts/verify-phase10-policy.sh",
      "bash scripts/verify-phase11-policy.sh",
      "bash scripts/verify-phase12-policy.sh",
      "bash scripts/verify-phase13-policy.sh",
      "bash scripts/verify-phase14-policy.sh",
      "bash scripts/verify-phase15-policy.sh",
      "bash scripts/verify-phase16-policy.sh",
      "bash scripts/verify-phase17-policy.sh",
      "bash scripts/verify-phase18-policy.sh"
    ]) {
      if (!workflowText.includes(marker)) {
        contradictions.push(canonicalize({
          id: "policy-gate-not-blocking-workflow",
          file: PHASE2_GATE_MANIFEST,
          line: findLineNumber(workflowText, "phase2-gates"),
          message: `Missing blocking workflow gate marker: ${marker}`
        }));
      }
      if (!buildVerifyText.includes(marker)) {
        contradictions.push(canonicalize({
          id: "policy-gate-not-blocking-build-verify",
          file: "scripts/build-verify.sh",
          line: findLineNumber(buildVerifyText, "verify-phase8-policy.sh"),
          message: `Missing build-verify gate marker: ${marker}`
        }));
      }
      if (!packageText.includes(marker.replace("bash ", ""))) {
        contradictions.push(canonicalize({
          id: "policy-gate-not-blocking-package",
          file: "package.json",
          line: findLineNumber(packageText, "phase2:gates"),
          message: `Missing package gate marker: ${marker.replace("bash ", "")}`
        }));
      }
    }

    const phaseStatuses = [
      phaseStatus("phase2", phase2Missing),
      phaseStatus("phase3", phase3Missing),
      phaseStatus("phase4", phase4Missing),
      phaseStatus("phase5", phase5Missing),
      phaseStatus("phase6", phase6Missing),
      phaseStatus("phase7", phase7Missing),
      phaseStatus("phase8", phase8Missing),
      phaseStatus("phase9", phase9Missing),
      phaseStatus("phase10", phase10Missing),
      phaseStatus("phase11", phase11Missing),
      phaseStatus("phase12", phase12Missing),
      phaseStatus("phase13", phase13Missing),
      phaseStatus("phase14", phase14Missing),
      phaseStatus("phase15", phase15Missing),
      phaseStatus("phase16", phase16Missing),
      phaseStatus("phase17", phase17Missing),
      phaseStatus("phase18", phase18Missing),
      phaseStatus("cline", clineMissing)
    ];

    const missingArtifacts = stableSortStrings([
      ...phase2Missing,
      ...phase3Missing,
      ...phase4Missing,
      ...phase5Missing,
      ...phase6Missing,
      ...phase7Missing,
      ...phase8Missing,
      ...phase9Missing,
      ...phase10Missing,
      ...phase11Missing,
      ...phase12Missing,
      ...phase13Missing,
      ...phase14Missing,
      ...phase15Missing,
      ...phase16Missing,
      ...phase17Missing,
      ...phase18Missing,
      ...clineMissing
    ]);

    const result = canonicalize({
      compliant: missingArtifacts.length === 0 && contradictions.length === 0,
      missing_artifacts: missingArtifacts,
      contradictions: contradictions
        .slice()
        .sort((left, right) => {
          const leftFile = safeString(left.file);
          const rightFile = safeString(right.file);
          if (leftFile !== rightFile) {
            return leftFile.localeCompare(rightFile);
          }
          return Number(left.line || 1) - Number(right.line || 1);
        }),
      phase_status: phaseStatuses,
      baseline_reference: {
        commit: safeString(allPhaseBaselines.baselineCommit),
        ci_run: safeString(allPhaseBaselines.baselineCiRunId)
      }
    });

    logger.info({
      event: "phase9_completeness_validation_complete",
      compliant: result.compliant,
      missingArtifacts: result.missing_artifacts.length,
      contradictions: result.contradictions.length
    });

    return result;
  }

  return Object.freeze({
    validatePhaseCompleteness
  });
}

module.exports = {
  createPhaseCompletenessValidator,
  PHASE2_REQUIRED,
  PHASE3_REQUIRED,
  PHASE4_REQUIRED,
  PHASE5_REQUIRED,
  PHASE6_REQUIRED,
  PHASE7_REQUIRED,
  PHASE8_REQUIRED,
  PHASE9_REQUIRED,
  PHASE10_REQUIRED,
  PHASE11_REQUIRED,
  PHASE12_REQUIRED,
  PHASE13_REQUIRED,
  PHASE14_REQUIRED,
  PHASE15_REQUIRED,
  PHASE16_REQUIRED,
  PHASE17_REQUIRED,
  PHASE18_REQUIRED,
  CLINE_REQUIRED,
  CONTRADICTION_RULES
};
