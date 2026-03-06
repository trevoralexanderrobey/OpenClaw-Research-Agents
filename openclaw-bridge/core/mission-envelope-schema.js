"use strict";

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

const MISSION_ENVELOPE_SCHEMA_VERSION = "phase18-mission-envelope-v1";
const SPAWN_PLAN_SCHEMA_VERSION = "phase18-spawn-plan-v1";
const DEFAULT_MISSION_CREATED_AT = "1970-01-01T00:00:00.000Z";
const MISSION_STATUSES = Object.freeze([
  "draft",
  "supervisor_approved",
  "governance_approved",
  "planning",
  "spawned",
  "running",
  "synthesizing",
  "completed",
  "failed",
  "rejected",
  "paused"
]);
const SUBTASK_STATUSES = Object.freeze([
  "queued",
  "dispatched",
  "running",
  "reported",
  "completed",
  "failed",
  "paused"
]);

function normalizeIso(value) {
  const text = safeString(value);
  if (!text || !Number.isFinite(Date.parse(text))) {
    return DEFAULT_MISSION_CREATED_AT;
  }
  return text;
}

function normalizeInputs(value) {
  const list = Array.isArray(value) ? value : [];
  return canonicalize(
    list
      .map((entry) => {
        if (typeof entry === "string") {
          return { path: safeString(entry), type: "path" };
        }
        if (!entry || typeof entry !== "object") {
          return null;
        }
        return {
          path: safeString(entry.path),
          type: safeString(entry.type) || "path"
        };
      })
      .filter((entry) => entry && entry.path)
      .sort((left, right) => left.path.localeCompare(right.path))
  );
}

function normalizeLocalSkills(value) {
  const list = Array.isArray(value) ? value : [];
  return canonicalize(
    list
      .map((entry) => {
        if (typeof entry === "string") {
          return { id: safeString(entry), source_hint: "" };
        }
        if (!entry || typeof entry !== "object") {
          return null;
        }
        return {
          id: safeString(entry.id),
          source_hint: safeString(entry.source_hint || entry.sourceHint),
          tool_grants: Array.isArray(entry.tool_grants || entry.toolGrants)
            ? (entry.tool_grants || entry.toolGrants).map((grant) => safeString(grant)).filter(Boolean).sort((left, right) => left.localeCompare(right))
            : []
        };
      })
      .filter((entry) => entry && entry.id)
      .sort((left, right) => left.id.localeCompare(right.id))
  );
}

function normalizeHostedSkillRefs(value) {
  const list = Array.isArray(value) ? value : [];
  return canonicalize(
    list
      .map((entry) => {
        if (typeof entry === "string") {
          return { id: safeString(entry), ref: safeString(entry) };
        }
        if (!entry || typeof entry !== "object") {
          return null;
        }
        return {
          id: safeString(entry.id),
          ref: safeString(entry.ref),
          tool_grants: Array.isArray(entry.tool_grants || entry.toolGrants)
            ? (entry.tool_grants || entry.toolGrants).map((grant) => safeString(grant)).filter(Boolean).sort((left, right) => left.localeCompare(right))
            : []
        };
      })
      .filter((entry) => entry && entry.id && entry.ref)
      .sort((left, right) => left.id.localeCompare(right.id))
  );
}

function computeMissionId(source = {}) {
  const canonicalSeed = canonicalize({
    template_id: safeString(source.template_id || source.templateId),
    description: safeString(source.description),
    inputs: normalizeInputs(source.inputs),
    constraints: canonicalize(source.constraints || {}),
    local_skills: normalizeLocalSkills(source.local_skills || source.localSkills),
    hosted_skill_refs: normalizeHostedSkillRefs(source.hosted_skill_refs || source.hostedSkillRefs),
    created_at: normalizeIso(source.created_at || source.createdAt)
  });
  return `mission-${sha256(`phase18-mission-envelope-v1|${JSON.stringify(canonicalSeed)}`).slice(0, 24)}`;
}

function validateMissionEnvelope(input = {}) {
  const description = safeString(input.description);
  const templateId = safeString(input.template_id || input.templateId);
  if (!templateId) {
    const error = new Error("Mission template id is required");
    error.code = "PHASE18_MISSION_TEMPLATE_REQUIRED";
    throw error;
  }
  if (!description || description.length < 3) {
    const error = new Error("Mission description must be at least 3 characters");
    error.code = "PHASE18_MISSION_DESCRIPTION_INVALID";
    throw error;
  }

  return canonicalize({
    schema_version: MISSION_ENVELOPE_SCHEMA_VERSION,
    mission_id: safeString(input.mission_id || input.missionId) || computeMissionId(input),
    template_id: templateId,
    description,
    session_id: safeString(input.session_id || input.sessionId) || safeString(input.mission_id || input.missionId) || computeMissionId(input),
    inputs: normalizeInputs(input.inputs),
    constraints: canonicalize(input.constraints || {}),
    local_skills: normalizeLocalSkills(input.local_skills || input.localSkills),
    hosted_skill_refs: normalizeHostedSkillRefs(input.hosted_skill_refs || input.hostedSkillRefs),
    created_at: normalizeIso(input.created_at || input.createdAt),
    metadata: canonicalize(input.metadata || {})
  });
}

module.exports = {
  DEFAULT_MISSION_CREATED_AT,
  MISSION_ENVELOPE_SCHEMA_VERSION,
  MISSION_STATUSES,
  SPAWN_PLAN_SCHEMA_VERSION,
  SUBTASK_STATUSES,
  computeMissionId,
  normalizeHostedSkillRefs,
  normalizeLocalSkills,
  normalizeInputs,
  validateMissionEnvelope
};
