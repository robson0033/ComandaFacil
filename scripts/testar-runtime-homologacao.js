"use strict";

const crypto = require("crypto");

const EXIT_CODES = Object.freeze({
  SUCESSO: 0,
  AMBIENTE: 1,
  BOOT: 2,
  HEALTH_READY: 3,
  SESSAO: 4,
  REINICIO: 5,
  SHUTDOWN: 6,
  LIMPEZA: 7,
});
const COOKIE_NAME = "comandamix.sid";
const OPERATION_PREFIX = "runtime-homologacao-";
const MAX_EXECUTION_WINDOW_MS = 30 * 60 * 1000;

class RuntimeHomologacaoError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.name = "RuntimeHomologacaoError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function configurationError(names) {
  const unique = [...new Set(names)].sort();
  return new RuntimeHomologacaoError(
    "RUNTIME_HOMOLOGACAO_AMBIENTE_INVALIDO",
    `Configuração inválida: ${unique.join(", ")}`,
    EXIT_CODES.AMBIENTE,
  );
}

function parseMongoTarget(value) {
  const uri = new URL(String(value || ""));
  if (!["mongodb:", "mongodb+srv:"].includes(uri.protocol)) throw new Error();
  const database = decodeURIComponent(uri.pathname.replace(/^\/+/, "").split("/")[0] || "");
  if (!database) throw new Error();
  const hostname = String(uri.hostname || "").toLowerCase();
  return {
    database,
    hostname,
    maskedHost: hostname === "localhost" || hostname === "127.0.0.1"
      ? hostname
      : `***${hostname.slice(-Math.min(hostname.length, 18))}`,
  };
}

