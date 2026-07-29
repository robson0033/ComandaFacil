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
  if (csrfTokenStatus(req) !== "VALIDO") {
    return res.status(403).send("Requisição não autorizada.");
  }
  return next();
}

function csrfTokenStatus(req) {
  const expected = String(req.session?.csrfToken || "");
  const supplied = String(req.body?._csrf || req.get("x-csrf-token") || "");
  if (!supplied) return "CSRF_TOKEN_AUSENTE";
  const valid = expected.length === supplied.length
    && expected.length > 0
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  return valid ? "VALIDO" : "CSRF_TOKEN_INVALIDO";
}

function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean || clean === "null") return null;
  try {
    const parsed = new URL(clean);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isLocalOrigin(origin) {
  if (!origin) return false;
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
  const appOrigin = normalizeOrigin(env.APP_URL);
  const diagnostics = String(env.CSRF_ORIGIN_DIAGNOSTICS || "").toLowerCase()
    === "true";
  return function csrfSameOriginProtection(req, res, next) {
    const method = String(req.method || "").toUpperCase();
    if (isSafeHttpMethod(method)) return next();
    if (!MUTATING_METHODS.has(method)) {
      return res.status(405).send("Método não permitido.");
    }

    const path = String(req.originalUrl || req.path || "").slice(0, 300);
    const originRaw = req.get?.("origin");
    const originPresent = typeof originRaw === "string"
      ? Boolean(originRaw.trim())
      : originRaw !== undefined && originRaw !== null;
    const refererRaw = originPresent ? undefined : req.get?.("referer");
    const refererPresent = typeof refererRaw === "string"
      ? Boolean(refererRaw.trim())
      : refererRaw !== undefined && refererRaw !== null;
    const origin = originPresent ? normalizeOrigin(originRaw) : null;
    const refererOrigin = refererPresent ? normalizeOrigin(refererRaw) : null;
    const sourceOrigin = originPresent ? origin : refererOrigin;
    const matched = Boolean(sourceOrigin && allowed.has(sourceOrigin));

    if (diagnostics) {
      logger.info?.("csrf_origin_diagnostic", {
        code: "CSRF_ORIGIN_DIAGNOSTIC",
        method,
        path,
        originRawType: typeof originRaw,
        originRawLength: typeof originRaw === "string" ? originRaw.length : 0,
        originNormalizada: origin,
        appOriginNormalizada: appOrigin,
        allowedOriginsCount: allowed.size,
        matched,
      });
    }

    let code = "";
    if (!appOrigin) code = "APP_URL_INVALIDA";
    else if (originPresent && !origin) code = "ORIGIN_MALFORMADA";
    else if (originPresent && !matched) code = "ORIGIN_NAO_AUTORIZADA";
    else if (!originPresent && refererPresent && !refererOrigin) {
      code = "REFERER_MALFORMADO";
    } else if (!originPresent && refererPresent && !matched) {
      code = "ORIGIN_NAO_AUTORIZADA";
    } else if (!originPresent && !refererPresent) code = "ORIGIN_AUSENTE";

    const reject = rejectionCode => {
      logger.warn?.("csrf_origin_blocked", {
        code: rejectionCode,
        method,
        path,
      });
      return res.status(403).send(
        rejectionCode.startsWith("CSRF_")
          ? "Requisição não autorizada."
          : "Origem da requisição não autorizada.",
      );
    };
    if (code) return reject(code);

    const tokenStatus = csrfTokenStatus(req);
    if (tokenStatus !== "VALIDO") return reject(tokenStatus);
    return next();
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
  const production = String(env.NODE_ENV || "").toLowerCase() === "production";
  const appOrigin = normalizeOrigin(env.APP_URL);
  if (!appOrigin) throw new Error("APP_URL inválida para CSRF.");
  if (
    production
    && (new URL(appOrigin).protocol !== "https:" || isLocalOrigin(appOrigin))
  ) {
    throw new Error("APP_URL deve usar HTTPS público em produção.");
  }
  const configured = String(env.ALLOWED_ORIGINS || "")
    .split(",").map(value => value.trim()).filter(Boolean);
  for (const raw of configured) {
    const origin = normalizeOrigin(raw);
    if (
      !origin
      || (production && new URL(origin).protocol !== "https:")
      || (production && isLocalOrigin(origin))
    ) {
      throw new Error("ALLOWED_ORIGINS contém origem inválida.");
    }
  }
  return true;
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
  csrfTokenStatus,
  csrfSameOriginProtection,
};
