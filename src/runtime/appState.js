"use strict";

const STATES = new Set(["starting", "ready", "shutting_down", "failed"]);

function initialChecks() {
  return {
    envValid: false,
    databaseConnected: false,
    sessionStoreReady: false,
    storageAdapterReady: false,
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
    storage: checks.storageAdapterReady,
    http: checks.httpListening,
    workers: checks.workersStarted,
    environment: checks.envValid,
  };
}

function registerSse(res, cleanup = () => {}, { sessionId = null } = {}) {
  const connection = {
    res,
    cleanup,
    sessionId: String(sessionId || ""),
    closed: false,
  };
  sseConnections.add(connection);
  return () => {
    if (connection.closed) return;
    connection.closed = true;
    sseConnections.delete(connection);
    cleanup();
  };
}

function closeConnection(connection, event = "shutdown") {
  if (connection.closed) return;
  connection.closed = true;
  sseConnections.delete(connection);
  try {
    connection.cleanup();
    if (!connection.res.writableEnded) {
      connection.res.write?.(`event: ${event}\ndata: {}\n\n`);
      connection.res.end();
    }
  } catch {
    // O encerramento continua mesmo se o cliente já tiver desconectado.
  }
}

function closeSseConnections() {
  for (const connection of [...sseConnections]) {
    closeConnection(connection);
  }
}

function closeSseConnectionsForSession(sessionId) {
  const normalized = String(sessionId || "");
  if (!normalized) return;
  for (const connection of [...sseConnections]) {
    if (connection.sessionId === normalized) {
      closeConnection(connection, "session-ended");
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
  closeSseConnectionsForSession,
  getChecks: () => ({ ...checks }),
  getState: () => state,
  isReady,
  publicReadiness,
  registerSse,
  resetForTests,
  setCheck,
  setState,
};
