"use strict";

const { operationalAlerts } = require("../services/operationalAlertService");

function integerValue(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function normalizeRoutePath(value) {
  return String(value || "/")
    .split("?")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":uuid")
    .replace(/[0-9a-f]{24}/gi, ":objectId")
    .replace(/\/\d+(?=\/|$)/g, "/:number")
    .slice(0, 240);
}

function createHttp5xxAlertMiddleware({
  alertService = operationalAlerts,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  const threshold = integerValue(env.ALERT_5XX_THRESHOLD, 5, 1, 100);
  const windowMs = integerValue(env.ALERT_5XX_WINDOW_MS, 5 * 60_000, 10_000, 60 * 60_000);
  const buckets = new Map();

  function prune(currentTime) {
    if (buckets.size <= 500) return;
    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.startedAt > windowMs * 2) buckets.delete(key);
      if (buckets.size <= 400) break;
    }
  }

  return function http5xxAlertMiddleware(req, res, next) {
    res.once("finish", () => {
      try {
        const statusCode = Number(res.statusCode || 0);
        const routePath = normalizeRoutePath(req.path || req.originalUrl || req.url);
        if (statusCode < 500 || statusCode > 599) return;
        if (routePath === "/ready" || res.locals?.operationalAlertHandled) return;

        const currentTime = now();
        const method = String(req.method || "GET").toUpperCase().slice(0, 10);
        const key = `${method}:${routePath}:${statusCode}`;
        let bucket = buckets.get(key);
        if (!bucket || currentTime - bucket.startedAt >= windowMs) {
          bucket = { count: 0, startedAt: currentTime, alerted: false };
          buckets.set(key, bucket);
        }
        bucket.count += 1;
        bucket.lastAt = currentTime;

        if (bucket.count >= threshold && !bucket.alerted) {
          bucket.alerted = true;
          alertService.trigger({
            event: "http_5xx_threshold",
            key: `http_5xx:${key}`,
            severity: statusCode === 503 ? "critical" : "error",
            details: {
              method,
              path: routePath,
              statusCode,
              count: bucket.count,
              windowSeconds: Math.round(windowMs / 1000),
              correlationId: String(req.correlationId || "").slice(0, 100) || null,
            },
          });
        }
        prune(currentTime);
      } catch {
        // O monitor nunca pode interferir na resposta da aplicação.
      }
    });
    next();
  };
}

module.exports = {
  createHttp5xxAlertMiddleware,
  normalizeRoutePath,
};
