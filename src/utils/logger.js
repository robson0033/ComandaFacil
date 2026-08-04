"use strict";

const { isPersonalDataKey, redactPersonalString } = require("./privacy");

const SENSITIVE_KEY = /(authorization|cookie|password|senha|secret|token|connectionstring|mongo(uri)?|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)/i;

function sanitizeString(value, maxLength = 4_000) {
  return redactPersonalString(String(value ?? "")
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "[URI_REMOVIDA]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REMOVIDO]")
    .replace(/((?:token|secret|password|senha|api[_-]?key)\s*[=:]\s*)[^\s,;&]+/gi, "$1[REMOVIDO]"), maxLength);
}

function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;

  if (value instanceof Error) {
    const sanitized = {
      name: sanitizeString(value.name, 80),
      message: sanitizeString(value.message, 1_000),
    };
    if (value.code != null) sanitized.code = sanitizeString(value.code, 120);
    if (value.statusCode != null) sanitized.statusCode = Number(value.statusCode);
    if (process.env.NODE_ENV !== "production" && value.stack) {
      sanitized.stack = sanitizeString(value.stack, 8_000);
    }
    return sanitized;
  }

  if (depth >= 4) return "[PROFUNDIDADE_LIMITADA]";
  if (typeof value !== "object") return sanitizeString(value);
  if (seen.has(value)) return "[REFERENCIA_CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 30).map(item => sanitizeValue(item, depth + 1, seen));
  }

  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 80)) {
    const key = sanitizeString(rawKey, 120);
    result[key] = SENSITIVE_KEY.test(key) || isPersonalDataKey(key)
      ? "[REMOVIDO]"
      : sanitizeValue(rawValue, depth + 1, seen);
  }
  return result;
}

function buildRecord(level, args) {
  const first = args[0];
  const event = typeof first === "string"
    ? sanitizeString(first, 300)
    : "application_log";
  const details = (typeof first === "string" ? args.slice(1) : args)
    .map(value => sanitizeValue(value));
  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(details.length ? { details } : {}),
  };
}

function write(level, args) {
  const line = `${JSON.stringify(buildRecord(level, args))}\n`;
  const stream = level === "error" || level === "warn"
    ? process.stderr
    : process.stdout;
  stream.write(line);
}

const logger = Object.freeze({
  debug(...args) {
    if (process.env.NODE_ENV !== "production") write("debug", args);
  },
  info(...args) { write("info", args); },
  log(...args) { write("info", args); },
  warn(...args) { write("warn", args); },
  error(...args) { write("error", args); },
});

module.exports = {
  buildRecord,
  logger,
  sanitizeString,
  sanitizeValue,
};
