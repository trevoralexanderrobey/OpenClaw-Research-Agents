"use strict";

const { formatDraftMarkdown } = require("./formatting-engine.js");

const REQUIRED_MARKERS = Object.freeze([
  "# AI-Assisted RLHF Draft (Human Review Required)",
  "## Source Metadata",
  "## Target Prompt",
  "## Golden Response",
  "## Grading Rubric",
  "## Reviewer Checklist",
  "## Manual Submission Reminder"
]);

const FORBIDDEN_PHRASES = Object.freeze([
  "hide ai assistance",
  "conceal ai",
  "impersonate a human",
  "evade detection",
  "mask synthetic origin",
  "stealth submit",
  "automatic submission",
  "autonomous submission"
]);

const FORBIDDEN_PAYLOAD_FIELDS = Object.freeze([
  "submissionendpoint",
  "platformapiurl",
  "platformapitoken",
  "autosubmit",
  "autonomoussubmit",
  "browserautomation",
  "loginautomation",
  "credential",
  "password"
]);

function addError(errors, code, message, details) {
  errors.push({
    code,
    message,
    details: typeof details === "undefined" ? null : details
  });
}

function findMarkerOrderViolations(markdown) {
  const indexes = REQUIRED_MARKERS.map((marker) => markdown.indexOf(marker));
  const missing = REQUIRED_MARKERS.filter((_, idx) => indexes[idx] === -1);
  const outOfOrder = indexes.some((value, idx) => {
    if (value === -1 || idx === 0) {
      return false;
    }
    const prev = indexes[idx - 1];
    return prev !== -1 && value < prev;
  });

  return {
    missing,
    outOfOrder
  };
}

function collectForbiddenPayloadFields(payload, pathPrefix = "") {
  const hits = [];
  if (!payload || typeof payload !== "object") {
    return hits;
  }

  for (const [key, value] of Object.entries(payload)) {
    const joined = `${pathPrefix}${key}`;
    const normalized = String(key || "").toLowerCase();
    if (FORBIDDEN_PAYLOAD_FIELDS.includes(normalized)) {
      hits.push(joined);
    }
    if (value && typeof value === "object") {
      hits.push(...collectForbiddenPayloadFields(value, `${joined}.`));
    }
  }

  return hits;
}

function lintDraft(input = {}) {
  const markdown = String(input.markdown || "");
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const draftRecord = input.draftRecord && typeof input.draftRecord === "object" ? input.draftRecord : {};
  const errors = [];

  if (!markdown.includes("AI-assisted") && !markdown.includes("AI-Assisted")) {
    addError(errors, "RLHF_LINT_MISSING_AI_DISCLAIMER", "Draft is missing required AI-assistance disclosure.");
  }
  if (!markdown.includes("human") || !markdown.toLowerCase().includes("review")) {
    addError(errors, "RLHF_LINT_MISSING_HUMAN_REVIEW_REQUIREMENT", "Draft is missing required human-review-required language.");
  }

  const markerCheck = findMarkerOrderViolations(markdown);
  if (markerCheck.missing.length > 0) {
    addError(errors, "RLHF_LINT_MISSING_REQUIRED_SECTION", "Draft is missing required markdown sections.", {
      missing: markerCheck.missing
    });
  }
  if (markerCheck.outOfOrder) {
    addError(errors, "RLHF_LINT_SECTION_ORDER_INVALID", "Draft sections are not in the required order.");
  }

  const lower = markdown.toLowerCase();
  const forbiddenMatches = FORBIDDEN_PHRASES.filter((phrase) => lower.includes(phrase));
  if (forbiddenMatches.length > 0) {
    addError(errors, "RLHF_LINT_FORBIDDEN_LANGUAGE", "Draft contains forbidden concealment/evasion language.", {
      matches: forbiddenMatches
    });
  }

  const forbiddenPayloadFields = collectForbiddenPayloadFields(payload);
  if (forbiddenPayloadFields.length > 0) {
    addError(errors, "RLHF_LINT_FORBIDDEN_PAYLOAD_FIELD", "Workflow payload contains forbidden external submission fields.", {
      fields: forbiddenPayloadFields
    });
  }

  const replayMarkdown = formatDraftMarkdown(payload, {
    templateVersion: typeof input.templateVersion === "string" ? input.templateVersion : "v1"
  });
  if (replayMarkdown !== markdown) {
    addError(errors, "RLHF_LINT_NON_DETERMINISTIC_RENDER", "Rendered markdown does not match deterministic re-render.");
  }

  if (draftRecord.aiAssisted !== true || draftRecord.manualSubmissionRequired !== true) {
    addError(errors, "RLHF_LINT_DISCLOSURE_FLAGS_INVALID", "Draft record flags must enforce aiAssisted=true and manualSubmissionRequired=true.");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

module.exports = {
  lintDraft,
  REQUIRED_MARKERS,
  FORBIDDEN_PHRASES
};
