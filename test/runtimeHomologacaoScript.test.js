"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const session = require("express-session");
const test = require("node:test");

const {
  EXIT_CODES,
  OPERATION_PREFIX,
  assertMongoStore,
  cleanupSessions,
  executarHomologacao,
  extractSessionId,
  validateCreatedCookie,
  validateHealth,
  validateReady,
  validarAmbiente,
} = require("../scripts/testar-runtime-homologacao");
const {
  createRuntimeHomologacaoRouter,
} = require("../src/routes/runtimeHomologacaoRoutes");

const SECRET = "s".repeat(48);
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const TOKEN = "a".repeat(64);

function env(overrides = {}) {
  return {
    ALLOW_RUNTIME_HOMOLOGATION: "true",
    NODE_ENV: "development",
    CONNECTIONSTRING: "mongodb://user:password@db.internal/comandamix_homolog",
    SESSION_SECRET: SECRET,
    APP_URL: "http://localhost:3100",
    PORT: "3000",
    RUNTIME_TEST_PORT: "3100",
    STORAGE_DRIVER: "local",
    ...overrides,
  };
}

function signCookie(sid) {
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(sid)
    .digest("base64")
    .replace(/=+$/, "");
  return `comandamix.sid=${encodeURIComponent(`s:${sid}.${signature}`)}`;
}

function createdCookie(sid) {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
  return `${signCookie(sid)}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax`;
}

class MongoStore {
  constructor(documents, { failGet = false, failDestroy = false } = {}) {
    this.documents = documents;
    this.collectionP = Promise.resolve({});
    this.failGet = failGet;
    this.failDestroy = failDestroy;
  }

  get(sid, callback) {
    if (this.failGet) return callback(new Error("get falhou"));
    return callback(null, this.documents.get(sid) || null);
  }

  touch(sid, value, callback) {
    value.cookie.expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.documents.set(sid, value);
    callback();
  }

  destroy(sid, callback) {
    if (this.failDestroy) return callback(new Error("destroy falhou"));
    this.documents.delete(sid);
    return callback();
  }
}

function mockRuntime(overrides = {}) {
  const documents = new Map();
  const logs = [];
  let currentReady = false;
  let serverClosed = true;
  let sequence = 0;
  let operationId = "";
  let store = null;
  const calls = {
    boots: 0,
    shutdowns: 0,
    beforeReady: 0,
    beforeClose: 0,
    requests: [],
  };

  async function request(options) {
    calls.requests.push({ ...options, token: Boolean(options.token), cookie: Boolean(options.cookie) });
    if (serverClosed) throw new Error("ECONNREFUSED");
    if (options.path === "/health") {
      return {
        status: 200,
        headers: { "cache-control": "no-store" },
        body: {
          status: "ok",
          uptime: 1.25,
          timestamp: new Date().toISOString(),
        },
      };
    }
    if (options.path === "/ready") {
      return currentReady
        ? {
            status: 200,
            headers: { "cache-control": "no-store" },
            body: { status: "ready" },
          }
        : {
            status: 503,
            headers: { "cache-control": "no-store" },
            body: {
              status: "not_ready",
              checks: {
                database: true,
                sessionStore: true,
                storage: true,
                http: false,
                workers: true,
                environment: true,
              },
            },
          };
    }
    if (options.path === "/__homologacao/session/create") {
      sequence += 1;
      const sid = `technical-session-${sequence}`;
      documents.set(sid, {
        cookie: {
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: false,
        },
        runtimeHomologation: {
          operationId,
          marker: `marker-${sequence}`,
          createdAt: new Date().toISOString(),
        },
      });
      return {
        status: 201,
        headers: { "set-cookie": createdCookie(sid) },
        body: { created: true },
      };
    }
    const sid = options.cookie ? extractSessionId(options.cookie, SECRET) : "";
    if (options.path === "/__homologacao/session/check") {
      return {
        status: 200,
        headers: {},
        body: {
          exists: documents.get(sid)?.runtimeHomologation?.operationId === operationId,
        },
      };
    }
    if (options.path === "/__homologacao/session/logout") {
      documents.delete(sid);
      return {
        status: 200,
        headers: {
          "set-cookie": "comandamix.sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax",
        },
        body: { removed: true },
      };
    }
    throw new Error(`Rota mock inesperada: ${options.path}`);
  }

  async function boot(options) {
    calls.boots += 1;
    if (overrides.bootError) throw overrides.bootError;
    operationId = options.homologation.operationId;
    store = overrides.memoryStore
      ? new session.MemoryStore()
      : new MongoStore(documents, overrides.storeOptions);
    currentReady = false;
    serverClosed = false;
    calls.beforeReady += 1;
    await options.beforeReady();
    currentReady = true;
    return {
      sessionStore: store,
      async shutdown() {
        calls.shutdowns += 1;
        currentReady = false;
        calls.beforeClose += 1;
        await options.shutdownOptions.beforeClose();
        serverClosed = true;
        return overrides.forcedShutdown
          ? { exitCode: 1, forced: true }
          : { exitCode: 0, forced: false };
      },
    };
  }

  return {
    calls,
    documents,
    logs,
    deps: {
      env: env(overrides.env),
      boot,
      request,
      randomUUID: () => UUID,
      randomBytes: () => Buffer.alloc(32, 0xaa),
      logger: {
        info: value => logs.push(String(value)),
        error: value => logs.push(String(value)),
      },
    },
    getStore: () => store,
  };
}

