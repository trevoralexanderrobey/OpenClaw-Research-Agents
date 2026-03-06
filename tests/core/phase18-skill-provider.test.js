"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createSkillProvider } = require("../../openclaw-bridge/core/skill-provider.js");

async function makeSkill(dir, id, description) {
  const target = path.join(dir, id);
  await fsp.mkdir(target, { recursive: true });
  await fsp.writeFile(path.join(target, "SKILL.md"), `name: ${id}\ndescription: ${description}\n`, "utf8");
}

test("phase18 skill provider fails closed on duplicate local skill ids without lock selection", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase18-skills-"));
  await makeSkill(path.join(root, "skills"), "duplicate-skill", "bundled");
  await makeSkill(path.join(root, "workspace", "skills"), "duplicate-skill", "workspace");

  const provider = createSkillProvider({
    rootDir: root,
    skillConfig: {
      hostedSkillsEnabled: false,
      sources: {
        bundled: ["skills"],
        shared: [],
        workspace: ["workspace/skills"]
      }
    },
    skillLock: {
      hostedSkillsEnabled: false,
      workspaceOverridesAllowed: [],
      skills: []
    }
  });

  assert.throws(
    () => provider.resolveSkills({ local_skills: [{ id: "duplicate-skill" }] }, {}),
    (error) => error && error.code === "PHASE18_SKILL_CONFLICT"
  );
});

test("phase18 skill provider honors explicit lockfile selection for workspace override", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase18-skills-"));
  await makeSkill(path.join(root, "skills"), "shared-skill", "bundled");
  await makeSkill(path.join(root, "workspace", "skills"), "shared-skill", "workspace");

  const provider = createSkillProvider({
    rootDir: root,
    skillConfig: {
      hostedSkillsEnabled: false,
      sources: {
        bundled: ["skills"],
        shared: [],
        workspace: ["workspace/skills"]
      }
    },
    skillLock: {
      hostedSkillsEnabled: false,
      workspaceOverridesAllowed: [],
      skills: [{ id: "shared-skill", source: "workspace" }]
    }
  });

  const resolved = provider.resolveSkills({
    local_skills: [{ id: "shared-skill", tool_grants: ["collect_sources", "plan_mission"] }]
  }, {
    roleAllowlist: ["collect_sources"]
  });

  assert.equal(resolved.local_skills.length, 1);
  assert.equal(resolved.local_skills[0].source, "workspace");
  assert.deepEqual(resolved.local_skills[0].effective_tool_grants, ["collect_sources"]);
});

test("phase18 skill provider keeps hosted skill refs disabled by default", () => {
  const provider = createSkillProvider({
    rootDir: process.cwd(),
    skillConfig: {
      hostedSkillsEnabled: false,
      sources: { bundled: [], shared: [], workspace: [] }
    },
    skillLock: {
      hostedSkillsEnabled: false,
      workspaceOverridesAllowed: [],
      skills: []
    }
  });

  assert.throws(
    () => provider.resolveSkills({
      local_skills: [],
      hosted_skill_refs: [{ id: "hosted-skill", ref: "openai://skill/hosted-skill" }]
    }, {}),
    (error) => error && error.code === "PHASE18_HOSTED_SKILLS_DISABLED"
  );
});
