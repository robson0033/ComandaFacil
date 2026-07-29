"use strict";

const crypto = require("crypto");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function csrfProtection(req, res, next) {
  const expected = String(req.session?.csrfToken || "");
  const supplied = String(req.body?._csrf || req.get("x-csrf-token") || "");
  const valid = expected.length === supplied.length
    && expected.length > 0
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  if (!valid) return res.status(403).send("Requisição não autorizada.");
  return next();
}

function normalizeOrigin(value) {
  if (!String(value || "").trim()) return null;
  try {
    const parsed = new URL(String(value).trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return "invalida";
    return parsed.origin;
  } catch {
    return "invalida";
  }
}

function isLocalOrigin(origin) {
  if (!origin || origin === "invalida") return false;
  const hostname = new URL(origin).hostname.toLowerCase();
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1";
}

function configuredOrigins(env = process.env) {
  const production = String(env.NODE_ENV || "").toLowerCase() === "production";
  const values = [
    env.APP_URL,
    ...String(env.ALLOWED_ORIGINS || "").split(","),
  ].map(value => String(value || "").trim()).filter(Boolean);
  return new Set(
    values.map(normalizeOrigin).filter(origin =>
      origin
      && origin !== "invalida"
      && (!production || !isLocalOrigin(origin))
      && (!production || new URL(origin).protocol === "https:")
    ),
  );
}

function createCsrfSameOriginProtection({
  env = process.env,
  logger = console,
} = {}) {
  const allowed = configuredOrigins(env);
  return function csrfSameOriginProtection(req, res, next) {
    const method = String(req.method || "").toUpperCase();
    if (isSafeHttpMethod(method)) return next();
    if (!MUTATING_METHODS.has(method)) {
      return res.status(405).send("Método não permitido.");
    }

    const originHeader = req.get?.("origin");
    const refererHeader = req.get?.("referer");
    const origin = normalizeOrigin(originHeader);
    const refererOrigin = originHeader ? null : normalizeOrigin(refererHeader);
    const sourceOrigin = origin || refererOrigin;
    if (
      sourceOrigin
      && sourceOrigin !== "invalida"
      && allowed.has(sourceOrigin)
    ) {
      return csrfProtection(req, res, next);
    }

    logger.warn?.("csrf_origin_blocked", {
      code: "CSRF_ORIGIN_BLOCKED",
      method,
      path: String(req.originalUrl || req.path || "").slice(0, 300),
      origin: origin || "ausente",
      refererOrigin: refererOrigin || "ausente",
    });
    return res.status(403).send("Origem da requisição não autorizada.");
  };
}

const csrfSameOriginProtection = createCsrfSameOriginProtection();

function isSafeHttpMethod(method) {
  return SAFE_METHODS.has(String(method || "").toUpperCase());
}

function isMutatingMethod(method) {
  return MUTATING_METHODS.has(String(method || "").toUpperCase());
}

function assertCsrfConfiguration(env = process.env) {
  if (!configuredOrigins(env).size) {
    throw new Error("APP_URL ou ALLOWED_ORIGINS válido é obrigatório para CSRF.");
  }
}

module.exports = {
  assertCsrfConfiguration,
  configuredOrigins,
  createCsrfSameOriginProtection,
  ensureCsrfToken,
  isMutatingMethod,
  isSafeHttpMethod,
  isLocalOrigin,
  normalizeOrigin,
  csrfProtection,
  csrfSameOriginProtection,
};
