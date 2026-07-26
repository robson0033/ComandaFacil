"use strict";

const express = require("express");
const appState = require("../runtime/appState");

function createSystemRouter() {
  const router = express.Router();
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
    if (appState.isReady()) return res.status(200).json({ status: "ready" });
    return res.status(503).json({
      status: "not_ready",
      checks: appState.publicReadiness(),
    });
  });
  return router;
}

module.exports = { createSystemRouter };