test("ambiente recusa flag, produção, banco suspeito, secret, porta, URL e storage", () => {
  const cases = [
    { ALLOW_RUNTIME_HOMOLOGATION: undefined },
    { ALLOW_RUNTIME_HOMOLOGATION: "TRUE" },
    { NODE_ENV: "production" },
    { CONNECTIONSTRING: "mongodb://db.internal/comandamix_prod" },
    {
      CONNECTIONSTRING: "mongodb://db.internal/comandamix",
      RUNTIME_TEST_DATABASE_CONFIRMATION: undefined,
    },
    { SESSION_SECRET: "curto" },
    { RUNTIME_TEST_PORT: "70000" },
    { APP_URL: "http://localhost:9999" },
    { STORAGE_DRIVER: "cloudinary", CLOUDINARY_API_SECRET: "" },
  ];
  for (const change of cases) {
    assert.throws(() => validarAmbiente(env(change)), { exitCode: 1 });
  }
  assert.equal(validarAmbiente(env()).database, "comandamix_homolog");
  assert.equal(
    validarAmbiente(env({
      CONNECTIONSTRING: "mongodb://db.internal/comandamix",
      RUNTIME_TEST_DATABASE_CONFIRMATION: "true",
    })).confirmed,
    true,
  );
});

test("health e ready validam contratos seguros 200/503", () => {
  const health = {
    status: 200,
    headers: { "cache-control": "no-store" },
    body: { status: "ok", uptime: 1, timestamp: new Date().toISOString() },
  };
  assert.doesNotThrow(() => validateHealth(health));
  assert.throws(() => validateHealth({ ...health, status: 500 }), { exitCode: 3 });
  assert.doesNotThrow(() => validateReady({
    status: 503,
    headers: { "cache-control": "no-store" },
    body: { status: "not_ready", checks: { database: false } },
  }, false));
  assert.doesNotThrow(() => validateReady({
    status: 200,
    headers: { "cache-control": "no-store" },
    body: { status: "ready" },
  }, true));
});

test("cookie técnico tem atributos corretos e assinatura é validada", () => {
  const response = {
    status: 201,
    body: { created: true },
    headers: { "set-cookie": createdCookie("sid-test") },
  };
  const cookie = validateCreatedCookie(response);
  assert.equal(extractSessionId(cookie, SECRET), "sid-test");
  assert.throws(() => extractSessionId(cookie, "x".repeat(48)));
  assert.throws(() => validateCreatedCookie({
    ...response,
    headers: { "set-cookie": `${createdCookie("sid")} ; Secure` },
  }));
});

test("fluxo mock cria duas sessões, persiste após reinício, faz logout e shutdown", async () => {
  const runtime = mockRuntime();
  const result = await executarHomologacao(runtime.deps);
  assert.equal(result.exitCode, 0);
  assert.equal(result.operationId, `${OPERATION_PREFIX}${UUID}`);
  assert.equal(runtime.calls.boots, 2);
  assert.equal(runtime.calls.shutdowns, 2);
  assert.equal(runtime.calls.beforeReady, 2);
  assert.equal(runtime.calls.beforeClose, 2);
  assert.equal(runtime.documents.size, 0);
  const output = runtime.logs.join("\n");
  for (const expected of [
    "cookieRecebido=true",
    "cookiePersistiu=true",
    "cookieRemovido=true",
    "shutdownConcluido=true",
    "limpezaConcluida=true",
  ]) {
    assert.match(output, new RegExp(expected));
  }
  assert.doesNotMatch(output, new RegExp(SECRET));
  assert.doesNotMatch(output, /user:password|technical-session|aaaa+/);
});

test("boot falha de forma limpa com código 2 e sem chamada HTTP", async () => {
  const runtime = mockRuntime({ bootError: new Error("boot indisponível") });
  const result = await executarHomologacao(runtime.deps);
  assert.equal(result.exitCode, EXIT_CODES.BOOT);
  assert.equal(runtime.calls.requests.length, 0);
});

