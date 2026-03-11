"use strict";

const { createManualPlaceholderAdapter } = require("./manual-placeholder-adapter.js");

function createAdapter() {
  return createManualPlaceholderAdapter({
    platform_target: "gumroad",
    adapter_id: "phase21.manual.gumroad",
    adapter_version: "phase21-manual-v1"
  });
}

module.exports = {
  createAdapter
};
