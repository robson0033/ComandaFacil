"use strict";

const session = require("express-session");
const { MongoStore } = require("connect-mongo");

const SESSION_COOKIE_NAME = "comandamix.sid";
const LEGACY_SESSION_COOKIE_NAME = "connect.sid";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_AFTER_SECONDS = 5 * 60;
const ENDED_SESSION_RETENTION_MS = 10 * 60 * 1000;
const MAX_ENDED_SESSIONS = 10_000;
const TOUCH_NOT_FOUND_MESSAGE = "Unable to find the session to touch";

function isSessionTouchNotFound(error) {
  return error instanceof Error && error.message === TOUCH_NOT_FOUND_MESSAGE;
}

function decorateSessionStore(store, {
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (!store || typeof store.touch !== "function" || store.sessionLifecycle) {
    return store;
  }

  const endedSessions = new Map();
  const loggedContexts = new Map();
  const originalTouch = store.touch.bind(store);
  const originalSet = typeof store.set === "function" ? store.set.bind(store) : null;
  const originalDestroy = typeof store.destroy === "function"
    ? store.destroy.bind(store)
    : null;

  function pruneEndedSessions(timestamp) {
    for (const [sid, entry] of endedSessions) {
      if (entry.expiresAt <= timestamp) endedSessions.delete(sid);
    }
    while (endedSessions.size > MAX_ENDED_SESSIONS) {
      endedSessions.delete(endedSessions.keys().next().value);
    }
  }

  function markEnded(sid, context = "unknown") {
    if (!sid) return;
    const timestamp = now();
    pruneEndedSessions(timestamp);
    const existing = endedSessions.get(String(sid));
    endedSessions.set(String(sid), {
      context: existing?.context && context === "unknown"
        ? existing.context
        : (["logout", "regenerated", "expired"].includes(context)
          ? context
          : "unknown"),
      expiresAt: timestamp + ENDED_SESSION_RETENTION_MS,
    });
  }

  function logTouchNotFound(context) {
    const timestamp = now();
    const lastLog = loggedContexts.get(context);
    if (lastLog !== undefined && timestamp - lastLog < 60_000) return;
    loggedContexts.set(context, timestamp);
    logger.warn?.("session_store_event", {
      code: "SESSION_TOUCH_NOT_FOUND",
      contexto: context,
    });
  }

  store.touch = (sid, sessionData, callback = () => {}) => {
    originalTouch(sid, sessionData, error => {
      if (!isSessionTouchNotFound(error)) return callback(error);
      const timestamp = now();
      pruneEndedSessions(timestamp);
      const ended = endedSessions.get(String(sid));
      const context = ended?.context || "expired";
      logTouchNotFound(context);
      return callback(null);
    });
  };
  if (originalSet) {
    store.set = (sid, sessionData, callback = () => {}) => {
      pruneEndedSessions(now());
      if (endedSessions.has(String(sid))) return callback(null);
      return originalSet(sid, sessionData, callback);
    };
  }
  if (originalDestroy) {
    store.destroy = (sid, callback = () => {}) => {
      markEnded(sid, "unknown");
      return originalDestroy(sid, callback);
    };
  }
  store.sessionLifecycle = Object.freeze({
    markEnded,
    isEnded(sid) {
      pruneEndedSessions(now());
      return endedSessions.has(String(sid));
    },
  });
  return store;
}

function markSessionEnding(req, context) {
  req?.sessionStore?.sessionLifecycle?.markEnded(req.sessionID, context);
}

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
    const store = MongoStore.create({
      ...(mongoClient ? { client: mongoClient } : { mongoUrl: mongoUri }),
      collectionName: "sessions",
      ttl: Math.ceil(SESSION_MAX_AGE_MS / 1000),
      autoRemove: "native",
      touchAfter: SESSION_TOUCH_AFTER_SECONDS,
    });
    return decorateSessionStore(store, { logger });
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
    rolling: true,
    secret: config.sessionSecret,
    store,
    cookie: cookieOptions(config.production),
  });
}

function clearSessionCookie(res, production) {
  const options = {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(production),
    path: "/",
  };
  res.clearCookie(SESSION_COOKIE_NAME, options);
  // Compatibilidade temporária: remove o nome padrão criado por versões antigas.
  res.clearCookie(LEGACY_SESSION_COOKIE_NAME, options);
}

module.exports = {
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  SESSION_TOUCH_AFTER_SECONDS,
  clearSessionCookie,
  cookieOptions,
  createSessionMiddleware,
  createSessionStore,
  decorateSessionStore,
  isSessionTouchNotFound,
  markSessionEnding,
};
