"use strict";

const { logger: appLogger } = require("./logger");

function canUseFlash(req) {
  return Boolean(req?.session && typeof req.flash === "function");
}

function safeFlash(req, type, message) {
  if (!canUseFlash(req)) return false;
  try {
    req.flash(type, message);
    return true;
  } catch {
    return false;
  }
}

function readFlash(req, type) {
  if (!canUseFlash(req)) return [];
  try {
    const messages = req.flash(type);
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

function saveSessionOrRun(req, callback) {
  if (typeof req?.session?.save !== "function") return callback();
  return req.session.save(error => {
    if (error) {
      appLogger.error("session_save_failed", {
        code: "SESSION_SAVE_FAILED",
        type: String(error.name || "Error").slice(0, 80),
      });
    }
    return callback(error || null);
  });
}

module.exports = {
  canUseFlash,
  readFlash,
  safeFlash,
  saveSessionOrRun,
};
