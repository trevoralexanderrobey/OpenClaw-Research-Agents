"use strict";

const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");
const {
  SPAWN_PLAN_SCHEMA_VERSION,
  validateMissionEnvelope
} = require("./mission-envelope-schema.js");

function createSpawnPlanner(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const config = options.config && typeof options.config === "object" ? options.config : {};
  const missionTemplates = options.missionTemplates && typeof options.missionTemplates === "object" ? options.missionTemplates : { templates: {} };
  const agentTopology = options.agentTopology && typeof options.agentTopology === "object" ? options.agentTopology : { roles: [] };
  const skillProvider = options.skillProvider;

  if (!skillProvider || typeof skillProvider.resolveSkills !== "function") {
    throw new Error("skillProvider.resolveSkills is required");
  }

  function getTemplate(templateId) {
    const templates = missionTemplates.templates && typeof missionTemplates.templates === "object" ? missionTemplates.templates : {};
    return templates[templateId] || null;
  }

  function assertTemplateEnabled(template) {
    if (!template) {
      const error = new Error("Mission template not found");
      error.code = "PHASE18_MISSION_TEMPLATE_NOT_FOUND";
      throw error;
    }
    if (template.enabled !== true) {
      const error = new Error(`Mission template '${safeString(template.id)}' is disabled`);
      error.code = "PHASE18_MISSION_TEMPLATE_DISABLED";
      throw error;
    }
    if (!["research_only", "draft_artifact"].includes(safeString(template.safety_class || template.safetyClass))) {
      const error = new Error(`Mission template '${safeString(template.id)}' is not enabled for Phase 18`);
      error.code = "PHASE18_TEMPLATE_CLASS_DENIED";
      throw error;
    }
  }

  function buildDeterministicAgents(missionEnvelope, template) {
    const roles = Array.isArray(template.spawned_roles) ? template.spawned_roles.slice() : [];
    return canonicalize(
      roles
        .map((role, index) => canonicalize({
          agent_id: `${missionEnvelope.mission_id}:${safeString(role)}:${index + 1}`,
          role: safeString(role),
          order: index + 1,
          lane_key: `${missionEnvelope.mission_id}:${safeString(role)}`,
          mission_id: missionEnvelope.mission_id
        }))
        .sort((left, right) => left.agent_id.localeCompare(right.agent_id))
    );
  }

  function buildDeterministicLanes(missionEnvelope, agents) {
    const lanes = agents.map((agent, index) => canonicalize({
      lane_key: safeString(agent.lane_key),
      mission_id: missionEnvelope.mission_id,
      role: safeString(agent.role),
      order: index + 1,
      concurrency_key: `${missionEnvelope.mission_id}:${safeString(agent.role)}`,
      max_inflight: 1
    }));
    return canonicalize(lanes.sort((left, right) => left.lane_key.localeCompare(right.lane_key)));
  }

  function buildSubtasks(missionEnvelope, template, agents) {
    const steps = Array.isArray(template.steps) ? template.steps.slice() : [];
    return canonicalize(
      steps
        .map((step, index) => {
          const role = safeString(step.role);
          const agent = agents.find((entry) => entry.role === role);
          const dependsOn = Array.isArray(step.depends_on)
            ? step.depends_on.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0).sort((left, right) => left - right)
            : [];
          return canonicalize({
            subtask_id: `${missionEnvelope.mission_id}:subtask:${index + 1}`,
            mission_id: missionEnvelope.mission_id,
            agent_id: agent ? agent.agent_id : `${missionEnvelope.mission_id}:${role}:1`,
            role,
            order: index + 1,
            lane_key: agent ? agent.lane_key : `${missionEnvelope.mission_id}:${role}`,
            concurrency_key: `${missionEnvelope.mission_id}:${role}`,
            action_type: safeString(step.action_type || step.actionType),
            task_type: safeString(step.task_type || step.taskType),
            description: safeString(step.description) || `${missionEnvelope.description} (${role})`,
            output_format: safeString(step.output_format || step.outputFormat) || "markdown",
            input_strategy: safeString(step.input_strategy || step.inputStrategy) || "mission_inputs",
            depends_on: dependsOn.map((value) => `${missionEnvelope.mission_id}:subtask:${value}`),
            status: "queued",
            constraints: canonicalize({
              mission_id: missionEnvelope.mission_id,
              template_id: missionEnvelope.template_id,
              role
            })
          });
        })
        .sort((left, right) => left.subtask_id.localeCompare(right.subtask_id))
    );
  }

  function buildPlan(missionInput = {}, context = {}) {
    const missionEnvelope = validateMissionEnvelope(missionInput);
    const template = getTemplate(missionEnvelope.template_id);
    assertTemplateEnabled(template);

    const declaredRoles = Array.isArray(agentTopology.roles) ? agentTopology.roles.map((entry) => safeString(entry)).filter(Boolean) : [];
    for (const role of Array.isArray(template.spawned_roles) ? template.spawned_roles : []) {
      if (!declaredRoles.includes(safeString(role))) {
        const error = new Error(`Template role '${safeString(role)}' is not declared in topology`);
        error.code = "PHASE18_TEMPLATE_ROLE_UNDECLARED";
        throw error;
      }
    }

    const skills = skillProvider.resolveSkills(missionEnvelope, context);
    const agents = buildDeterministicAgents(missionEnvelope, template);
    const lanes = buildDeterministicLanes(missionEnvelope, agents);
    const subtasks = buildSubtasks(missionEnvelope, template, agents);
    const synthesis = canonicalize({
      final_subtask_id: subtasks.length > 0 ? subtasks[subtasks.length - 1].subtask_id : "",
      output_artifact: "artifacts/final-output.json"
    });

    const plan = canonicalize({
      schema_version: SPAWN_PLAN_SCHEMA_VERSION,
      planner_version: safeString(config.plannerVersion) || "phase18-planner-v1",
      mission: missionEnvelope,
      template: canonicalize({
        id: safeString(template.id),
        safety_class: safeString(template.safety_class || template.safetyClass)
      }),
      agents,
      lanes,
      skills,
      subtasks,
      synthesis
    });

    logger.info({ event: "phase18_spawn_plan_built", mission_id: missionEnvelope.mission_id, subtask_count: subtasks.length });
    return plan;
  }

  return Object.freeze({
    buildPlan
  });
}

module.exports = {
  createSpawnPlanner
};
