"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const models = require("../src/models/painelModels");
const printAgentHub = require("../src/services/printAgentHub");
const printQueueService = require("../src/services/printQueueService");
const admin = require("../src/controllers/adminRealController");

function frontendStatusUpdater(document) {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/views/admin-real.ejs"),
    "utf8",
  );
  const start = source.indexOf("let printAgentConectado = false;");
  const end = source.indexOf("function iniciarStreamStatusAgente()", start);
  assert.ok(start >= 0 && end > start);
  return new Function(
    "document",
    `${source.slice(start, end)}; return atualizarStatusAgente;`,
  )(document);
}

function setupHub() {
  printQueueService.drenarFilaDoEstabelecimento = async () => {};
  let middleware;
  let connection;
  const namespace = {
    use(handler) { middleware = handler; },
    on(event, handler) {
      if (event === "connection") connection = handler;
    },
  };
  printAgentHub.init({ of: () => namespace });
  return { middleware, connection };
}

function socketFixture(agent, auth = {}) {
  const handlers = new Map();
  const emitted = [];
  return {
    id: `socket-${Math.random()}`,
    connected: true,
    data: { agent },
    handshake: { auth },
    emitted,
    emit(event, payload) { emitted.push({ event, payload }); },
    on(event, handler) { handlers.set(event, handler); },
    disconnect() {
      this.connected = false;
      handlers.get("disconnect")?.("server namespace disconnect");
    },
    trigger(event, payload) { handlers.get(event)?.(payload); },
  };
}

test("agent:ready publica conectado somente depois de autenticar e salvar", async () => {
  const { connection } = setupHub();
  const lojaId = "507f191e810c19729de860ea";
  let saved = false;
  const agent = {
    estabelecimentoId: lojaId,
    async save() { saved = true; },
  };
  const socket = socketFixture(agent, { computerName: "CAIXA" });
  const statuses = [];
  const unsubscribe = printAgentHub.subscribeStatus(lojaId, value => {
    statuses.push({ ...value, saved });
  });
  try {
    await connection(socket);
    assert.equal(socket.emitted.some(item => item.event === "agent:ready"), true);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].connected, true);
    assert.equal(statuses[0].saved, true);
    assert.equal(printAgentHub.isOnline(lojaId), true);
  } finally {
    socket.disconnect();
    unsubscribe();
    printAgentHub._testing.sockets.delete(lojaId);
  }
});

test("vínculo por código envia token antes do ready e publica conectado", async () => {
  const originals = {
    findOne: models.PrintAgent.findOne,
    findOneAndUpdate: models.PrintAgent.findOneAndUpdate,
  };
  const { middleware, connection } = setupHub();
  const lojaId = "507f191e810c19729de860eb";
  const agent = {
    estabelecimentoId: lojaId,
    async save() {},
  };
  models.PrintAgent.findOne = async () => null;
  models.PrintAgent.findOneAndUpdate = async () => agent;
  const socket = socketFixture(null, { code: "123456", computerName: "COZINHA" });
  socket.data = {};
  try {
    await new Promise((resolve, reject) =>
      middleware(socket, error => error ? reject(error) : resolve()));
    await connection(socket);
    assert.equal(socket.emitted[0].event, "agent:token");
    assert.equal(socket.emitted[1].event, "agent:ready");
    assert.equal(printAgentHub.currentStatus(lojaId).connected, true);
  } finally {
    socket.disconnect();
    printAgentHub._testing.sockets.delete(lojaId);
    models.PrintAgent.findOne = originals.findOne;
    models.PrintAgent.findOneAndUpdate = originals.findOneAndUpdate;
  }
});

test("reconexão por token volta a conectado e substitui socket anterior", async () => {
  const original = models.PrintAgent.findOne;
  const { middleware, connection } = setupHub();
  const lojaId = "507f191e810c19729de860ec";
  const agent = { estabelecimentoId: lojaId, async save() {} };
  models.PrintAgent.findOne = async () => agent;
  const oldSocket = socketFixture(agent);
  const newSocket = socketFixture(null, { token: "token-valido" });
  newSocket.data = {};
  try {
    await connection(oldSocket);
    await new Promise((resolve, reject) =>
      middleware(newSocket, error => error ? reject(error) : resolve()));
    await connection(newSocket);
    assert.equal(oldSocket.connected, false);
    assert.equal(printAgentHub.isOnline(lojaId), true);
    assert.equal(printAgentHub._testing.sockets.get(lojaId).id, newSocket.id);
  } finally {
    newSocket.disconnect();
    printAgentHub._testing.sockets.delete(lojaId);
    models.PrintAgent.findOne = original;
  }
});

