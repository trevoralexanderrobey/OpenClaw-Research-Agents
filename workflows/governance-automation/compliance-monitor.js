"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  verifyComplianceDecisionIntegrity
} = require("../compliance-governance/compliance-decision-ledger.js");
const {
  verifyEvidenceBundleIntegrity
} = require("../compliance-governance/evidence-bundle-builder.js");
const {
  asArray,
  canonicalize,
  hashFile,
  findLineNumber,
  pushViolation,
  readJsonIfExists,
  readTextIfExists,
  safeString,
  sortViolations,
  stableSortStrings,
  PHASE2_GATE_MANIFEST
} = require("./common.js");

const PHASE8_HASH_TARGETS = Object.freeze([
  "workflows/compliance-governance/compliance-schema.js",
  "workflows/compliance-governance/compliance-validator.js",
  "workflows/compliance-governance/runtime-attestation-engine.js",
  "workflows/compliance-governance/evidence-bundle-builder.js",
  "workflows/compliance-governance/release-gate-governor.js",
  "workflows/compliance-governance/compliance-decision-ledger.js"
]);

const CLINE_CONTRACT_FILES = Object.freeze([
  "docs/supervisor-architecture.md",
  ".clinerules",
  "security/cline-extension-allowlist.json",
  ".vscode/extensions.json",
  ".vscode/settings.json"
]);

const CLINE_REQUIRED_MARKERS = Object.freeze([
  "Cline (VSCode Insiders extension) is the supervisor interface",
  "Protected mutations require operator role, scoped approval token, governance transaction wrapper, and kill-switch-open state",
  "No autonomous external submission"
]);

const PHASE8_MUTATION_FILES = Object.freeze([
  "workflows/compliance-governance/runtime-attestation-engine.js",
  "workflows/compliance-governance/evidence-bundle-builder.js",
  "workflows/compliance-governance/release-gate-governor.js"
]);

const NETWORK_MARKERS = Object.freeze([
  ["f", "etch("].join(""),
  ["ax", "ios"].join(""),
  ["https", ".request("].join(""),
  ["http", ".request("].join(""),
  ["play", "wright"].join(""),
  ["puppet", "eer"].join(""),
  ["selen", "ium"].join(""),
  ["web", "driver"].join(""),
  ["browser", ".launch"].join("")
]);

const AUTONOMY_MARKERS = Object.freeze([
  ["auto", "Submit"].join(""),
  ["autonomous", "Submit"].join(""),
  ["submitTo", "Platform"].join(""),
  ["login", "Automation"].join(""),
  ["browser", "Automation"].join(""),
  ["credential", "Store"].join(""),
  ["store", "Credentials"].join("")
]);

function hasMarker(content, marker) {
  return String(content || "").includes(String(marker || ""));
}

function hasNetworkClientMarker(content) {
  return NETWORK_MARKERS.find((marker) => hasMarker(content, marker)) || "";
}

function hasAutonomyMarker(content) {
  return AUTONOMY_MARKERS.find((marker) => hasMarker(content, marker)) || "";
}

function collectJsFiles(rootDir, relativeDir) {
  const start = path.join(rootDir, relativeDir);
  if (!fs.existsSync(start)) {
    return [];
  }
  const output = [];
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) {
        output.push(full);
      }
    }
  }
  return output.sort((left, right) => left.localeCompare(right));
}

