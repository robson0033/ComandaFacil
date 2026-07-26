"use strict";

const STATES = new Set(["starting", "ready", "shutting_down", "failed"]);

function initialChecks() {
  return {
    envValid: false,
    databaseConnected: false,
    sessionStoreReady: false,
    httpListening: false,
    workersStarted: false,
  };
}

let state = "starting";
let checks = initialChecks();
const sseConnections = new Set();

function setState(next) {
  if (!STATES.has(next)) throw new Error("Estado de runtime inválido.");
  state = next;
}

function setCheck(name, value) {
  if (!(name in checks)) throw new Error(`Check de runtime inválido: ${name}`);
  checks[name] = Boolean(value);
}

function isReady() {
  return state === "ready" && Object.values(checks).every(Boolean);
}

function publicReadiness() {
  return {
    database: checks.databaseConnected,
    sessionStore: checks.sessionStoreReady,
    http: checks.httpListening,
    workers: checks.workersStarted,
    environment: checks.envValid,
  };
}

function registerSse(res, cleanup = () => {}) {
  const connection = { res, cleanup };
  sseConnections.add(connection);
  return () => {
    sseConnections.delete(connection);
    cleanup();
  };
}

function closeSseConnections() {
  for (const connection of [...sseConnections]) {
    sseConnections.delete(connection);
    try {
      connection.cleanup();
      if (!connection.res.writableEnded) {
        connection.res.write?.("event: shutdown\ndata: {}\n\n");
        connection.res.end();
      }
    } catch {
      // O encerramento continua mesmo se o cliente já tiver desconectado.
    }
  }
}

function resetForTests() {
  state = "starting";
  checks = initialChecks();
  sseConnections.clear();
}

module.exports = {
  closeSseConnections,
  getChecks: () => ({ ...checks }),
  getState: () => state,
  isReady,
  publicReadiness,
  registerSse,
  resetForTests,
  setCheck,
  setState,
};
