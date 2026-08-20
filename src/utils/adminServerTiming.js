"use strict";

const { performance } = require("node:perf_hooks");

const HEADER_NAME = "Server-Timing";

function parseBoolean(value) {
  return ["1", "true", "yes", "sim", "on"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

function isExactAdminDocument(req) {
  if (String(req?.method || "GET").toUpperCase() !== "GET") return false;
  const pathname = String(req?.originalUrl || req?.url || "")
    .split("?")[0]
    .replace(/\/+$/, "") || "/";
  return pathname === "/admin";
}

function isEnabled(req, env = process.env) {
  if (!isExactAdminDocument(req)) return false;
  if (String(env.NODE_ENV || "").trim().toLowerCase() === "production") {
    return parseBoolean(env.ADMIN_SERVER_TIMING_ENABLED);
  }
  return true;
}

function now() {
  return performance.now();
}

function getState(req) {
  return req?.adminServerTiming || null;
}

function ensureState(req) {
  if (!req.adminServerTiming) {
    req.adminServerTiming = {
      startedAt: now(),
      marks: Object.create(null),
      durations: Object.create(null),
    };
  }
  return req.adminServerTiming;
}

function setDuration(req, name, durationMs) {
  const state = getState(req);
  if (!state) return;
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value < 0) return;
  state.durations[name] = value;
}

function beginStage(req, name) {
  const state = getState(req);
  if (!state) return;
  state.marks[`${name}Start`] = now();
}

function endStage(req, name) {
  const state = getState(req);
  const startedAt = state?.marks?.[`${name}Start`];
  if (startedAt == null) return;
  setDuration(req, name, now() - startedAt);
}

function beginRequest(req, res, next) {
  if (isEnabled(req)) ensureState(req);
  next();
}

function beforeSession(req, res, next) {
  beginStage(req, "session");
  next();
}

function afterSession(req, res, next) {
  endStage(req, "session");
  next();
}

async function measureAsync(req, name, task) {
  const state = getState(req);
  if (!state) return task();
  const startedAt = now();
  try {
    return await task();
  } finally {
    setDuration(req, name, now() - startedAt);
  }
}

function formatMetric(name, value, description) {
  const safeName = String(name || "metric").replace(/[^a-zA-Z0-9_-]/g, "_");
  const ms = Math.max(0, Number(value) || 0).toFixed(2);
  const desc = String(description || "")
    .replace(/["\\]/g, "")
    .slice(0, 80);
  return desc
    ? `${safeName};dur=${ms};desc="${desc}"`
    : `${safeName};dur=${ms}`;
}

function buildHeader(req) {
  const state = getState(req);
  if (!state) return "";
  const d = state.durations || {};
  const metrics = [
    ["session", d.session, "Sessao Mongo"],
    ["auth", d.auth, "Autenticacao"],
    ["assinatura", d.assinatura, "Assinatura e estado da loja"],
    ["config", d.config, "Configuracao do painel"],
    ["reads", d.reads, "Leituras iniciais Mongo"],
    ["dashboard", d.dashboard, "Agregacao do Dashboard"],
    ["controller", d.controller, "Controller antes do render"],
    ["render", d.render, "Render EJS"],
    ["total", d.total, "Tempo medido no servidor"],
  ].filter(([, value]) => Number.isFinite(Number(value)));

  return metrics.map(([name, value, desc]) => formatMetric(name, value, desc)).join(", ");
}

function wrapAdminRender(req, res, next) {
  const state = getState(req);
  if (!state) return next();

  const originalRender = res.render.bind(res);
  res.render = function timedRender(view, options, callback) {
    if (view !== "admin-real" || typeof callback === "function") {
      return originalRender(view, options, callback);
    }

    endStage(req, "controller");
    const renderStartedAt = now();
    return originalRender(view, options, (error, html) => {
      setDuration(req, "render", now() - renderStartedAt);
      setDuration(req, "total", now() - state.startedAt);
      const header = buildHeader(req);
      if (header && !res.headersSent) res.setHeader(HEADER_NAME, header);
      if (error) return next(error);
      return res.send(html);
    });
  };
  return next();
}

module.exports = {
  afterSession,
  beforeSession,
  beginRequest,
  beginStage,
  buildHeader,
  endStage,
  isEnabled,
  measureAsync,
  setDuration,
  wrapAdminRender,
};