function validarAmbiente(env = {}) {
  const invalid = [];
  if (env.ALLOW_RUNTIME_HOMOLOGATION !== "true") {
    invalid.push("ALLOW_RUNTIME_HOMOLOGATION");
  }
  if (env.NODE_ENV !== "development") invalid.push("NODE_ENV");

  const configuredPort = Number(env.PORT);
  if (
    !Number.isInteger(configuredPort)
    || configuredPort < 1
    || configuredPort > 65535
  ) {
    invalid.push("PORT");
  }
  const port = Number(env.RUNTIME_TEST_PORT || env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid.push("PORT");
  if (String(env.SESSION_SECRET || "").length < 32) invalid.push("SESSION_SECRET");

  let mongo;
  try {
    mongo = parseMongoTarget(env.CONNECTIONSTRING);
  } catch {
    invalid.push("CONNECTIONSTRING");
  }
  if (mongo) {
    const productionHint = `${mongo.hostname}/${mongo.database}`;
    if (/(^|[._/-])(prod|production|producao|live)([._/-]|$)/i.test(productionHint)) {
      invalid.push("CONNECTIONSTRING_PRODUCAO");
    }
    const namedForTest = /(homolog|staging|test)/i.test(mongo.database);
    if (!namedForTest && env.RUNTIME_TEST_DATABASE_CONFIRMATION !== "true") {
      invalid.push("RUNTIME_TEST_DATABASE_CONFIRMATION");
    }
  }

  let appUrl;
  try {
    appUrl = new URL(env.APP_URL);
    const normalizedPort = Number(appUrl.port || (appUrl.protocol === "http:" ? 80 : 443));
    if (
      appUrl.protocol !== "http:"
      || appUrl.hostname !== "localhost"
      || normalizedPort !== port
      || appUrl.pathname !== "/"
    ) {
      throw new Error();
    }
  } catch {
    invalid.push("APP_URL");
  }

  try {
    const { storageConfig } = require("../src/services/storageService");
    storageConfig(env);
  } catch {
    invalid.push("STORAGE_DRIVER");
  }

  if (invalid.length) throw configurationError(invalid);
  return Object.freeze({
    port,
    appUrl: `http://localhost:${port}`,
    database: mongo.database,
    maskedHost: mongo.maskedHost,
    confirmed: /(homolog|staging|test)/i.test(mongo.database)
      || env.RUNTIME_TEST_DATABASE_CONFIRMATION === "true",
  });
}

function safeLogger(logger = console) {
  return {
    info(message) {
      logger.info?.(String(message));
    },
    error(code) {
      logger.error?.(`Homologação de runtime falhou: ${String(code || "ERRO_DESCONHECIDO")}`);
    },
  };
}

function validateHealth(response) {
  const body = response?.body;
  if (
    response?.status !== 200
    || response.headers?.["cache-control"] !== "no-store"
    || body?.status !== "ok"
    || typeof body.uptime !== "number"
    || !Number.isFinite(body.uptime)
    || Number.isNaN(Date.parse(body.timestamp))
    || Object.keys(body).sort().join(",") !== "status,timestamp,uptime"
  ) {
    throw new RuntimeHomologacaoError(
      "HEALTH_INVALIDO",
      "Resposta de health inválida.",
      EXIT_CODES.HEALTH_READY,
    );
  }
}

function validateReady(response, expectedReady) {
  const expectedStatus = expectedReady ? 200 : 503;
  const expectedBodyStatus = expectedReady ? "ready" : "not_ready";
  if (
    response?.status !== expectedStatus
    || response.headers?.["cache-control"] !== "no-store"
    || response.body?.status !== expectedBodyStatus
  ) {
    throw new RuntimeHomologacaoError(
      "READINESS_INVALIDO",
      "Resposta de readiness inválida.",
      EXIT_CODES.HEALTH_READY,
    );
  }
  if (!expectedReady) {
    const checks = response.body?.checks;
    if (
      !checks
      || Object.values(checks).some(value => typeof value !== "boolean")
      || /secret|mongodb|hostname|connection/i.test(JSON.stringify(response.body))
    ) {
      throw new RuntimeHomologacaoError(
        "READINESS_DADOS_INVALIDOS",
        "Readiness contém dados incompatíveis.",
        EXIT_CODES.HEALTH_READY,
      );
    }
  }
}

function getSetCookie(response) {
  return String(response?.headers?.["set-cookie"] || "");
}

function validateCreatedCookie(response) {
  const setCookie = getSetCookie(response);
  const attributes = setCookie
    .split(";")
    .slice(1)
    .map(value => value.trim().toLowerCase());
  if (
    response?.status !== 201
    || response.body?.created !== true
    || !setCookie.startsWith(`${COOKIE_NAME}=`)
    || !attributes.includes("httponly")
    || !attributes.includes("samesite=lax")
    || !attributes.includes("path=/")
    || attributes.includes("secure")
    || attributes.some(value => value.startsWith("domain="))
  ) {
    throw new RuntimeHomologacaoError(
      "COOKIE_TECNICO_INVALIDO",
      "Cookie técnico inválido.",
      EXIT_CODES.SESSAO,
    );
  }
  const expiresMatch = /(?:^|;\s*)expires=([^;]+)/i.exec(setCookie);
  const expiresAt = Date.parse(expiresMatch?.[1]);
  const remaining = expiresAt - Date.now();
  if (
    !Number.isFinite(expiresAt)
    || remaining < 6.9 * 24 * 60 * 60 * 1000
    || remaining > 7.1 * 24 * 60 * 60 * 1000
  ) {
    throw new RuntimeHomologacaoError(
      "COOKIE_EXPIRACAO_INVALIDA",
      "Expiração do cookie técnico inválida.",
      EXIT_CODES.SESSAO,
    );
  }
  return setCookie.split(";")[0];
}

function extractSessionId(cookie, secret) {
  const encoded = String(cookie || "").split("=")[1] || "";
  const signed = decodeURIComponent(encoded);
  if (!signed.startsWith("s:")) throw new Error("Cookie não assinado.");
  const value = signed.slice(2);
  const separator = value.lastIndexOf(".");
  if (separator < 1) throw new Error("Cookie inválido.");
  const sid = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(sid)
    .digest("base64")
    .replace(/=+$/, "");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new Error("Assinatura do cookie inválida.");
  }
  return sid;
}