test("MemoryStore é rejeitado e a instância é encerrada", async () => {
  const runtime = mockRuntime({ memoryStore: true });
  const result = await executarHomologacao(runtime.deps);
  assert.equal(result.exitCode, EXIT_CODES.SESSAO);
  assert.equal(runtime.calls.shutdowns, 1);
  assert.throws(() => assertMongoStore(new session.MemoryStore()), { exitCode: 4 });
});

test("falha durante cleanup do fluxo retorna código 7", async () => {
  const runtime = mockRuntime({ storeOptions: { failGet: true } });
  const result = await executarHomologacao(runtime.deps);
  assert.equal(result.exitCode, EXIT_CODES.LIMPEZA);
});

test("shutdown forçado retorna código 6", async () => {
  const runtime = mockRuntime({ forcedShutdown: true });
  const result = await executarHomologacao(runtime.deps);
  assert.equal(result.exitCode, EXIT_CODES.SHUTDOWN);
});

test("cleanup remove apenas sessão da operação, com filtro e janela restritos", async () => {
  const documents = new Map([
    ["owned", {
      runtimeHomologation: { operationId: `${OPERATION_PREFIX}${UUID}` },
    }],
    ["foreign", {
      runtimeHomologation: { operationId: `${OPERATION_PREFIX}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` },
    }],
  ]);
  const store = new MongoStore(documents);
  await cleanupSessions({
    store,
    sessionIds: ["owned"],
    operationId: `${OPERATION_PREFIX}${UUID}`,
    startedAt: Date.now() - 1_000,
  });
  assert.equal(documents.has("owned"), false);
  assert.equal(documents.has("foreign"), true);
  await assert.rejects(cleanupSessions({
    store,
    sessionIds: ["foreign"],
    operationId: `${OPERATION_PREFIX}${UUID}`,
    startedAt: Date.now() - 1_000,
  }), { exitCode: 7 });
  await assert.rejects(cleanupSessions({
    store,
    sessionIds: [],
    operationId: `${OPERATION_PREFIX}${UUID}`,
    startedAt: Date.now() - 31 * 60 * 1000,
  }), { exitCode: 7 });
});

test("falha de limpeza retorna código 7 sem apagar sessão alheia", async () => {
  const documents = new Map([
    ["owned", {
      runtimeHomologation: { operationId: `${OPERATION_PREFIX}${UUID}` },
    }],
  ]);
  const store = new MongoStore(documents, { failDestroy: true });
  await assert.rejects(cleanupSessions({
    store,
    sessionIds: ["owned"],
    operationId: `${OPERATION_PREFIX}${UUID}`,
    startedAt: Date.now() - 1_000,
  }));
  assert.equal(documents.has("owned"), true);
});

test("rotas técnicas são ausentes fora da homologação e exigem token", () => {
  assert.equal(createRuntimeHomologacaoRouter({
    env: env({ ALLOW_RUNTIME_HOMOLOGATION: undefined }),
    technicalToken: TOKEN,
    operationId: `${OPERATION_PREFIX}${UUID}`,
  }), null);
  assert.equal(createRuntimeHomologacaoRouter({
    env: env({ NODE_ENV: "production" }),
    technicalToken: TOKEN,
    operationId: `${OPERATION_PREFIX}${UUID}`,
  }), null);

  const router = createRuntimeHomologacaoRouter({
    env: env(),
    technicalToken: TOKEN,
    operationId: `${OPERATION_PREFIX}${UUID}`,
  });
  const authLayer = router.stack.find(layer => !layer.route);
  const response = { statusCode: 0, body: null };
  const res = {
    set() { return res; },
    status(value) { response.statusCode = value; return res; },
    json(value) { response.body = value; return res; },
  };
  authLayer.handle({ get: () => "Bearer inválido" }, res, () => {
    throw new Error("Token inválido não deve prosseguir.");
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { code: "NAO_AUTORIZADO" });
});

test("importação não executa homologação, não usa process.exit e não deixa timer próprio", async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, "../scripts/testar-runtime-homologacao.js"),
    "utf8",
  );
  assert.match(source, /if \(require\.main === module\)/);
  assert.doesNotMatch(source, /\bprocess\.exit\s*\(/);
  const runtime = mockRuntime();
  const result = await Promise.race([
    executarHomologacao(runtime.deps),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Promise pendente")), 500);
      timer.unref?.();
    }),
  ]);
  assert.equal(result.exitCode, 0);
});

test("CLI sem autorização define process.exitCode 1 sem iniciar boot real", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/testar-runtime-homologacao.js"],
    {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        ALLOW_RUNTIME_HOMOLOGATION: "",
        NODE_ENV: "development",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /mongodb:|SESSION_SECRET|comandamix\.sid=/);
});
