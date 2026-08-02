"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const session = require("express-session");
const test = require("node:test");

const {
  EnvironmentValidationError,
  validateEnvironment,
} = require("../src/config/validateEnv");
const {
  SESSION_COOKIE_NAME,
  cookieOptions,
  createSessionMiddleware,
  createSessionStore,
} = require("../src/config/sessionConfig");
const appState = require("../src/runtime/appState");
const { createSystemRouter } = require("../src/routes/systemRoutes");
const {
  createFatalHandlers,
  createShutdown,
  sanitizeFatal,
} = require("../server");

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: "test",
    PORT: "3000",
    CONNECTIONSTRING: "mongodb://127.0.0.1:27017/teste",
    SESSION_SECRET: "s".repeat(48),
    APP_URL: "http://localhost:3000",
    ...overrides,
  };
}

function productionEnv(overrides = {}) {
  return baseEnv({
    NODE_ENV: "production",
    APP_URL: "https://app.example",
    STORAGE_DRIVER: "external",
    STORAGE_EXTERNAL_PROVIDER: "s3",
    STORAGE_EXTERNAL_BASE_URL: "https://cdn.example",
    STORAGE_EXTERNAL_ADAPTER_MODULE: "./adapter.js",
    MERCADO_PAGO_ACCESS_TOKEN: "configured",
    MERCADO_PAGO_PUBLIC_KEY: "configured",
    MERCADO_PAGO_WEBHOOK_SECRET: "configured",
    MERCADO_PAGO_PLATFORM_USER_ID: "configured",
    MP_CLIENT_ID: "configured",
    MP_CLIENT_SECRET: "configured",
    MP_REDIRECT_URI: "https://app.example/admin/mercado-pago/callback",
    TOKEN_ENCRYPTION_KEY: "configured",
    SMTP_HOST: "smtp.example",
    SMTP_PORT: "465",
    SMTP_USER: "configured",
    SMTP_PASS: "configured",
    SMTP_FROM: "configured",
    ...overrides,
  });
}

test("ambiente falha antes do boot com secret ausente/curto, URL HTTP ou Mongo inválido", () => {
  for (const env of [
    productionEnv({ SESSION_SECRET: "" }),
    productionEnv({ SESSION_SECRET: "curto" }),
    productionEnv({ APP_URL: "http://app.example" }),
    productionEnv({ CONNECTIONSTRING: "https://database.example" }),
  ]) {
    assert.throws(
      () => validateEnvironment(env),
      error => error instanceof EnvironmentValidationError,
    );
  }
});

test("produção exige storage externo e erros não mostram valores secretos", () => {
  const secretValue = "segredo-que-nao-pode-aparecer";
  assert.throws(
    () => validateEnvironment(productionEnv({
      STORAGE_DRIVER: "local",
      SESSION_SECRET: secretValue,
    })),
    error => {
      assert.match(error.message, /STORAGE_DRIVER/);
      assert.doesNotMatch(error.message, new RegExp(secretValue));
      return true;
    },
  );
  assert.doesNotMatch(
    sanitizeFatal(new Error(
      "mongodb://usuario:senha@host/db token=segredo password=senha",
    )),
    /usuario:senha|token=segredo|password=senha/,
  );
});

test("MemoryStore é proibido em produção e fallback exige autorização explícita", () => {
  const production = validateEnvironment(productionEnv());
  assert.throws(
    () => createSessionMiddleware({
      config: production,
      store: new session.MemoryStore(),
    }),
    /proibido/,
  );
  assert.throws(
    () => createSessionStore({
      config: validateEnvironment(baseEnv({ NODE_ENV: "development" })),
      mongoClient: null,
      logger: { warn() {} },
    }),
    /indisponível/,
  );
  const store = createSessionStore({
    config: validateEnvironment(baseEnv({
      NODE_ENV: "development",
      ALLOW_MEMORY_SESSION: "true",
    })),
    mongoClient: null,
    logger: { warn() {} },
  });
  assert.ok(store instanceof session.MemoryStore);
});

test("cookie possui nome, duração e flags coerentes por ambiente", () => {
  assert.equal(SESSION_COOKIE_NAME, "comandamix.sid");
  assert.deepEqual(cookieOptions(true), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 604_800_000,
  });
  assert.equal(cookieOptions(false).secure, false);
  const serverSource = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(serverSource, /app\.set\("trust proxy", 1\)/);
});

function requestSystemRoute(url) {
  const router = createSystemRouter();
  const layer = router.stack.find(item => item.route?.path === url);
  const response = { headers: {}, statusCode: 200, body: null };
  const res = {
    set(name, value) { response.headers[name.toLowerCase()] = value; return res; },
    status(value) { response.statusCode = value; return res; },
    json(value) { response.body = value; return res; },
  };
  layer.route.stack[0].handle({}, res);
  return {
    status: response.statusCode,
    cache: response.headers["cache-control"],
    body: response.body,
  };
}

test("/health é mínimo, no-store e não depende do banco", async () => {
  appState.resetForTests();
  const response = requestSystemRoute("/health");
  assert.equal(response.status, 200);
  assert.equal(response.cache, "no-store");
  assert.equal(response.body.status, "ok");
  assert.equal(typeof response.body.uptime, "number");
  assert.ok(response.body.timestamp);
  assert.deepEqual(Object.keys(response.body).sort(), ["status", "timestamp", "uptime"]);
});

