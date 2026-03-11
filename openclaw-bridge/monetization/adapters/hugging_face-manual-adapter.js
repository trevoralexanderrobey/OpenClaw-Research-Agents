"use strict";

const { createManualPlaceholderAdapter } = require("./manual-placeholder-adapter.js");

function createAdapter() {
  return createManualPlaceholderAdapter({
    platform_target: "hugging_face",
    adapter_id: "phase21.manual.hugging_face",
    adapter_version: "phase21-manual-v1"
  });
}

module.exports = {
  createAdapter
};
