"use strict";

const session = require("express-session");
const { MongoStore } = require("connect-mongo");

const SESSION_COOKIE_NAME = "comandamix.sid";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cookieOptions(production) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(production),
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  };
}

function createSessionStore({
  config,
  mongoClient,
  mongoUri,
  logger = console,
}) {
  if (mongoClient || mongoUri) {
    return MongoStore.create({
      ...(mongoClient ? { client: mongoClient } : { mongoUrl: mongoUri }),
      collectionName: "sessions",
      ttl: Math.ceil(SESSION_MAX_AGE_MS / 1000),
      autoRemove: "native",
    });
  }
  if (!config.production && config.allowMemorySession) {
    logger.warn(
      "AVISO: MemoryStore autorizado explicitamente; use apenas em desenvolvimento/teste.",
    );
    return new session.MemoryStore();
  }
  throw new Error("SESSION_STORE indisponível.");
}

function createSessionMiddleware({ config, store }) {
  if (config.production && store instanceof session.MemoryStore) {
    throw new Error("MemoryStore é proibido em produção.");
  }
  return session({
    name: SESSION_COOKIE_NAME,
    proxy: config.production,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    secret: config.sessionSecret,
    store,
    cookie: cookieOptions(config.production),
  });
}

function clearSessionCookie(res, production) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(production),
    path: "/",
  });
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  clearSessionCookie,
  cookieOptions,
  createSessionMiddleware,
  createSessionStore,
};
