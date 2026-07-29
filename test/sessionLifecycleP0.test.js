"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  SESSION_TOUCH_AFTER_SECONDS,
  clearSessionCookie,
  createSessionMiddleware,
  decorateSessionStore,
  markSessionEnding,
} = require("../src/config/sessionConfig");
const appState = require("../src/runtime/appState");
const loginController = require("../src/controllers/loginControllerReal");
const { encerrarSessao } = require("../src/middleware/auth");

function fakeStore(touchImplementation = (_sid, _session, callback) => callback()) {
  return {
    touch: touchImplementation,
    set(_sid, _session, callback) { callback(); },
    destroy(_sid, callback) { callback(); },
    on() {},
  };
}

function invokeTouch(store, sid = "sid") {
  return new Promise(resolve => {
    store.touch(sid, { cookie: {} }, error => resolve(error));
  });
}

test("aplicação monta uma sessão, um MongoStore e somente comandamix.sid", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  const config = fs.readFileSync(
    path.resolve(__dirname, "../src/config/sessionConfig.js"),
    "utf8",
  );
  assert.equal([...server.matchAll(/app\.use\(sessionMiddleware\)/g)].length, 1);
  assert.equal([...config.matchAll(/MongoStore\.create\(/g)].length, 1);
  assert.equal(SESSION_COOKIE_NAME, "comandamix.sid");
  assert.equal(LEGACY_SESSION_COOKIE_NAME, "connect.sid");
  assert.match(config, /name:\s*SESSION_COOKIE_NAME/);
  assert.match(config, /rolling:\s*true/);
  assert.doesNotMatch(config, /name:\s*["']connect\.sid["']/);
});

test("limpeza de logout remove cookie oficial e legado com path raiz", () => {
  const calls = [];
  clearSessionCookie({
    clearCookie(name, options) { calls.push({ name, options }); },
  }, true);
  assert.deepEqual(calls.map(item => item.name), [
    "comandamix.sid",
    "connect.sid",
  ]);
  for (const call of calls) {
    assert.equal(call.options.path, "/");
    assert.equal(call.options.secure, true);
    assert.equal(call.options.sameSite, "lax");
    assert.equal(call.options.httpOnly, true);
  }
});

test("login regenera e salva antes de redirecionar e encerra SSE antiga", () => {
  appState.resetForTests();
  const events = [];
  const response = {
    writableEnded: false,
    write() {},
    end() { this.writableEnded = true; events.push("sse:end"); },
  };
  appState.registerSse(
    response,
    () => events.push("sse:cleanup"),
    { sessionId: "old-session" },
  );
  const store = decorateSessionStore(fakeStore());
  const req = {
    sessionID: "old-session",
    sessionStore: store,
    session: {
      cookie: {},
      regenerate(callback) {
        events.push("regenerate");
        req.sessionID = "new-session";
        req.session = {
          cookie: {},
          save(saveCallback) {
            events.push("save");
            saveCallback();
          },
        };
        callback();
      },
    },
  };
  const res = {
    clearCookie(name) { events.push(`clear:${name}`); },
    redirect(location) { events.push(`redirect:${location}`); },
    status() { return this; },
    render() { events.push("render"); },
  };
  loginController._testing.autenticarComNovaSessao(
    req,
    res,
    { id: "user" },
    false,
  );
  assert.deepEqual(events, [
    "sse:cleanup",
    "sse:end",
    "regenerate",
    "save",
    "clear:connect.sid",
    "redirect:/admin",
  ]);
  assert.equal(req.session.user.id, "user");
  assert.equal(store.sessionLifecycle.isEnded("old-session"), true);
  assert.equal(store.sessionLifecycle.isEnded("new-session"), false);
});

test("logout marca, fecha SSE, destrói e limpa cookies antes de responder", () => {
  appState.resetForTests();
  const events = [];
  const store = decorateSessionStore(fakeStore());
  const response = {
    writableEnded: false,
    write() {},
    end() { this.writableEnded = true; events.push("sse:end"); },
  };
  appState.registerSse(
    response,
    () => events.push("sse:cleanup"),
    { sessionId: "logout-session" },
  );
  const req = {
    sessionID: "logout-session",
    sessionStore: store,
    session: {
      destroy(callback) {
        events.push("destroy");
        callback();
      },
    },
  };
  const res = {
    clearCookie(name) { events.push(`clear:${name}`); },
    redirect(location) { events.push(`redirect:${location}`); },
  };
  loginController.logout(req, res, error => assert.fail(error));
  assert.deepEqual(events, [
    "sse:cleanup",
    "sse:end",
    "destroy",
    "clear:comandamix.sid",
    "clear:connect.sid",
    "redirect:/",
  ]);
  assert.equal(store.sessionLifecycle.isEnded("logout-session"), true);
});

test("touch de sessão removida é absorvido e logado de forma limitada", async () => {
  let timestamp = 100_000;
  const logs = [];
  const store = decorateSessionStore(fakeStore((_sid, _session, callback) => {
    callback(new Error("Unable to find the session to touch"));
  }), {
    now: () => timestamp,
    logger: { warn(...items) { logs.push(items); } },
  });
  markSessionEnding({
    sessionID: "removed-session",
    sessionStore: store,
  }, "logout");
  assert.equal(await invokeTouch(store, "removed-session"), null);
  assert.equal(await invokeTouch(store, "removed-session"), null);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0][1], {
    code: "SESSION_TOUCH_NOT_FOUND",
    contexto: "logout",
  });
  assert.doesNotMatch(JSON.stringify(logs), /removed-session/);
  timestamp += 60_001;
  assert.equal(await invokeTouch(store, "removed-session"), null);
  assert.equal(logs.length, 2);
});