function storeCall(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

function assertMongoStore(store) {
  if (
    !store
    || store.constructor?.name === "MemoryStore"
    || !store.collectionP
    || typeof store.get !== "function"
    || typeof store.destroy !== "function"
  ) {
    throw new RuntimeHomologacaoError(
      "MONGOSTORE_OBRIGATORIO",
      "A homologação exige MongoStore.",
      EXIT_CODES.SESSAO,
    );
  }
}

function assertTechnicalSession(sessionValue, {
  operationId,
  startedAt,
  now,
  sessionSecret,
}) {
  const marker = sessionValue?.runtimeHomologation;
  const createdAt = Date.parse(marker?.createdAt);
  const expiresAt = Date.parse(sessionValue?.cookie?.expires);
  if (
    marker?.operationId !== operationId
    || !Number.isFinite(createdAt)
    || createdAt < startedAt
    || createdAt > now
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
    || (sessionSecret && JSON.stringify(sessionValue).includes(sessionSecret))
  ) {
    throw new RuntimeHomologacaoError(
      "SESSAO_TECNICA_INVALIDA",
      "Sessão técnica inválida.",
      EXIT_CODES.SESSAO,
    );
  }
}

async function cleanupSessions({
  store,
  sessionIds,
  operationId,
  startedAt,
  now = Date.now(),
}) {
  assertMongoStore(store);
  if (
    !String(operationId).startsWith(OPERATION_PREFIX)
    || now - startedAt > MAX_EXECUTION_WINDOW_MS
  ) {
    throw new RuntimeHomologacaoError(
      "LIMPEZA_ESCOPO_INVALIDO",
      "Escopo de limpeza inválido.",
      EXIT_CODES.LIMPEZA,
    );
  }
  for (const sid of new Set(sessionIds.filter(Boolean))) {
    const sessionValue = await storeCall(store, "get", sid);
    if (!sessionValue) continue;
    if (sessionValue.runtimeHomologation?.operationId !== operationId) {
      throw new RuntimeHomologacaoError(
        "LIMPEZA_SESSAO_FORA_DO_ESCOPO",
        "A sessão não pertence à execução atual.",
        EXIT_CODES.LIMPEZA,
      );
    }
    await storeCall(store, "destroy", sid);
  }
}

async function defaultRequest({ baseUrl, path, method = "GET", token, cookie }) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  const setCookie = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie().join(", ")
    : response.headers.get("set-cookie");
  return {
    status: response.status,
    body,
    headers: {
      "cache-control": response.headers.get("cache-control"),
      "set-cookie": setCookie || "",
    },
  };
}