test("/ready alterna 503/200 e volta a 503 durante shutdown", async () => {
  appState.resetForTests();
  let response = requestSystemRoute("/ready");
  assert.equal(response.status, 503);
  for (const check of Object.keys(appState.getChecks())) appState.setCheck(check, true);
  appState.setState("ready");
  response = requestSystemRoute("/ready");
  assert.deepEqual(response.body, { status: "ready" });
  appState.setState("shutting_down");
  response = requestSystemRoute("/ready");
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(response.body), /secret|mongodb|hostname/i);
});

function shutdownFixture({ hangHttp = false } = {}) {
  const calls = [];
  const runtime = {
    reconcileTimer: setInterval(() => {}, 10_000),
    httpServer: {
      close(callback) {
        calls.push("http");
        if (!hangHttp) callback();
      },
      closeAllConnections() { calls.push("force-http"); },
    },
    io: {
      close(callback) { calls.push("socket"); callback(); },
    },
    sessionStore: {
      async close() { calls.push("session"); },
    },
  };
  runtime.reconcileTimer.unref?.();
  const dependencies = {
    state: {
      setState(value) { calls.push(`state:${value}`); },
      setCheck() {},
      closeSseConnections() { calls.push("sse"); },
    },
    queue: { setShuttingDown() { calls.push("queue"); } },
    agentHub: { stop() { calls.push("agent"); } },
    stopLimiters() { calls.push("rate-limit"); },
    database: {
      connection: { readyState: 1 },
      async disconnect() { calls.push("mongoose"); },
    },
  };
  return { calls, dependencies, runtime };
}

test("shutdown é idempotente e fecha HTTP, Socket.IO, SSE, workers, store e Mongoose", async () => {
  const fixture = shutdownFixture();
  const exits = [];
  let timerCleared = false;
  const shutdown = createShutdown(fixture.runtime, {
    ...fixture.dependencies,
    exit: code => exits.push(code),
    timeoutMs: 100,
    setTimeoutFn() {
      return { unref() {} };
    },
    clearTimeoutFn() {
      timerCleared = true;
    },
    logger: { error() {} },
  });
  const first = shutdown("SIGTERM", 0);
  const second = shutdown("SIGINT", 0);
  assert.strictEqual(first, second);
  const result = await first;
  assert.equal(result.forced, false);
  assert.deepEqual(exits, [0]);
  assert.equal(timerCleared, true);
  for (const expected of [
    "queue", "agent", "rate-limit", "sse", "http", "socket", "session", "mongoose",
  ]) {
    assert.ok(fixture.calls.includes(expected), expected);
  }
});

test("timeout força fechamento e código de erro sem encerrar o processo de teste", async () => {
  const fixture = shutdownFixture({ hangHttp: true });
  const exits = [];
  let timeoutCallback = null;
  let timerCleared = false;
  const shutdown = createShutdown(fixture.runtime, {
    ...fixture.dependencies,
    exit: code => exits.push(code),
    timeoutMs: 25_000,
    setTimeoutFn(callback, milliseconds) {
      assert.equal(milliseconds, 25_000);
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeoutFn() {
      timerCleared = true;
    },
    logger: { error() {} },
  });
  const pending = shutdown("timeout-test", 0);
  assert.equal(typeof timeoutCallback, "function");
  timeoutCallback();
  const result = await pending;
  assert.equal(result.forced, true);
  assert.deepEqual(exits, [1]);
  assert.ok(fixture.calls.includes("force-http"));
  assert.equal(timerCleared, true);
});

test("SIGTERM, SIGINT, erros fatais e rejeições usam shutdown central", async () => {
  for (const [name, error, expectedCode] of [
    ["SIGTERM", undefined, 0],
    ["SIGINT", undefined, 0],
    ["uncaughtException", new Error("falha"), 1],
    ["unhandledRejection", new Error("rejeição"), 1],
  ]) {
    const calls = [];
    const runtime = {
      shutdown(reason, code) {
        calls.push({ reason, code });
        return Promise.resolve();
      },
    };
    const handlers = createFatalHandlers(runtime, {
      logger: { error() {} },
    });
    await handlers[name](error);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { reason: name, code: expectedCode });
  }
});

test("login regenera, logout destrói e limpa o mesmo cookie", () => {
  const login = fs.readFileSync(
    path.resolve(__dirname, "../src/controllers/loginControllerReal.js"),
    "utf8",
  );
  assert.match(login, /req\.session\.regenerate/);
  assert.match(login, /req\.session\.destroy/);
  assert.match(login, /clearSessionCookie/);
});

test(".nvmrc e engines permanecem alinhados com Node 24.18 e npm 11/12", () => {
  const nvm = fs.readFileSync(path.resolve(__dirname, "../.nvmrc"), "utf8").trim();
  const pkg = require("../package.json");
  assert.match(nvm, /^24\.18\.\d+$/);
  assert.equal(pkg.engines.node, ">=24.18.1 <25");
  assert.equal(pkg.engines.npm, ">=11 <13");
});
