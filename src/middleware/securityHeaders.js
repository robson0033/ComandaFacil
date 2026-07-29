"use strict";

const crypto = require("crypto");
const {
  safeJsonForHtml,
  safePublicUrl,
} = require("../utils/htmlSecurity");

function buildContentSecurityPolicy({ nonce, production = false }) {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ];
  if (production) {
    directives.push("upgrade-insecure-requests");
  }
  const policy = directives.join("; ");
  if (/(^|;)\s*sandbox(?:\s|;|$)/i.test(policy)) {
    throw new Error("CSP principal não pode conter sandbox.");
  }
  return policy;
}

function isAdministrativeDocument(req) {
  const requestPath = String(req.originalUrl || req.path || "").split("?")[0];
  return requestPath === "/admin"
    || requestPath.startsWith("/admin/")
    || requestPath === "/assinatura"
    || requestPath.startsWith("/assinatura/")
    || requestPath === "/login/logout";
}

function securityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(18).toString("base64");
  const policy = buildContentSecurityPolicy({
    nonce,
    production: process.env.NODE_ENV === "production",
  });
  res.locals ||= {};
  res.locals.cspNonce = nonce;
  res.locals.safeJsonForHtml = safeJsonForHtml;
  res.locals.safePublicUrl = safePublicUrl;
  // Garante uma única política efetiva produzida pela aplicação. Uma política
  // anterior com `sandbox` tornaria a origem do documento opaca.
  res.removeHeader?.("Content-Security-Policy");
  res.removeHeader?.("Content-Security-Policy-Report-Only");
  res.set("Content-Security-Policy", policy);
  res.removeHeader?.("Referrer-Policy");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Resource-Policy", "same-origin");
  if (isAdministrativeDocument(req)) {
    res.set("Cache-Control", "no-store, private");
    res.set("Pragma", "no-cache");
  }
  res.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  next();
}

module.exports = {
  buildContentSecurityPolicy,
  isAdministrativeDocument,
  securityHeaders,
};
