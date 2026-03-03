"use strict";

const { nowIso } = require("../core/time-provider.js");

function noop() {}

function createContainerAudit(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info: noop, warn: noop, error: noop };
  const metrics = options.metrics && typeof options.metrics === "object" ? options.metrics : { increment: noop, observe: noop, gauge: noop };

  function emit(level, event, details) {
    const payload = {
      event,
      timestamp: nowIso(),
      ...(details || {})
    };
    const fn = typeof logger[level] === "function" ? logger[level] : noop;
    fn(payload);
  }

  return {
    recordStart(details) {
      metrics.increment("container.audit.start", {});
      emit("info", "container_start", details);
    },
    recordStop(details) {
      metrics.increment("container.audit.stop", {});
      emit("info", "container_stop", details);
    },
    recordCrash(details) {
      metrics.increment("container.audit.crash", {});
      emit("error", "container_crash", details);
    },
    recordTimeout(details) {
      metrics.increment("container.audit.timeout", {});
      emit("warn", "container_timeout", details);
    }
  };
}

module.exports = {
  createContainerAudit
};
