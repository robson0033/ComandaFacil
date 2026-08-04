"use strict";

const {
  logger: appLogger,
  sanitizeString,
  sanitizeValue,
} = require("../utils/logger");

const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TEXT_LENGTH = 3_500;

function integerEnv(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(env?.[name]);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function safeEventName(value) {
  const normalized = String(value || "operational_alert")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .slice(0, 120);
  return normalized || "operational_alert";
}

function safeSeverity(value) {
  const normalized = String(value || "error").trim().toLowerCase();
  return ["info", "warning", "error", "critical"].includes(normalized)
    ? normalized
    : "error";
}

function compactDetails(details) {
  const sanitized = sanitizeValue(details || {});
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized
    : { value: sanitized };
}

function textSummary(record) {
  const stateLabel = record.state === "resolved" ? "RECUPERADO" : "ALERTA";
  const detailText = JSON.stringify(record.details || {});
  return [
    `[${stateLabel}] ${record.service} (${record.environment})`,
    `Evento: ${record.event}`,
    `Gravidade: ${record.severity}`,
    `Horário: ${record.timestamp}`,
    `Detalhes: ${detailText}`,
  ].join("\n").slice(0, MAX_TEXT_LENGTH);
}

function webhookPayload(url, record) {
  const hostname = String(url.hostname || "").toLowerCase();
  const summary = textSummary(record);
  if (hostname === "discord.com" || hostname.endsWith(".discord.com")
    || hostname === "discordapp.com" || hostname.endsWith(".discordapp.com")) {
    return {
      content: summary.slice(0, 1_900),
      allowed_mentions: { parse: [] },
    };
  }
  if (hostname === "hooks.slack.com" || hostname.endsWith(".hooks.slack.com")) {
    return { text: summary.slice(0, 3_000) };
  }
  return record;
}

function createOperationalAlertService({
  env = process.env,
  logger = appLogger,
  fetchFn = global.fetch,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const incidents = new Map();
  const pending = new Set();

  function config() {
    return {
      url: safeUrl(env.ALERT_WEBHOOK_URL),
      bearerToken: String(env.ALERT_WEBHOOK_BEARER_TOKEN || "").trim(),
      service: sanitizeString(env.ALERT_SERVICE_NAME || "ComandaFacil", 80),
      environment: sanitizeString(
        env.ALERT_ENVIRONMENT || env.NODE_ENV || "unknown",
        80,
      ),
      cooldownMs: integerEnv(env, "ALERT_COOLDOWN_MS", DEFAULT_COOLDOWN_MS, {
        min: 10_000,
        max: 24 * 60 * 60_000,
      }),
      timeoutMs: integerEnv(env, "ALERT_WEBHOOK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, {
        min: 1_000,
        max: 15_000,
      }),
    };
  }

  async function deliver(record) {
    const current = config();
    if (!current.url || typeof fetchFn !== "function") {
      return { ok: false, skipped: true, reason: "channel_not_configured" };
    }

    const controller = new AbortController();
    const timeout = setTimeoutFn(() => controller.abort(), current.timeoutMs);
    timeout.unref?.();
    try {
      const headers = { "content-type": "application/json" };
      if (current.bearerToken) {
        headers.authorization = `Bearer ${current.bearerToken}`;
      }
      const response = await fetchFn(current.url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(webhookPayload(current.url, record)),
        signal: controller.signal,
      });
      if (!response?.ok) {
        logger.error("operational_alert_delivery_failed", {
          event: record.event,
          state: record.state,
          responseStatus: Number(response?.status || 0),
        });
        return {
          ok: false,
          skipped: false,
          status: Number(response?.status || 0),
        };
      }
      logger.info("operational_alert_delivered", {
        event: record.event,
        state: record.state,
        responseStatus: Number(response.status || 200),
      });
      return { ok: true, status: Number(response.status || 200) };
    } catch (error) {
      logger.error("operational_alert_delivery_failed", {
        event: record.event,
        state: record.state,
        errorName: String(error?.name || "Error").slice(0, 80),
        errorMessage: sanitizeString(error?.message || "Falha ao enviar alerta.", 500),
      });
      return { ok: false, skipped: false, error: sanitizeString(error?.message, 300) };
    } finally {
      clearTimeoutFn(timeout);
    }
  }

  function enqueue(record) {
    const promise = deliver(record);
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  }

  function buildRecord({ event, state, severity, details }) {
    const current = config();
    return {
      schemaVersion: 1,
      service: current.service,
      environment: current.environment,
      event: safeEventName(event),
      state,
      severity: safeSeverity(severity),
      timestamp: new Date(now()).toISOString(),
      details: compactDetails(details),
    };
  }

  function trigger({
    event,
    key = event,
    severity = "error",
    details = {},
    cooldownMs,
  } = {}) {
    const normalizedEvent = safeEventName(event);
    const normalizedKey = String(key || normalizedEvent).slice(0, 300);
    const currentTime = now();
    const currentConfig = config();
    const effectiveCooldown = Number.isFinite(Number(cooldownMs))
      ? Math.max(10_000, Number(cooldownMs))
      : currentConfig.cooldownMs;
    const previous = incidents.get(normalizedKey);

    if (previous?.active && currentTime - previous.lastSentAt < effectiveCooldown) {
      return { queued: false, suppressed: true, event: normalizedEvent };
    }

    const record = buildRecord({
      event: normalizedEvent,
      state: "firing",
      severity,
      details,
    });
    incidents.set(normalizedKey, {
      active: true,
      event: normalizedEvent,
      lastSentAt: currentTime,
    });
    logger.error("operational_alert_triggered", record);
    enqueue(record);
    return {
      queued: Boolean(currentConfig.url && typeof fetchFn === "function"),
      suppressed: false,
      event: normalizedEvent,
    };
  }

  function resolve({
    event,
    key = event,
    severity = "info",
    details = {},
  } = {}) {
    const normalizedEvent = safeEventName(event);
    const normalizedKey = String(key || normalizedEvent).slice(0, 300);
    const previous = incidents.get(normalizedKey);
    if (!previous?.active) {
      return { queued: false, suppressed: true, event: normalizedEvent };
    }

    incidents.set(normalizedKey, {
      ...previous,
      active: false,
      resolvedAt: now(),
    });
    const record = buildRecord({
      event: normalizedEvent,
      state: "resolved",
      severity,
      details,
    });
    logger.info("operational_alert_resolved", record);
    enqueue(record);
    const currentConfig = config();
    return {
      queued: Boolean(currentConfig.url && typeof fetchFn === "function"),
      suppressed: false,
      event: normalizedEvent,
    };
  }

  async function flush() {
    const current = [...pending];
    return Promise.all(current);
  }

  function isConfigured() {
    return Boolean(config().url && typeof fetchFn === "function");
  }

  function resetForTests() {
    incidents.clear();
  }

  return Object.freeze({
    flush,
    isConfigured,
    resetForTests,
    resolve,
    trigger,
  });
}

const operationalAlerts = createOperationalAlertService();

module.exports = {
  DEFAULT_COOLDOWN_MS,
  createOperationalAlertService,
  operationalAlerts,
  safeEventName,
  webhookPayload,
};
