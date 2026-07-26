"use strict";

require("dotenv").config({ quiet: true });

const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const flash = require("express-flash");
const http = require("http");
const { Server } = require("socket.io");

const route = require("./route");
const middleware = require("./src/middleware/middlewareGlobal");
const { ensureCsrfToken } = require("./src/middleware/csrf");
const { securityHeaders } = require("./src/middleware/securityHeaders");
const { stopRateLimiters } = require("./src/middleware/rateLimit");
const { createSystemRouter } = require("./src/routes/systemRoutes");
const { validateEnvironment } = require("./src/config/validateEnv");
const {
  createSessionMiddleware,
  createSessionStore,
} = require("./src/config/sessionConfig");
const { initializeStorage } = require("./src/services/storageService");
const appState = require("./src/runtime/appState");
const printAgentHub = require("./src/services/printAgentHub");
const printQueueService = require("./src/services/printQueueService");

const SHUTDOWN_TIMEOUT_MS = 25_000;

function sanitizeFatal(error) {
  const type = String(error?.name || "Error").slice(0, 80);
  const message = String(error?.message || error || "Erro desconhecido")
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "[URI_REMOVIDA]")
    .replace(/(token|secret|password|senha)=\S+/gi, "$1=[REMOVIDO]")
    .slice(0, 500);
  return `${type}: ${message}`;
}

function createBaseApplication() {
  const app = express();
  app.use(createSystemRouter());
  return app;
}

function configureApplication(app, { config, sessionMiddleware }) {
  if (config.production) app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.set("views", path.resolve(__dirname, "src", "views"));
  app.set("view engine", "ejs");
  app.use("/uploads", (req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Content-Security-Policy", "default-src 'none'; img-src 'self'");
    next();
  });
  app.use(express.static(path.resolve(__dirname, "public")));
  app.use(sessionMiddleware);
  app.use(flash());
  app.use(ensureCsrfToken);
  app.use(middleware.middlewareGlobal);
  app.use(route);
  app.use((req, res) => res.status(404).render("404"));
  return app;
}

function closeWithCallback(resource, method) {
  return new Promise((resolve, reject) => {
    if (!resource || typeof resource[method] !== "function") return resolve();
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true;
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    };
    try {
      const result = resource[method](done);
      if (result?.then) result.then(() => done(), done);
    } catch (error) {
      done(error);
    }
  });
}

function createShutdown(runtime, {
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  exit = code => process.exit(code),
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  database = mongoose,
  state = appState,
  queue = printQueueService,
  agentHub = printAgentHub,
  stopLimiters = stopRateLimiters,
} = {}) {
  let shutdownPromise = null;
  return function shutdown(reason = "shutdown", exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      state.setState("shutting_down");
      state.setCheck("httpListening", false);
      queue.setShuttingDown(true);
      agentHub.stop();
      stopLimiters();
      if (runtime.reconcileTimer) {
        clearInterval(runtime.reconcileTimer);
        runtime.reconcileTimer = null;
      }
      state.closeSseConnections();

      let timeout;
      const forced = new Promise(resolve => {
        timeout = setTimeoutFn(() => {
          logger.error("Shutdown excedeu o tempo máximo.");
          runtime.httpServer?.closeAllConnections?.();
          resolve({ forced: true });
        }, timeoutMs);
        timeout.unref?.();
      });
      const graceful = (async () => {
        await Promise.all([
          closeWithCallback(runtime.httpServer, "close"),
          closeWithCallback(runtime.io, "close"),
        ]);
        if (runtime.sessionStore && typeof runtime.sessionStore.close === "function") {
          await runtime.sessionStore.close();
        }
        if (database.connection.readyState !== 0) await database.disconnect();
        return { forced: false };
      })();

      let result;
      try {
        result = await Promise.race([graceful, forced]);
      } catch (error) {
        logger.error(`Falha durante shutdown: ${sanitizeFatal(error)}`);
        result = { forced: true };
      } finally {
        clearTimeoutFn(timeout);
      }
      const finalCode = result.forced ? 1 : exitCode;
      exit(finalCode);
      return { reason: String(reason), exitCode: finalCode, ...result };
    })();
    return shutdownPromise;
  };
}

