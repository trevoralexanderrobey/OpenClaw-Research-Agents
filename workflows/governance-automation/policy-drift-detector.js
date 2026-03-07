"use strict";

const path = require("node:path");
const {
  canonicalize,
  findLineNumber,
  pushViolation,
  readTextIfExists,
  safeString,
  sortViolations,
  stableSortStrings
} = require("./common.js");

const DEFAULT_CONTRACT_FILES = Object.freeze([
  "docs/supervisor-architecture.md",
  ".clinerules",
  "security/operator-authorization.js",
  "security/mutation-control.js",
  "scripts/build-verify.sh",
  "docs/phase8-compliance-attestation.md",
  "workflows/compliance-governance/evidence-bundle-builder.js",
  "workflows/compliance-governance/compliance-decision-ledger.js"
]);

const DEFAULT_REQUIRED_CLAUSES = Object.freeze([
  {
    id: "supervisor-non-mutation-boundary",
    file: "docs/supervisor-architecture.md",
    text: "Supervisor is orchestration/approval-facing only and is not a privileged mutation executor",
    severity: "critical",
    recommended_fix: "Restore explicit supervisor non-mutation boundary clause"
  },
  {
    id: "operator-approval-token-required",
    file: "docs/supervisor-architecture.md",
    text: "Protected mutations require operator role, scoped approval token, governance transaction wrapper, and kill-switch-open state",
    severity: "critical",
    recommended_fix: "Restore operator approval-token requirement clause"
  },
  {
    id: "kill-switch-precedence",
    file: "security/mutation-control.js",
    text: "requireKillSwitchOpen",
    severity: "critical",
    recommended_fix: "Restore kill-switch precedence enforcement"
  },
  {
    id: "evidence-integrity-claim",
    file: "docs/phase8-compliance-attestation.md",
    text: "All JSON outputs are canonicalized and deterministic",
    severity: "high",
    recommended_fix: "Restore Phase 8 deterministic evidence integrity statement"
  }
]);

const CONTRADICTION_PATTERNS = Object.freeze([
  {
    id: "autonomous-boundary-weakened",
    pattern: /autonomous external submission is enabled|automated login is enabled|supervisor may execute protected mutations/i,
    clause: "Autonomous external boundary",
    severity: "critical",
    recommended_fix: "Remove boundary-weakening language and restore manual-only/operator-only constraints"
  },
  {
    id: "approval-token-scope-relaxed",
    pattern: /approval token optional|bypass approval token|without approval token/i,
    clause: "Approval-token scope consumption",
    severity: "critical",
    recommended_fix: "Reinstate mandatory scoped approval token consumption"
  },
  {
    id: "policy-gate-skip-logic",
    pattern: /if \[\[ -f scripts\/verify-phase|continue-on-error:\s*true/i,
    clause: "Policy gate skip logic",
    severity: "critical",
    recommended_fix: "Remove conditional skip logic and keep policy gates unconditional"
  }
]);

function createPolicyDriftDetector(options = {}) {
  const baselineContracts = options.baselineContracts && typeof options.baselineContracts === "object"
    ? options.baselineContracts
    : {};
  const currentContracts = options.currentContracts && typeof options.currentContracts === "object"
    ? options.currentContracts
    : {};
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  function resolveContractContent(rootDir, file) {
    if (Object.prototype.hasOwnProperty.call(currentContracts, file)) {
      return safeString(currentContracts[file]);
    }
    return readTextIfExists(path.join(rootDir, file));
  }

  function detectDrifts(input = {}) {
    const rootDir = path.resolve(safeString(input.rootDir) || process.cwd());
    const drifts = [];

    const clauses = Array.isArray(baselineContracts.requiredClauses) && baselineContracts.requiredClauses.length > 0
      ? baselineContracts.requiredClauses
      : DEFAULT_REQUIRED_CLAUSES;

    for (const rawClause of clauses) {
      const clause = rawClause && typeof rawClause === "object" ? rawClause : {};
      const file = safeString(clause.file);
      const text = safeString(clause.text);
      if (!file || !text) {
        continue;
      }
      const content = resolveContractContent(rootDir, file);
      if (!content.includes(text)) {
        pushViolation(drifts, {
          id: safeString(clause.id) || "required-clause-missing",
          severity: safeString(clause.severity) || "high",
          file,
          line: findLineNumber(content, "##"),
          clause: safeString(clause.id) || "Required baseline clause",
          message: `Baseline clause missing: ${text}`,
          recommended_fix: safeString(clause.recommended_fix) || "Restore clause from baseline contracts"
        });
      }
    }

    const candidateFiles = new Set([
      ...DEFAULT_CONTRACT_FILES,
      ...Object.keys(currentContracts || {})
    ]);

    for (const rel of candidateFiles) {
      const file = safeString(rel);
      if (!file) {
        continue;
      }
      const content = resolveContractContent(rootDir, file);
      if (!content) {
        continue;
      }
      for (const rule of CONTRADICTION_PATTERNS) {
        const hit = content.match(rule.pattern);
        if (!hit) {
          continue;
        }
        pushViolation(drifts, {
          id: rule.id,
          severity: rule.severity,
          file,
          line: findLineNumber(content, hit[0]),
          clause: rule.clause,
          message: `Policy drift detected for ${rule.clause}`,
          recommended_fix: rule.recommended_fix
        });
      }

      if (file === "security/operator-authorization.js") {
        const consumeApprovalMarker = ["consumeApproval", "Token"].join("");
        if (!content.includes(consumeApprovalMarker)) {
          pushViolation(drifts, {
            id: "approval-token-consumption-missing",
            severity: "critical",
            file,
            line: 1,
            clause: "Approval-token scope consumption",
            message: "operator-authorization is missing approval token consumption API",
            recommended_fix: "Restore approval token consumption enforcement"
          });
        }
      }

      if (file === "workflows/compliance-governance/evidence-bundle-builder.js") {
        if (!content.includes("verifyEvidenceBundleIntegrity") && !content.includes("computeBundleHash")) {
          pushViolation(drifts, {
            id: "evidence-integrity-weakened",
            severity: "critical",
            file,
            line: 1,
            clause: "Evidence integrity or tamper-evident claims",
            message: "Evidence integrity verification markers are missing",
            recommended_fix: "Restore bundle integrity hash verification paths"
          });
        }
      }
    }

    const sortedDrifts = sortViolations(drifts).map((entry) => canonicalize({
      file: entry.file,
      line: Number(entry.line || 1),
      violation_clause: entry.clause,
      severity: entry.severity,
      id: entry.id,
      message: entry.message,
      recommended_fix: entry.recommended_fix
    }));

    const severity = stableSortStrings(sortedDrifts.map((entry) => entry.severity));

    const result = canonicalize({
      drifts: sortedDrifts,
      severity,
      operator_action_required: sortedDrifts.length > 0
    });

    logger.info({
      event: "phase9_policy_drift_detected",
      drifts: result.drifts.length,
      operatorActionRequired: result.operator_action_required
    });

    return result;
  }

  return Object.freeze({
    detectDrifts
  });
}

module.exports = {
  createPolicyDriftDetector,
  DEFAULT_CONTRACT_FILES,
  DEFAULT_REQUIRED_CLAUSES,
  CONTRADICTION_PATTERNS
};