function toRelative(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function createComplianceMonitor(options = {}) {
  const phaseBaselines = options.phaseBaselines && typeof options.phaseBaselines === "object" ? options.phaseBaselines : {};
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  function scanComplianceState(input = {}) {
    const rootDir = path.resolve(safeString(input.rootDir) || process.cwd());
    const violations = [];
    const evidence = {
      baseline_commit: safeString(phaseBaselines.baselineCommit),
      checked_files: [],
      phase8_module_hashes: {},
      phase8_integrity: {
        decision_ledger_valid: false,
        evidence_bundle_count: 0
      },
      policy_gates_blocking: false,
      runtime_state_schema_version: null
    };

    for (const rel of CLINE_CONTRACT_FILES) {
      const full = path.join(rootDir, rel);
      evidence.checked_files.push(rel);
      if (!fs.existsSync(full)) {
        pushViolation(violations, {
          id: "cline-contract-file-missing",
          severity: "critical",
          file: rel,
          line: 1,
          clause: "Cline supervisor baseline",
          message: `Required Cline contract file missing: ${rel}`,
          recommended_fix: `Restore ${rel} from frozen baseline`
        });
      }
    }

    const supervisorDocPath = path.join(rootDir, "docs/supervisor-architecture.md");
    const supervisorDoc = readTextIfExists(supervisorDocPath);
    for (const marker of CLINE_REQUIRED_MARKERS) {
      if (!supervisorDoc.includes(marker)) {
        pushViolation(violations, {
          id: "cline-contract-marker-missing",
          severity: "critical",
          file: "docs/supervisor-architecture.md",
          line: findLineNumber(supervisorDoc, "##"),
          clause: "Cline supervisor baseline",
          message: `Missing required Cline contract marker: ${marker}`,
          recommended_fix: `Reinstate required Cline baseline marker: ${marker}`
        });
      }
    }

    const expectedHashes = phaseBaselines.phase8ModuleHashes && typeof phaseBaselines.phase8ModuleHashes === "object"
      ? phaseBaselines.phase8ModuleHashes
      : {};

    if (Object.keys(expectedHashes).length === 0) {
      pushViolation(violations, {
        id: "phase8-baseline-hashes-missing",
        severity: "critical",
        file: "audit/evidence/governance-automation/phase9-baseline-contracts.json",
        line: 1,
        clause: "Phase 8 immutability hash lock",
        message: "Phase 8 baseline hashes are missing from phase baselines",
        recommended_fix: "Regenerate phase9-baseline-contracts.json with phase8ModuleHashes"
      });
    }

    for (const rel of PHASE8_HASH_TARGETS) {
      const full = path.join(rootDir, rel);
      const actual = hashFile(full);
      evidence.phase8_module_hashes[rel] = actual;
      evidence.checked_files.push(rel);
      if (!actual) {
        pushViolation(violations, {
          id: "phase8-module-missing",
          severity: "critical",
          file: rel,
          line: 1,
          clause: "Phase 8 immutable module presence",
          message: `Phase 8 module is missing: ${rel}`,
          recommended_fix: `Restore ${rel} from baseline commit ${safeString(phaseBaselines.baselineCommit)}`
        });
        continue;
      }
      const expected = safeString(expectedHashes[rel]).toLowerCase();
      if (expected && expected !== actual) {
        pushViolation(violations, {
          id: "phase8-module-hash-drift",
          severity: "critical",
          file: rel,
          line: 1,
          clause: "Phase 8 immutable module hash",
          message: `Hash drift detected in ${rel}`,
          recommended_fix: "Reconcile file with frozen baseline or update approved baseline through governance"
        });
      }
    }

    const statePath = path.join(rootDir, "workspace/runtime/state.json");
    const runtimeState = input.state && typeof input.state === "object"
      ? input.state
      : readJsonIfExists(statePath, null);
    if (!runtimeState || typeof runtimeState !== "object") {
      pushViolation(violations, {
        id: "runtime-state-missing",
        severity: "critical",
        file: "workspace/runtime/state.json",
        line: 1,
        clause: "Phase runtime state required",
        message: "workspace/runtime/state.json is missing or invalid",
        recommended_fix: "Restore deterministic runtime state file"
      });
    } else {
      evidence.runtime_state_schema_version = Number(runtimeState.schemaVersion || 0);
      try {
        const result = verifyComplianceDecisionIntegrity(runtimeState);
        evidence.phase8_integrity.decision_ledger_valid = Boolean(result && result.ok);
      } catch (error) {
        pushViolation(violations, {
          id: "phase8-ledger-integrity-failed",
          severity: "critical",
          file: "workspace/runtime/state.json",
          line: 1,
          clause: "Phase 8 decision ledger integrity",
          message: error && error.message ? error.message : "Phase 8 decision ledger integrity check failed",
          recommended_fix: "Repair compliance decision ledger via operator-approved repair flow"
        });
      }

      const bundles = asArray(runtimeState.complianceGovernance && runtimeState.complianceGovernance.evidenceBundles);
      evidence.phase8_integrity.evidence_bundle_count = bundles.length;
      for (const bundle of bundles) {
        try {
          verifyEvidenceBundleIntegrity({ bundle });
        } catch (error) {
          pushViolation(violations, {
            id: "phase8-evidence-integrity-failed",
            severity: "critical",
            file: "workspace/runtime/state.json",
            line: 1,
            clause: "Phase 8 evidence bundle integrity",
            message: error && error.message ? error.message : "Evidence bundle integrity failure",
            recommended_fix: "Rebuild evidence bundle with operator approval"
          });
        }
      }
    }

    const workflowText = readTextIfExists(path.join(rootDir, PHASE2_GATE_MANIFEST));
    const buildVerifyText = readTextIfExists(path.join(rootDir, "scripts/build-verify.sh"));
    const packageText = readTextIfExists(path.join(rootDir, "package.json"));

    const requiredGateMarkers = [
      "bash scripts/verify-cline-supervisor-policy.sh",
      "bash scripts/verify-phase8-policy.sh",
      "bash scripts/verify-phase9-policy.sh"
    ];
    for (const marker of requiredGateMarkers) {
      if (!workflowText.includes(marker)) {
        pushViolation(violations, {
          id: "policy-gate-missing-workflow",
          severity: "critical",
          file: PHASE2_GATE_MANIFEST,
          line: findLineNumber(workflowText, "phase2-gates"),
          clause: "Policy gates must be blocking",
          message: `Missing blocking gate marker in workflow: ${marker}`,
          recommended_fix: `Add unconditional workflow step: ${marker}`
        });
      }
      if (!buildVerifyText.includes(marker)) {
        pushViolation(violations, {
          id: "policy-gate-missing-build-verify",
          severity: "critical",
          file: "scripts/build-verify.sh",
          line: findLineNumber(buildVerifyText, "verify-phase8-policy.sh"),
          clause: "Policy gates must be blocking",
          message: `Missing blocking gate marker in build-verify: ${marker}`,
          recommended_fix: `Add ${marker} to build-verify.sh`
        });
      }
      if (!packageText.includes(marker.replace("bash ", ""))) {
        pushViolation(violations, {
          id: "policy-gate-missing-package-chain",
          severity: "high",
          file: "package.json",
          line: findLineNumber(packageText, "phase2:gates"),
          clause: "Policy gates must be blocking",
          message: `Missing policy script in package gate chain: ${marker}`,
          recommended_fix: `Include ${marker.replace("bash ", "")} in phase2:gates`
        });
      }
    }

    if (workflowText.includes("if [[ -f scripts/verify-phase")) {
      pushViolation(violations, {
        id: "policy-gate-skip-logic-detected",
        severity: "critical",
        file: PHASE2_GATE_MANIFEST,
        line: findLineNumber(workflowText, "if [[ -f scripts/verify-phase"),
        clause: "No silent gate skipping",
        message: "Conditional skip logic detected for policy gates",
        recommended_fix: "Remove conditional gate skip logic"
      });
    }

    for (const rel of PHASE8_MUTATION_FILES) {
      const content = readTextIfExists(path.join(rootDir, rel));
      if (!content) {
        continue;
      }
      for (const marker of ["approvalToken", ["consumeScopedApproval", "Token"].join(""), "assertOperatorRole", "assertKillSwitchOpen", ["withGovernanceTransaction", "("].join("")]) {
        if (!content.includes(marker)) {
          pushViolation(violations, {
            id: "phase8-mutation-guard-missing",
            severity: "critical",
            file: rel,
            line: 1,
            clause: "Approval-token protections on protected mutations",
            message: `Missing required mutation guard '${marker}' in ${rel}`,
            recommended_fix: `Restore ${marker} guard in ${rel}`
          });
        }
      }
    }

    const executionRouterText = readTextIfExists(path.join(rootDir, "openclaw-bridge/src/core/execution-router.ts"));
    const mutationControlText = readTextIfExists(path.join(rootDir, "security/mutation-control.js"));
    const mcpServiceText = readTextIfExists(path.join(rootDir, "openclaw-bridge/mcp/mcp-service.js"));

    if (!executionRouterText.includes("canExecuteTools: false")) {
      pushViolation(violations, {
        id: "kill-switch-or-supervisor-boundary-weakened",
        severity: "critical",
        file: "openclaw-bridge/src/core/execution-router.ts",
        line: 1,
        clause: "Supervisor non-mutation boundary",
        message: "Supervisor non-execution boundary marker missing",
        recommended_fix: "Restore canExecuteTools: false enforcement"
      });
    }
    if (!mutationControlText.includes("requireKillSwitchOpen")) {
      pushViolation(violations, {
        id: "kill-switch-enforcement-missing",
        severity: "critical",
        file: "security/mutation-control.js",
        line: 1,
        clause: "Kill-switch precedence",
        message: "Mutation kill-switch enforcement marker missing",
        recommended_fix: "Restore requireKillSwitchOpen path"
      });
    }
    if (!mcpServiceText.includes("assertOperatorRole")) {
      pushViolation(violations, {
        id: "operator-boundary-missing",
        severity: "critical",
        file: "openclaw-bridge/mcp/mcp-service.js",
        line: 1,
        clause: "Operator-only protected mutation boundary",
        message: "Operator role boundary marker missing in mcp-service",
        recommended_fix: "Restore assertOperatorRole checks for mutation methods"
      });
    }

    const scanFiles = [
      ...collectJsFiles(rootDir, "workflows/compliance-governance"),
      ...collectJsFiles(rootDir, "workflows/governance-automation")
    ];

    for (const full of scanFiles) {
      const content = readTextIfExists(full);
      const rel = toRelative(rootDir, full);
      const networkMarker = hasNetworkClientMarker(content);
      if (networkMarker) {
        pushViolation(violations, {
          id: "autonomous-network-client-detected",
          severity: "critical",
          file: rel,
          line: findLineNumber(content, networkMarker),
          clause: "No autonomous external execution",
          message: "Network/browser automation client marker detected in governance modules",
          recommended_fix: "Remove direct network/browser automation usage from governance modules"
        });
      }
      const autonomyMarker = hasAutonomyMarker(content);
      if (autonomyMarker) {
        pushViolation(violations, {
          id: "autonomy-boundary-marker-detected",
          severity: "critical",
          file: rel,
          line: findLineNumber(content, autonomyMarker),
          clause: "No autonomous login/submission automation",
          message: "Autonomous submission/login marker detected in governance modules",
          recommended_fix: "Remove autonomous submission/login automation logic"
        });
      }
    }

    const policyGatesBlocking = requiredGateMarkers.every((marker) => {
      return workflowText.includes(marker)
        && buildVerifyText.includes(marker)
        && packageText.includes(marker.replace("bash ", ""));
    }) && !workflowText.includes("if [[ -f scripts/verify-phase");

    evidence.checked_files = stableSortStrings(evidence.checked_files);
    evidence.policy_gates_blocking = policyGatesBlocking;

    const sortedViolations = sortViolations(violations);
    const result = canonicalize({
      compliant: sortedViolations.length === 0,
      violations: sortedViolations,
      evidence
    });

    logger.info({
      event: "phase9_compliance_scan_completed",
      compliant: result.compliant,
      violations: result.violations.length
    });

    return result;
  }

  return Object.freeze({
    scanComplianceState
  });
}

module.exports = {
  createComplianceMonitor,
  PHASE8_HASH_TARGETS,
  CLINE_CONTRACT_FILES,
  CLINE_REQUIRED_MARKERS
};
