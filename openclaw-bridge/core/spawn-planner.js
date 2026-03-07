"use strict";

const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");
const { TASK_TYPES } = require("./task-definition-schema.js");
const {
  SPAWN_PLAN_SCHEMA_VERSION,
  validateMissionEnvelope
} = require("./mission-envelope-schema.js");

const ALLOWED_INPUT_STRATEGIES = Object.freeze(["mission_inputs", "mission_and_dependency_outputs", "dependency_outputs"]);

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

  function validateTemplateStructure(template, declaredRoles) {
    const steps = Array.isArray(template.steps) ? template.steps : [];
    const spawnedRoles = Array.isArray(template.spawned_roles) ? template.spawned_roles.map((entry) => safeString(entry)).filter(Boolean) : [];
    for (const role of spawnedRoles) {
      if (!declaredRoles.includes(role)) {
        const error = new Error(`Template role '${role}' is not declared in topology`);
        error.code = "PHASE18_TEMPLATE_ROLE_UNDECLARED";
        throw error;
      }
    }

    for (const [index, step] of steps.entries()) {
      const role = safeString(step.role);
      const actionType = safeString(step.action_type || step.actionType);
      const taskType = safeString(step.task_type || step.taskType);
      const inputStrategy = safeString(step.input_strategy || step.inputStrategy) || "mission_inputs";
      if (!role || !spawnedRoles.includes(role)) {
        const error = new Error(`Template step ${index + 1} references undeclared role '${role || "(empty)"}'`);
        error.code = "PHASE18_TEMPLATE_STEP_ROLE_INVALID";
        throw error;
      }
      if (!actionType) {
        const error = new Error(`Template step ${index + 1} is missing action_type`);
        error.code = "PHASE18_TEMPLATE_STEP_ACTION_REQUIRED";
        throw error;
      }
      if (!TASK_TYPES.includes(taskType)) {
        const error = new Error(`Template step ${index + 1} uses unsupported task_type '${taskType || "(empty)"}'`);
        error.code = "PHASE18_TEMPLATE_STEP_TASK_TYPE_INVALID";
        throw error;
      }
      if (!ALLOWED_INPUT_STRATEGIES.includes(inputStrategy)) {
        const error = new Error(`Template step ${index + 1} uses unsupported input_strategy '${inputStrategy}'`);
        error.code = "PHASE18_TEMPLATE_STEP_INPUT_STRATEGY_INVALID";
        throw error;
      }
      const dependsOn = Array.isArray(step.depends_on) ? step.depends_on : [];
      for (const dependency of dependsOn) {
        const normalizedDependency = Number(dependency);
        if (!Number.isInteger(normalizedDependency) || normalizedDependency < 1 || normalizedDependency >= index + 1) {
          const error = new Error(`Template step ${index + 1} has invalid depends_on reference '${String(dependency)}'`);
          error.code = "PHASE18_TEMPLATE_STEP_DEPENDENCY_INVALID";
          throw error;
        }
      }
    }
  }

  function laneMaxInflightForRole(template, role) {
    const templateLane = template && template.lane_max_inflight && typeof template.lane_max_inflight === "object"
      ? Number(template.lane_max_inflight[role] || 0)
      : 0;
    const roleDefaultMax = config && config.laneDefaults && config.laneDefaults.perRoleMax && typeof config.laneDefaults.perRoleMax === "object"
      ? Number(config.laneDefaults.perRoleMax[role] || 0)
      : 0;
    const roleDefaultLegacy = config && config.laneDefaults && config.laneDefaults.perRole && typeof config.laneDefaults.perRole === "object"
      ? Number(config.laneDefaults.perRole[role] || 0)
      : 0;
    const globalDefault = Number(config && config.defaultLaneMaxInflight || 0);
    const maxInflight = templateLane || roleDefaultMax || roleDefaultLegacy || globalDefault || 1;
    return Math.max(1, maxInflight);
  }

  function laneMinInflightForRole(template, role) {
    const templateLane = template && template.lane_min_inflight && typeof template.lane_min_inflight === "object"
      ? Number(template.lane_min_inflight[role] || 0)
      : 0;
    const roleDefaultMin = config && config.laneDefaults && config.laneDefaults.perRoleMin && typeof config.laneDefaults.perRoleMin === "object"
      ? Number(config.laneDefaults.perRoleMin[role] || 0)
      : 0;
    const globalDefault = Number(config && config.defaultLaneMinInflight || 0);
    const minInflight = templateLane || roleDefaultMin || globalDefault || 1;
    return Math.max(1, minInflight);
  }

  function normalizeNonNegativeInteger(value, fallback = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return Math.max(0, Math.floor(Number(fallback) || 0));
    }
    return Math.max(0, Math.floor(parsed));
  }

  function normalizePositiveInteger(value, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return Math.max(1, Math.floor(Number(fallback) || 1));
    }
    return Math.max(1, Math.floor(parsed));
  }

  function normalizeBoolean(value, fallback = false) {
    if (typeof value === "boolean") {
      return value;
    }
    const text = safeString(value).toLowerCase();
    if (text === "true") {
      return true;
    }
    if (text === "false") {
      return false;
    }
    return Boolean(fallback);
  }

  function resolveRuntimeConfig(missionEnvelope, template) {
    const constraints = missionEnvelope && missionEnvelope.constraints && typeof missionEnvelope.constraints === "object"
      ? missionEnvelope.constraints
      : {};
    const missionExecutionConfig = config && config.missionExecution && typeof config.missionExecution === "object"
      ? config.missionExecution
      : {};
    const checkpointConfig = config && config.checkpointing && typeof config.checkpointing === "object"
      ? config.checkpointing
      : {};
    const laneScalingConfig = config && config.laneScaling && typeof config.laneScaling === "object"
      ? config.laneScaling
      : {};
    const templateRuntime = template && template.runtime && typeof template.runtime === "object"
      ? template.runtime
      : {};
    const templateCheckpoint = template && template.checkpointing && typeof template.checkpointing === "object"
      ? template.checkpointing
      : {};
    const templateScaling = template && template.lane_scaling && typeof template.lane_scaling === "object"
      ? template.lane_scaling
      : {};

    return canonicalize({
      mission_max_runtime_ms: normalizeNonNegativeInteger(
        constraints.mission_max_runtime_ms,
        templateRuntime.mission_max_runtime_ms ?? missionExecutionConfig.maxRuntimeMs ?? 0
      ),
      default_subtask_timeout_ms: normalizeNonNegativeInteger(
        constraints.default_subtask_timeout_ms,
        templateRuntime.default_subtask_timeout_ms ?? missionExecutionConfig.defaultSubtaskTimeoutMs ?? 0
      ),
      stall_interval_ms: normalizeNonNegativeInteger(
        constraints.stall_interval_ms,
        templateRuntime.stall_interval_ms ?? missionExecutionConfig.stallIntervalMs ?? 0
      ),
      scheduler_tick_ms: normalizePositiveInteger(
        constraints.scheduler_tick_ms,
        templateRuntime.scheduler_tick_ms ?? missionExecutionConfig.schedulerTickMs ?? 50
      ),
      checkpointing: canonicalize({
        enabled: normalizeBoolean(
          constraints.checkpointing_enabled,
          templateCheckpoint.enabled ?? checkpointConfig.enabled ?? true
        ),
        completed_subtask_threshold: normalizeNonNegativeInteger(
          constraints.checkpoint_completed_subtask_threshold,
          templateCheckpoint.completed_subtask_threshold ?? checkpointConfig.completedSubtaskThreshold ?? 0
        ),
        stage_boundaries: normalizeBoolean(
          constraints.checkpoint_stage_boundaries,
          templateCheckpoint.stage_boundaries ?? checkpointConfig.stageBoundaries ?? true
        )
      }),
      lane_scaling: canonicalize({
        enabled: normalizeBoolean(
          constraints.lane_scaling_enabled,
          templateScaling.enabled ?? laneScalingConfig.enabled ?? true
        ),
        scale_step: normalizePositiveInteger(
          constraints.lane_scale_step,
          templateScaling.scale_step ?? laneScalingConfig.scaleStep ?? 1
        )
      })
    });
  }

  function buildDeterministicAgents(missionEnvelope, template) {
    const roles = Array.isArray(template.spawned_roles) ? template.spawned_roles.slice() : [];
    return canonicalize(roles.map((role, index) => canonicalize({
      agent_id: `${missionEnvelope.mission_id}:${safeString(role)}:${index + 1}`,
      role: safeString(role),
      order: index + 1,
      lane_key: `${missionEnvelope.mission_id}:${safeString(role)}`,
      mission_id: missionEnvelope.mission_id
    })));
  }

  function buildDeterministicLanes(missionEnvelope, template, agents) {
    const lanes = agents.map((agent, index) => canonicalize({
      lane_id: `${missionEnvelope.mission_id}:lane:${index + 1}`,
      lane_key: safeString(agent.lane_key),
      mission_id: missionEnvelope.mission_id,
      role: safeString(agent.role),
      order: index + 1,
      concurrency_key: `${missionEnvelope.mission_id}:${safeString(agent.role)}`,
      min_inflight: laneMinInflightForRole(template, safeString(agent.role)),
      max_inflight: laneMaxInflightForRole(template, safeString(agent.role)),
      initial_inflight: laneMinInflightForRole(template, safeString(agent.role))
    }));
    for (const lane of lanes) {
      if (Number(lane.max_inflight) < Number(lane.min_inflight)) {
        lane.max_inflight = lane.min_inflight;
      }
      lane.initial_inflight = Math.min(Number(lane.max_inflight), Math.max(Number(lane.min_inflight), Number(lane.initial_inflight)));
    }
    return canonicalize(lanes);
  }

  function buildSubtasks(missionEnvelope, template, agents, runtimeConfig) {
    const steps = Array.isArray(template.steps) ? template.steps.slice() : [];
    return canonicalize(steps.map((step, index) => {
      const role = safeString(step.role);
      const agent = agents.find((entry) => entry.role === role);
      const dependsOn = Array.isArray(step.depends_on)
        ? step.depends_on.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0).sort((left, right) => left - right)
        : [];
      const timeoutMs = normalizeNonNegativeInteger(
        step.timeout_ms || step.timeoutMs,
        runtimeConfig.default_subtask_timeout_ms
      );
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
        timeout_ms: timeoutMs,
        status: "queued",
        constraints: canonicalize({
          mission_id: missionEnvelope.mission_id,
          template_id: missionEnvelope.template_id,
          role
        })
      });
    }));
  }

  function buildPlan(missionInput = {}, context = {}) {
    const missionEnvelope = validateMissionEnvelope(missionInput);
    const template = getTemplate(missionEnvelope.template_id);
    assertTemplateEnabled(template);

    const declaredRoles = Array.isArray(agentTopology.roles) ? agentTopology.roles.map((entry) => safeString(entry)).filter(Boolean) : [];
    validateTemplateStructure(template, declaredRoles);

    const skills = skillProvider.resolveSkills(missionEnvelope, context);
    const runtimeConfig = resolveRuntimeConfig(missionEnvelope, template);
    const agents = buildDeterministicAgents(missionEnvelope, template);
    const lanes = buildDeterministicLanes(missionEnvelope, template, agents);
    const subtasks = buildSubtasks(missionEnvelope, template, agents, runtimeConfig);
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
      runtime: runtimeConfig,
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
  ALLOWED_INPUT_STRATEGIES,
  createSpawnPlanner
};