test("disconnect publica desconectado; token inválido gera connect_error sem ready", async () => {
  const original = models.PrintAgent.findOne;
  const { middleware, connection } = setupHub();
  const lojaId = "507f191e810c19729de860ed";
  const agent = { estabelecimentoId: lojaId, async save() {} };
  const socket = socketFixture(agent);
  const statuses = [];
  const unsubscribe = printAgentHub.subscribeStatus(lojaId, value => statuses.push(value));
  try {
    await connection(socket);
    socket.disconnect();
    assert.deepEqual(statuses.map(value => value.connected), [true, false]);

    models.PrintAgent.findOne = async () => null;
    const invalid = socketFixture(null, { token: "revogado" });
    invalid.data = {};
    const error = await new Promise(resolve => middleware(invalid, resolve));
    assert.match(error.message, /Código inválido/);
    assert.equal(invalid.emitted.some(item => item.event === "agent:ready"), false);
  } finally {
    unsubscribe();
    printAgentHub._testing.sockets.delete(lojaId);
    models.PrintAgent.findOne = original;
  }
});

test("status inicial reflete página aberta antes ou depois da conexão", () => {
  const lojaId = "507f191e810c19729de860ee";
  assert.equal(printAgentHub.currentStatus(lojaId).connected, false);
  printAgentHub._testing.sockets.set(lojaId, {
    connected: true,
    data: { agent: { nomeComputador: "BALCÃO" } },
  });
  try {
    const status = printAgentHub.currentStatus(lojaId);
    assert.equal(status.connected, true);
    assert.equal(status.nomeComputador, "BALCÃO");
  } finally {
    printAgentHub._testing.sockets.delete(lojaId);
  }
});

test("evento duplicado é seguro e listener removido simula reconexão SSE", () => {
  const lojaId = "507f191e810c19729de860ef";
  const firstConnection = [];
  const stop = printAgentHub.subscribeStatus(lojaId, value => firstConnection.push(value));
  printAgentHub._testing.publishStatus(lojaId, true);
  printAgentHub._testing.publishStatus(lojaId, true);
  stop();
  const reconnected = [];
  const stopReconnected = printAgentHub.subscribeStatus(
    lojaId,
    value => reconnected.push(value),
  );
  try {
    printAgentHub._testing.publishStatus(lojaId, false);
    assert.equal(firstConnection.length, 2);
    assert.equal(reconnected.length, 1);
    assert.equal(reconnected[0].connected, false);
  } finally {
    stopReconnected();
  }
});

test("frontend atualiza badge e botões sem duplicar efeitos", () => {
  const badge = {
    textContent: "",
    dataset: {},
    classList: {
      online: false,
      toggle(name, enabled) {
        if (name === "online") this.online = enabled;
      },
    },
  };
  const code = { textContent: "Código: 123456" };
  const buttons = [{ disabled: true }, { disabled: true }];
  const document = {
    querySelector(selector) {
      if (selector === "#printAgentStatus") return badge;
      if (selector === "#agentPairCode") return code;
      return null;
    },
    querySelectorAll() { return buttons; },
  };
  const update = frontendStatusUpdater(document);
  update({ conectado: true, status: "conectado", nomeComputador: "CAIXA" });
  update({ conectado: true, status: "conectado", nomeComputador: "CAIXA" });
  assert.equal(badge.textContent, "Agente conectado — CAIXA");
  assert.equal(badge.classList.online, true);
  assert.equal(buttons.every(button => button.disabled === false), true);
  assert.equal(code.textContent, "Vínculo concluído.");
});

test("frontend tolera elementos DOM ausentes", () => {
  const update = frontendStatusUpdater({
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  assert.doesNotThrow(() => update({ conectado: false }));
  assert.equal(update({ conectado: true }), true);
});

test("SSE deriva a loja da sessão e não entrega evento de outra loja", () => {
  const lojaA = "507f191e810c19729de86101";
  const lojaB = "507f191e810c19729de86102";
  let closeHandler;
  const writes = [];
  const req = {
    session: {
      user: { id: lojaA, estabelecimentoId: lojaA },
    },
    on(event, handler) {
      if (event === "close") closeHandler = handler;
    },
  };
  const res = {
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write(value) { writes.push(value); },
    end() { this.writableEnded = true; },
  };
  admin.streamStatusAgente(req, res);
  try {
    const initialWrites = writes.length;
    printAgentHub._testing.publishStatus(lojaB, true);
    assert.equal(writes.length, initialWrites);
    printAgentHub._testing.publishStatus(lojaA, true);
    assert.equal(writes.length, initialWrites + 1);
    assert.match(writes.at(-1), /print-agent-status/);
    assert.match(writes.at(-1), /"connected":true/);
  } finally {
    closeHandler();
  }
});
