"use strict";

const { canonicalize } = require("../../workflows/governance-automation/common.js");
const { createOpenClawSkillProvider } = require("./skill-providers/openclaw-skill-provider.js");
const { createOpenAiSkillProvider } = require("./skill-providers/openai-skill-provider.js");

function createSkillProvider(options = {}) {
  const localProvider = options.localProvider || createOpenClawSkillProvider(options);
  const hostedProvider = options.hostedProvider || createOpenAiSkillProvider(options);
  const skillConfig = options.skillConfig && typeof options.skillConfig === "object" ? options.skillConfig : {};
  const lock = options.skillLock && typeof options.skillLock === "object" ? options.skillLock : {};

  function resolveSkills(input = {}, context = {}) {
    const localSkills = localProvider.resolveLocalSkills(input.local_skills || input.localSkills || [], skillConfig, lock, context);
    const hostedSkillRefs = hostedProvider.resolveHostedSkillRefs(input.hosted_skill_refs || input.hostedSkillRefs || [], {
      hostedSkillsEnabled: skillConfig.hostedSkillsEnabled === true && lock.hostedSkillsEnabled === true
    }, localSkills);

    return canonicalize({
      local_skills: localSkills,
      hosted_skill_refs: hostedSkillRefs
    });
  }

  return Object.freeze({
    resolveSkills,
    listAvailableSkills: () => localProvider.listAvailableSkills(skillConfig.sources || {})
  });
}

module.exports = {
  createSkillProvider
};
