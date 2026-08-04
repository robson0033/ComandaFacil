"use strict";

const express = require("express");
const appState = require("../runtime/appState");
const { operationalAlerts } = require("../services/operationalAlertService");

function createSystemRouter({
  state = appState,
  alertService = operationalAlerts,
} = {}) {
  const router = express.Router();
  let readinessIncidentOpen = false;
  router.get("/health", (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.status(200).json({
      status: "ok",
      uptime: Number(process.uptime().toFixed(2)),
      timestamp: new Date().toISOString(),
    });
  });
  router.get("/ready", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (state.isReady()) {
      if (readinessIncidentOpen) {
        readinessIncidentOpen = false;
        alertService.resolve({
          event: "readiness_unavailable",
          key: "readiness_unavailable",
          details: { status: "ready" },
        });
      }
      return res.status(200).json({ status: "ready" });
    }
    const checks = state.publicReadiness();
    readinessIncidentOpen = true;
    alertService.trigger({
      event: "readiness_unavailable",
      key: "readiness_unavailable",
      severity: "critical",
      details: {
        status: "not_ready",
        checks,
      },
    });
    if (!res.locals || typeof res.locals !== "object") {
      res.locals = {};
    }
    res.locals.operationalAlertHandled = true;
    return res.status(503).json({
      status: "not_ready",
      checks,
    });
  });
  return router;
}

module.exports = { createSystemRouter };