async function boot({
  env = process.env,
  logger = console,
  listen = true,
  exit,
} = {}) {
  appState.resetForTests();
  const runtime = {
    app: createBaseApplication(),
    config: null,
    httpServer: null,
    io: null,
    sessionStore: null,
    reconcileTimer: null,
    shutdown: null,
  };

  try {
    runtime.config = validateEnvironment(env);
    initializeStorage(env);
    appState.setCheck("envValid", true);
    appState.setCheck("storageAdapterReady", true);

    await mongoose.connect(runtime.config.mongoUri);
    appState.setCheck("databaseConnected", true);

    runtime.sessionStore = createSessionStore({
      config: runtime.config,
      mongoUri: runtime.config.mongoUri,
      logger,
    });
    await runtime.sessionStore.collectionP;
    appState.setCheck("sessionStoreReady", true);

    configureApplication(runtime.app, {
      config: runtime.config,
      sessionMiddleware: createSessionMiddleware({
        config: runtime.config,
        store: runtime.sessionStore,
      }),
    });

    runtime.httpServer = http.createServer(runtime.app);
    runtime.io = new Server(runtime.httpServer, {
      cors: { origin: runtime.config.appUrl, methods: ["GET", "POST"] },
    });
    printAgentHub.init(runtime.io);
    await printQueueService.reconciliarPedidosSemJob();
    runtime.reconcileTimer = setInterval(() => {
      void printQueueService.reconciliarPedidosSemJob().catch(error =>
        logger.error(`Erro no reconciliador: ${sanitizeFatal(error)}`));
    }, 5 * 60 * 1000);
    runtime.reconcileTimer.unref?.();
    appState.setCheck("workersStarted", true);

    runtime.shutdown = createShutdown(runtime, { exit, logger });
    if (listen) {
      await new Promise((resolve, reject) => {
        runtime.httpServer.once("error", reject);
        runtime.httpServer.listen(runtime.config.port, () => {
          runtime.httpServer.off("error", reject);
          appState.setCheck("httpListening", true);
          appState.setState("ready");
          logger.log(`Servidor iniciado na porta ${runtime.config.port}.`);
          resolve();
        });
      });
    }
    return runtime;
  } catch (error) {
    appState.setState("failed");
    if (runtime.reconcileTimer) clearInterval(runtime.reconcileTimer);
    try {
      await closeWithCallback(runtime.io, "close");
      await closeWithCallback(runtime.httpServer, "close");
      if (runtime.sessionStore?.close) await runtime.sessionStore.close();
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    } catch (cleanupError) {
      logger.error(`Falha ao limpar boot incompleto: ${sanitizeFatal(cleanupError)}`);
    }
    throw error;
  }
}

function createFatalHandlers(runtime, { logger = console } = {}) {
  return {
    SIGTERM: () => runtime.shutdown("SIGTERM", 0),
    SIGINT: () => runtime.shutdown("SIGINT", 0),
    uncaughtException: error => {
      logger.error(`uncaughtException: ${sanitizeFatal(error)}`);
      return runtime.shutdown("uncaughtException", 1);
    },
    unhandledRejection: error => {
      logger.error(`unhandledRejection: ${sanitizeFatal(error)}`);
      return runtime.shutdown("unhandledRejection", 1);
    },
  };
}

function installFatalHandlers(runtime, {
  logger = console,
  processTarget = process,
} = {}) {
  const handlers = createFatalHandlers(runtime, { logger });
  processTarget.once("SIGTERM", handlers.SIGTERM);
  processTarget.once("SIGINT", handlers.SIGINT);
  processTarget.once("uncaughtException", handlers.uncaughtException);
  processTarget.once("unhandledRejection", handlers.unhandledRejection);
  return handlers;
}

async function main() {
  try {
    const runtime = await boot();
    installFatalHandlers(runtime);
  } catch (error) {
    console.error(`Falha ao iniciar: ${sanitizeFatal(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  SHUTDOWN_TIMEOUT_MS,
  boot,
  configureApplication,
  createBaseApplication,
  createFatalHandlers,
  createShutdown,
  installFatalHandlers,
  main,
  sanitizeFatal,
};
