#!/usr/bin/env node
"use strict";

const { buildResearchRuntime, resolveAgentConfig } = require("./_research-runtime.js");

async function buildPhase14Runtime(options = {}) {
  return buildResearchRuntime(options);
}

module.exports = {
  buildPhase14Runtime,
  resolveAgentConfig
};
