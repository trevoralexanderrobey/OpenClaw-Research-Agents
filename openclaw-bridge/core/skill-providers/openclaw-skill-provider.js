"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, safeString } = require("../../../workflows/governance-automation/common.js");

function expandConfiguredPath(rootDir, rawPath) {
  const text = safeString(rawPath);
  if (!text) {
    return "";
  }
  const replacedHome = text.replace(/^~(?=\/|$)/, process.env.HOME || "");
  const replacedCodex = replacedHome.replace(/\$CODEX_HOME/g, safeString(process.env.CODEX_HOME));
  if (path.isAbsolute(replacedCodex)) {
    return path.resolve(replacedCodex);
  }
  return path.resolve(rootDir, replacedCodex);
}

function readSkillMetadata(skillDir) {
  const filePath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const body = fs.readFileSync(filePath, "utf8");
  const lines = body.split("\n");
  let name = "";
  let description = "";
  for (const line of lines.slice(0, 20)) {
    if (!name) {
      const match = line.match(/^name:\s*(.+)$/i);
      if (match) {
        name = safeString(match[1]);
      }
    }
    if (!description) {
      const match = line.match(/^description:\s*(.+)$/i);
      if (match) {
        description = safeString(match[1]);
      }
    }
  }
  return canonicalize({
    id: safeString(path.basename(skillDir)),
    name: name || safeString(path.basename(skillDir)),
    description,
    path: skillDir
  });
}

function listSkillCandidates(rootDir, configuredPaths = [], source) {
  const seen = new Set();
  const found = [];
  for (const configuredPath of configuredPaths) {
    const absolute = expandConfiguredPath(rootDir, configuredPath);
    if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      continue;
    }
    const entries = fs.readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      const skillDir = path.join(absolute, entry);
      const metadata = readSkillMetadata(skillDir);
      if (!metadata) {
        continue;
      }
      const key = `${source}:${metadata.id}:${metadata.path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      found.push(canonicalize({
        ...metadata,
        source
      }));
    }
  }
  found.sort((left, right) => {
    if (left.id !== right.id) return left.id.localeCompare(right.id);
    if (left.source !== right.source) return left.source.localeCompare(right.source);
    return left.path.localeCompare(right.path);
  });
  return canonicalize(found);
}

function createOpenClawSkillProvider(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());

  function listAvailableSkills(config = {}) {
    const bundled = listSkillCandidates(rootDir, Array.isArray(config.bundled) ? config.bundled : [], "bundled");
    const shared = listSkillCandidates(rootDir, Array.isArray(config.shared) ? config.shared : [], "shared");
    const workspace = listSkillCandidates(rootDir, Array.isArray(config.workspace) ? config.workspace : [], "workspace");
    return canonicalize([...bundled, ...shared, ...workspace]);
  }

  function resolveLocalSkills(localSkillRefs = [], config = {}, lock = {}, context = {}) {
    const requested = Array.isArray(localSkillRefs) ? localSkillRefs : [];
    const available = listAvailableSkills(config.sources || {});
    const selections = Array.isArray(lock.skills) ? lock.skills : [];
    const workspaceOverridesAllowed = Array.isArray(lock.workspaceOverridesAllowed)
      ? lock.workspaceOverridesAllowed.map((entry) => safeString(entry)).filter(Boolean)
      : [];
    const resolved = [];

    for (const requestedSkill of requested.slice().sort((left, right) => safeString(left.id).localeCompare(safeString(right.id)))) {
      const skillId = safeString(requestedSkill.id);
      const candidates = available.filter((entry) => entry.id === skillId);
      if (candidates.length === 0) {
        const error = new Error(`Requested local skill '${skillId}' is not available`);
        error.code = "PHASE18_SKILL_NOT_FOUND";
        throw error;
      }

      let selected = null;
      const lockSelection = selections.find((entry) => safeString(entry.id) === skillId);
      if (lockSelection) {
        selected = candidates.find((entry) => entry.source === safeString(lockSelection.source));
        if (!selected) {
          const error = new Error(`Lockfile selection for skill '${skillId}' cannot be satisfied`);
          error.code = "PHASE18_SKILL_LOCK_MISMATCH";
          throw error;
        }
      } else if (candidates.length === 1) {
        selected = candidates[0];
      } else if (
        workspaceOverridesAllowed.includes(skillId)
        && candidates.some((entry) => entry.source === "workspace")
        && candidates.every((entry) => ["workspace", "bundled"].includes(entry.source))
      ) {
        selected = candidates.find((entry) => entry.source === "workspace") || null;
      }

      if (!selected) {
        const error = new Error(`Duplicate local skill id '${skillId}' requires lockfile selection`);
        error.code = "PHASE18_SKILL_CONFLICT";
        throw error;
      }

      const roleAllowlist = Array.isArray(context.roleAllowlist) ? context.roleAllowlist.map((entry) => safeString(entry)).filter(Boolean) : [];
      const requestedGrants = Array.isArray(requestedSkill.tool_grants) ? requestedSkill.tool_grants.map((entry) => safeString(entry)).filter(Boolean) : [];
      const effectiveGrants = requestedGrants.filter((grant) => roleAllowlist.length === 0 || roleAllowlist.includes(grant));
      resolved.push(canonicalize({
        id: selected.id,
        name: selected.name,
        description: selected.description,
        path: selected.path,
        source: selected.source,
        effective_tool_grants: effectiveGrants.sort((left, right) => left.localeCompare(right))
      }));
    }

    logger.info({ event: "phase18_local_skills_resolved", count: resolved.length });
    return canonicalize(resolved);
  }

  return Object.freeze({
    listAvailableSkills,
    resolveLocalSkills
  });
}

module.exports = {
  createOpenClawSkillProvider
};