test("touch ausente por expiração não recria sessão nem derruba o processo", async () => {
  let touchCalls = 0;
  const store = decorateSessionStore(fakeStore((_sid, _session, callback) => {
    touchCalls += 1;
    callback(new Error("Unable to find the session to touch"));
  }), { logger: { warn() {} } });
  assert.equal(await invokeTouch(store, "expired-session"), null);
  assert.equal(touchCalls, 1);
  assert.equal(store.sessionLifecycle.isEnded("expired-session"), false);
});

test("requisição concorrente não recria sessão encerrada e nova sessão é salva", async () => {
  const persisted = [];
  const rawStore = fakeStore();
  rawStore.set = (sid, _session, callback) => {
    persisted.push(sid);
    callback();
  };
  const store = decorateSessionStore(rawStore);
  markSessionEnding({ sessionID: "old-session", sessionStore: store }, "logout");
  await new Promise((resolve, reject) => {
    store.set("old-session", { alterada: true }, error => error ? reject(error) : resolve());
  });
  await new Promise((resolve, reject) => {
    store.set("new-session", { autenticada: true }, error => error ? reject(error) : resolve());
  });
  assert.deepEqual(persisted, ["new-session"]);
});

for (const error of [
  Object.assign(new Error("network timeout"), { name: "MongoNetworkTimeoutError" }),
  Object.assign(new Error("authentication failed"), { name: "MongoServerError", code: 18 }),
  new Error("erro desconhecido"),
]) {
  test(`touch não esconde ${error.name}: ${error.message}`, async () => {
    const store = decorateSessionStore(fakeStore((_sid, _session, callback) => {
      callback(error);
    }), { logger: { warn() {} } });
    assert.equal(await invokeTouch(store), error);
  });
}

test("TTL, maxAge e touchAfter permanecem coerentes e MongoStore é obrigatório", () => {
  assert.ok(SESSION_TOUCH_AFTER_SECONDS > 0);
  assert.ok(SESSION_TOUCH_AFTER_SECONDS * 1000 < SESSION_MAX_AGE_MS);
  assert.throws(
    () => createSessionMiddleware({
      config: { production: true, sessionSecret: "x".repeat(32) },
      store: new (require("express-session").MemoryStore)(),
    }),
    /MemoryStore é proibido/,
  );
});

test("encerramento SSE é isolado por sessão e cleanup é idempotente", () => {
  appState.resetForTests();
  const calls = [];
  const response = label => ({
    writableEnded: false,
    write() { calls.push(`${label}:write`); },
    end() { this.writableEnded = true; calls.push(`${label}:end`); },
  });
  const first = response("first");
  const second = response("second");
  const unregister = appState.registerSse(
    first,
    () => calls.push("first:cleanup"),
    { sessionId: "session-a" },
  );
  appState.registerSse(
    second,
    () => calls.push("second:cleanup"),
    { sessionId: "session-b" },
  );
  appState.closeSseConnectionsForSession("session-a");
  unregister();
  assert.equal(first.writableEnded, true);
  assert.equal(second.writableEnded, false);
  assert.equal(calls.filter(item => item === "first:cleanup").length, 1);
  appState.closeSseConnections();
  assert.equal(second.writableEnded, true);
});

test("invalidação de autenticação marca a sessão e fecha SSE associada", () => {
  appState.resetForTests();
  const calls = [];
  const store = decorateSessionStore(fakeStore());
  const response = {
    writableEnded: false,
    write() {},
    end() { this.writableEnded = true; calls.push("sse:end"); },
  };
  appState.registerSse(
    response,
    () => calls.push("sse:cleanup"),
    { sessionId: "invalid-session" },
  );
  const req = {
    sessionID: "invalid-session",
    sessionStore: store,
    session: {
      destroy(callback) {
        calls.push("destroy");
        callback();
      },
    },
  };
  encerrarSessao(req, error => {
    assert.equal(error, null);
    calls.push("callback");
  });
  assert.deepEqual(calls, [
    "sse:cleanup",
    "sse:end",
    "destroy",
    "callback",
  ]);
  assert.equal(store.sessionLifecycle.isEnded("invalid-session"), true);
});
