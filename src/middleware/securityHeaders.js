"use strict";

const crypto = require("crypto");
const {
  safeJsonForHtml,
  safePublicUrl,
} = require("../utils/htmlSecurity");

function securityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(18).toString("base64");
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ];
  if (process.env.NODE_ENV === "production") {
    directives.push("upgrade-insecure-requests");
  }
  res.locals ||= {};
  res.locals.cspNonce = nonce;
  res.locals.safeJsonForHtml = safeJsonForHtml;
  res.locals.safePublicUrl = safePublicUrl;
  res.set("Content-Security-Policy", directives.join("; "));
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  next();
}

module.exports = { securityHeaders };
