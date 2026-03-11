"use strict";

const { createManualPlaceholderAdapter } = require("./manual-placeholder-adapter.js");

function createAdapter() {
  return createManualPlaceholderAdapter({
    platform_target: "kaggle",
    adapter_id: "phase21.manual.kaggle",
    adapter_version: "phase21-manual-v1"
  });
}

module.exports = {
  createAdapter
};
