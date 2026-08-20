"use strict";

const { logger: appLogger } = require("../utils/logger");

const crypto = require("crypto");
const { clearSessionCookie } = require("../config/sessionConfig");
const { safeFlash } = require("../utils/safeFlash");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isPublicAnonymousCsrfBypassPath(req) {
  const requestPath = String(req.originalUrl || req.path || req.url || "")
    .split("?")[0];
  return requestPath === "/catalogo"
    || requestPath.startsWith("/catalogo/")
    || requestPath === "/mesa"
    || requestPath.startsWith("/mesa/");
}

function ensureCsrfToken(req, res, next) {
  res.locals ||= {};

  // Catálogo e mesa usam proteção anônima de mesma origem + rate limit nas
  // operações mutáveis. Não crie um token CSRF nessas rotas, porque isso
  // transformaria cada visitante anônimo em uma sessão persistida no Mongo.
  // Uma sessão já existente continua disponível e não perde seu estado.
  if (isPublicAnonymousCsrfBypassPath(req)) {
    res.locals.csrfToken = String(req.session?.csrfToken || "");
    return next();
  }

  if (!req.session) {
    res.locals.csrfToken = "";
    return next();
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function csrfProtection(req, res, next) {
  if (!req.session?.user) {
    return respondSessionRequired(req, res);
  }
  if (csrfTokenStatus(req) !== "VALIDO") {
    return res.status(403).send(
      `Operação bloqueada (${csrfTokenStatus(req)}).`,
    );
  }
  return next();
}

function requestKind(req) {
  const accept = String(req.get?.("accept") || "").toLowerCase();
  const contentType = String(req.get?.("content-type") || "").toLowerCase();
  if (accept.includes("text/event-stream")) return "sse";
  if (
    req.xhr
    || accept.includes("application/json")
    || contentType.includes("application/json")
    || String(req.path || "").includes("/api/")
  ) {
    return "api";
  }
  return "html";
}

function respondSessionRequired(req, res) {
  clearSessionCookie(res, process.env.NODE_ENV === "production");
  const kind = requestKind(req);
  if (kind === "sse") {
    res.status(401);
    return res.end();
  }
  if (kind === "api") {
    return res.status(401).json({
      ok: false,
      code: "SESSION_REQUIRED",
      message: "Sessão necessária.",
      correlationId: req.correlationId,
    });
  }
  return res.redirect(303, "/login");
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
  logger = appLogger,
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
    if (!req.session?.user) return respondSessionRequired(req, res);

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
    else if (originPresent && String(originRaw).trim() === "null") {
      code = "ORIGIN_NULL";
    } else if (originPresent && !origin) code = "ORIGIN_MALFORMADA";
    else if (originPresent && !matched) code = "ORIGIN_NAO_AUTORIZADA";
    else if (!originPresent && refererPresent && !refererOrigin) {
      code = "REFERER_MALFORMADO";
    } else if (!originPresent && refererPresent && !matched) {
      code = "ORIGIN_NAO_AUTORIZADA";
    } else if (!originPresent && !refererPresent) code = "ORIGIN_AUSENTE";

    const reject = rejectionCode => {
      logger.warn?.("csrf_origin_blocked", {
        correlationId: req.correlationId,
        code: rejectionCode,
        method,
        path,
        requestType: requestKind(req),
        sessionPresent: Boolean(req.session),
        userAuthenticated: Boolean(req.session?.user),
        tenantPresent: Boolean(
          req.session?.user?.estabelecimentoId || req.session?.user?.id,
        ),
      });
      if (requestKind(req) === "api") {
        return res.status(403).json({
          ok: false,
          code: rejectionCode,
          message: rejectionCode.startsWith("CSRF_")
            ? "Sua sessão mudou ou expirou. Atualize a página."
            : "A origem da solicitação não foi autorizada.",
          correlationId: req.correlationId,
        });
      }
      if (requestKind(req) === "sse") {
        res.status(403);
        return res.end();
      }
      safeFlash(
        req,
        "errors",
        rejectionCode.startsWith("CSRF_")
          ? "Sua sessão mudou ou expirou. Atualize a página e tente novamente."
          : "A origem da solicitação não foi autorizada.",
      );
      if (rejectionCode.startsWith("CSRF_")) {
        return res.redirect(303, "/admin");
      }
      return res.status(403).send(`Operação bloqueada (${rejectionCode}).`);
    };
    if (code) return reject(code);

    const tokenStatus = csrfTokenStatus(req);
    if (tokenStatus !== "VALIDO") return reject(tokenStatus);
    return next();
  };
}

const csrfSameOriginProtection = createCsrfSameOriginProtection();

function createAnonymousSameOriginProtection({
  env = process.env,
  logger = appLogger,
} = {}) {
  const allowed = configuredOrigins(env);
  return function anonymousSameOriginProtection(req, res, next) {
    const method = String(req.method || "").toUpperCase();
    if (isSafeHttpMethod(method)) return next();
    if (!MUTATING_METHODS.has(method)) {
      return res.status(405).send("Método não permitido.");
    }

    /*
     * Rotas públicas (catálogo/mesa) não podem depender da sessão do painel.
     * O proprietário pode sair da conta sem derrubar o catálogo aberto em
     * outra aba ou no celular do cliente. Para essas rotas anônimas, a
     * proteção é feita por origem permitida + rate limit das próprias rotas.
     */
    const originRaw = req.get?.("origin");
    const hasOrigin = typeof originRaw === "string"
      ? Boolean(originRaw.trim())
      : originRaw !== undefined && originRaw !== null;
    const refererRaw = hasOrigin ? "" : req.get?.("referer");
    const sourceOrigin = normalizeOrigin(hasOrigin ? originRaw : refererRaw);
    let code = "";

    if (hasOrigin && String(originRaw).trim() === "null") code = "ORIGIN_NULL";
    else if (!sourceOrigin) code = hasOrigin ? "ORIGIN_MALFORMADA" : "ORIGIN_AUSENTE";
    else if (!allowed.has(sourceOrigin)) code = "ORIGIN_NAO_AUTORIZADA";

    if (!code) return next();

    logger.warn?.("anonymous_origin_blocked", {
      correlationId: req.correlationId,
      code,
      method,
      path: String(req.originalUrl || req.path || "").slice(0, 300),
      requestType: requestKind(req),
      sessionPresent: Boolean(req.session),
    });

    if (requestKind(req) === "api") {
      return res.status(403).json({
        success: false,
        ok: false,
        code,
        message: "A origem da solicitação não foi autorizada.",
        correlationId: req.correlationId,
      });
    }
    return res.status(403).send(`Operação bloqueada (${code}).`);
  };
}

const anonymousSameOriginProtection = createAnonymousSameOriginProtection();

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
  anonymousSameOriginProtection,
  configuredOrigins,
  createAnonymousSameOriginProtection,
  createCsrfSameOriginProtection,
  ensureCsrfToken,
  isPublicAnonymousCsrfBypassPath,
  isMutatingMethod,
  isSafeHttpMethod,
  isLocalOrigin,
  normalizeOrigin,
  requestKind,
  respondSessionRequired,
  csrfProtection,
  csrfTokenStatus,
  csrfSameOriginProtection,
};