async function executarHomologacao({
  env = process.env,
  boot,
  request = defaultRequest,
  randomUUID = crypto.randomUUID,
  randomBytes = crypto.randomBytes,
  now = Date.now,
  logger = console,
} = {}) {
  const log = safeLogger(logger);
  let config;
  try {
    config = validarAmbiente(env);
  } catch (error) {
    log.error(error.code);
    return { exitCode: EXIT_CODES.AMBIENTE };
  }

  const operationId = `${OPERATION_PREFIX}${randomUUID()}`;
  const technicalToken = randomBytes(32).toString("hex");
  const startedAt = now();
  const runtimeEnv = {
    ...env,
    PORT: String(config.port),
    APP_URL: config.appUrl,
    ALLOW_MEMORY_SESSION: "false",
  };
  const baseUrl = config.appUrl;
  const knownSessionIds = [];
  let runtime = null;
  let storeVerified = false;
  let phase = "boot";
  let resultCode = EXIT_CODES.SUCESSO;
  let errorCode = "";
  let cleanupErrorCode = "";

  const requestTechnical = (path, options = {}) => request({
    baseUrl,
    path: `/__homologacao${path}`,
    token: technicalToken,
    ...options,
  });
  const lifecycleOptions = {
    env: runtimeEnv,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    exit() {},
    homologation: { technicalToken, operationId },
    beforeReady: async () => validateReady(
      await request({ baseUrl, path: "/ready" }),
      false,
    ),
    shutdownOptions: {
      beforeClose: async () => {
        validateReady(await request({ baseUrl, path: "/ready" }), false);
        validateHealth(await request({ baseUrl, path: "/health" }));
      },
    },
  };

  log.info("Iniciando homologação controlada do runtime.");
  log.info(`bancoHost=${config.maskedHost}`);
  log.info(`banco=${config.database}`);
  log.info("ambiente=development");
  log.info(`porta=${config.port}`);
  log.info(`homologacaoConfirmada=${config.confirmed}`);

  try {
    runtime = await boot(lifecycleOptions);
    assertMongoStore(runtime.sessionStore);
    storeVerified = true;

    phase = "health_ready";
    const health = await request({ baseUrl, path: "/health" });
    validateHealth(health);
    log.info("health=ok");
    const ready = await request({ baseUrl, path: "/ready" });
    validateReady(ready, true);
    log.info("readiness=ready");

    phase = "session";
    const created = await requestTechnical("/session/create", { method: "POST" });
    const cookie = validateCreatedCookie(created);
    const sid = extractSessionId(cookie, runtimeEnv.SESSION_SECRET);
    knownSessionIds.push(sid);
    const sessionValue = await storeCall(runtime.sessionStore, "get", sid);
    assertTechnicalSession(sessionValue, {
      operationId,
      startedAt,
      now: now(),
      sessionSecret: runtimeEnv.SESSION_SECRET,
    });
    const cookieExpires = Date.parse(
      /(?:^|;\s*)expires=([^;]+)/i.exec(getSetCookie(created))?.[1],
    );
    const documentExpires = Date.parse(sessionValue.cookie.expires);
    if (Math.abs(cookieExpires - documentExpires) > 2_000) {
      throw new RuntimeHomologacaoError(
        "SESSAO_TTL_INCOMPATIVEL",
        "Cookie e sessão possuem expirações incompatíveis.",
        EXIT_CODES.SESSAO,
      );
    }
    const previousExpiration = Date.parse(sessionValue.cookie.expires);
    await storeCall(runtime.sessionStore, "touch", sid, sessionValue);
    const touched = await storeCall(runtime.sessionStore, "get", sid);
    if (Date.parse(touched?.cookie?.expires) < previousExpiration) {
      throw new RuntimeHomologacaoError(
        "SESSAO_TOUCH_INVALIDO",
        "Touch reduziu a validade da sessão.",
        EXIT_CODES.SESSAO,
      );
    }

    const secondCreated = await requestTechnical("/session/create", { method: "POST" });
    const secondCookie = validateCreatedCookie(secondCreated);
    const secondSid = extractSessionId(secondCookie, runtimeEnv.SESSION_SECRET);
    if (secondSid === sid) throw new Error("Colisão de sessões técnicas.");
    knownSessionIds.push(secondSid);
    await requestTechnical("/session/logout", {
      method: "POST",
      cookie: secondCookie,
    });
    if (await storeCall(runtime.sessionStore, "get", secondSid)) {
      throw new Error("Segunda sessão não foi removida.");
    }
    log.info("cookieRecebido=true");
    log.info("sessaoCriada=true");

    phase = "shutdown";
    const firstShutdown = await runtime.shutdown("SIGTERM", 0);
    if (firstShutdown.exitCode !== 0 || firstShutdown.forced) {
      throw new RuntimeHomologacaoError(
        "SHUTDOWN_PRIMEIRA_INSTANCIA_FALHOU",
        "Primeiro shutdown falhou.",
        EXIT_CODES.SHUTDOWN,
      );
    }
    let stillAcceptingConnections = false;
    try {
      await request({ baseUrl, path: "/health" });
      stillAcceptingConnections = true;
    } catch {
      // A recusa da conexão confirma que a primeira instância foi encerrada.
    }
    if (stillAcceptingConnections) {
      throw new RuntimeHomologacaoError(
        "HTTP_CONTINUA_ACEITANDO_CONEXOES",
        "HTTP permaneceu disponível após shutdown.",
        EXIT_CODES.SHUTDOWN,
      );
    }
    runtime = null;
    storeVerified = false;

    phase = "restart";
    runtime = await boot(lifecycleOptions);
    assertMongoStore(runtime.sessionStore);
    storeVerified = true;
    const persisted = await requestTechnical("/session/check", { cookie });
    if (persisted.status !== 200 || persisted.body?.exists !== true) {
      throw new RuntimeHomologacaoError(
        "SESSAO_NAO_PERSISTIU",
        "Sessão não persistiu após reinício.",
        EXIT_CODES.REINICIO,
      );
    }
    assertTechnicalSession(
      await storeCall(runtime.sessionStore, "get", sid),
      {
        operationId,
        startedAt,
        now: now(),
        sessionSecret: runtimeEnv.SESSION_SECRET,
      },
    );
    log.info("cookiePersistiu=true");

    phase = "session";
    const logout = await requestTechnical("/session/logout", {
      method: "POST",
      cookie,
    });
    if (
      logout.status !== 200
      || logout.body?.removed !== true
      || !/max-age=0|expires=/i.test(getSetCookie(logout))
      || await storeCall(runtime.sessionStore, "get", sid)
    ) {
      throw new RuntimeHomologacaoError(
        "LOGOUT_TECNICO_FALHOU",
        "Logout técnico falhou.",
        EXIT_CODES.SESSAO,
      );
    }
    const expired = await requestTechnical("/session/check");
    if (expired.status !== 200 || expired.body?.exists !== false) {
      throw new Error("Sessão expirada foi recuperada.");
    }
    log.info("cookieRemovido=true");

    phase = "cleanup";
    await cleanupSessions({
      store: runtime.sessionStore,
      sessionIds: knownSessionIds,
      operationId,
      startedAt,
      now: now(),
    });
    log.info("limpezaConcluida=true");

    phase = "shutdown";
    const finalShutdown = await runtime.shutdown("SIGTERM", 0);
    runtime = null;
    if (finalShutdown.exitCode !== 0 || finalShutdown.forced) {
      throw new RuntimeHomologacaoError(
        "SHUTDOWN_FINAL_FALHOU",
        "Shutdown final falhou.",
        EXIT_CODES.SHUTDOWN,
      );
    }
    log.info("shutdownConcluido=true");
  } catch (error) {
    errorCode = error?.code || "RUNTIME_HOMOLOGACAO_FALHOU";
    const phaseCodes = {
      boot: EXIT_CODES.BOOT,
      health_ready: EXIT_CODES.HEALTH_READY,
      session: EXIT_CODES.SESSAO,
      restart: EXIT_CODES.REINICIO,
      shutdown: EXIT_CODES.SHUTDOWN,
      cleanup: EXIT_CODES.LIMPEZA,
    };
    resultCode = Number(error?.exitCode) || phaseCodes[phase] || EXIT_CODES.BOOT;
    if (runtime?.sessionStore && storeVerified) {
      try {
        await cleanupSessions({
          store: runtime.sessionStore,
          sessionIds: knownSessionIds,
          operationId,
          startedAt,
          now: now(),
        });
      } catch {
        resultCode = EXIT_CODES.LIMPEZA;
        cleanupErrorCode = "RUNTIME_HOMOLOGACAO_LIMPEZA_FALHOU";
      }
    }
    if (runtime?.shutdown) {
      try {
        const shutdownResult = await runtime.shutdown("homologation_failure", 0);
        if (shutdownResult.forced && resultCode !== EXIT_CODES.LIMPEZA) {
          resultCode = EXIT_CODES.SHUTDOWN;
        }
      } catch {
        if (resultCode !== EXIT_CODES.LIMPEZA) resultCode = EXIT_CODES.SHUTDOWN;
      }
    }
    log.error(errorCode);
    if (cleanupErrorCode) log.error(cleanupErrorCode);
  }
  return { exitCode: resultCode, operationId };
}

function criarDependenciasReais() {
  const { boot } = require("../server");
  return { boot };
}

async function main({ env = process.env, logger = console } = {}) {
  require("dotenv").config({ quiet: true });
  const result = await executarHomologacao({
    env,
    ...criarDependenciasReais(),
    logger,
  });
  return result.exitCode;
}

if (require.main === module) {
  main().then(code => {
    process.exitCode = code;
  }).catch(() => {
    process.exitCode = EXIT_CODES.BOOT;
  });
}

module.exports = {
  COOKIE_NAME,
  EXIT_CODES,
  OPERATION_PREFIX,
  RuntimeHomologacaoError,
  assertMongoStore,
  cleanupSessions,
  executarHomologacao,
  extractSessionId,
  main,
  parseMongoTarget,
  validateCreatedCookie,
  validateHealth,
  validateReady,
  validarAmbiente,
};
