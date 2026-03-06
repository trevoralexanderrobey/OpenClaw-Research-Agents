"use strict";

const { canonicalize, safeString } = require("../../../workflows/governance-automation/common.js");

function createOpenAiSkillProvider(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  function resolveHostedSkillRefs(hostedSkillRefs = [], config = {}, localSkills = []) {
    const requested = Array.isArray(hostedSkillRefs) ? hostedSkillRefs : [];
    if (requested.length === 0) {
      return [];
    }
    if (config.hostedSkillsEnabled !== true) {
      const error = new Error("Hosted skill refs are disabled in Phase 18");
      error.code = "PHASE18_HOSTED_SKILLS_DISABLED";
      throw error;
    }

    const localIds = new Set((Array.isArray(localSkills) ? localSkills : []).map((entry) => safeString(entry.id)));
    const resolved = [];
    for (const ref of requested.slice().sort((left, right) => safeString(left.id).localeCompare(safeString(right.id)))) {
      const skillId = safeString(ref.id);
      if (localIds.has(skillId)) {
        const error = new Error(`Hosted skill ref '${skillId}' cannot override local locked skill`);
        error.code = "PHASE18_HOSTED_OVERRIDE_DENIED";
        throw error;
      }
      resolved.push(canonicalize({
        id: skillId,
        ref: safeString(ref.ref),
        effective_tool_grants: Array.isArray(ref.tool_grants)
          ? ref.tool_grants.map((entry) => safeString(entry)).filter(Boolean).sort((left, right) => left.localeCompare(right))
          : []
      }));
    }
    logger.info({ event: "phase18_hosted_skill_refs_resolved", count: resolved.length });
    return canonicalize(resolved);
  }

  return Object.freeze({
    resolveHostedSkillRefs
  });
}

module.exports = {
  createOpenAiSkillProvider
};
