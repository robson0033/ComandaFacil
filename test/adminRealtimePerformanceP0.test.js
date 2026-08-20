"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

const realtime = require("../src/services/adminRealtimeService");

test("barramento em memória isola lojas e remove listeners", () => {
  const recebidosA = [];
  const recebidosB = [];
  const offA = realtime.subscribe("loja-a", event => recebidosA.push(event));
  const offB = realtime.subscribe("loja-b", event => recebidosB.push(event));

  assert.equal(realtime.publish("loja-a", { reason: "pedido_criado", pedidoId: "p1" }), 1);
  assert.equal(recebidosA.length, 1);
  assert.equal(recebidosB.length, 0);
  assert.equal(recebidosA[0].pedidoId, "p1");

  offA();
  assert.equal(realtime.listenerCount("loja-a"), 0);
  assert.equal(realtime.publish("loja-a", { reason: "pedido_criado" }), 0);
  offB();
});

test("SSE usa evento real e heartbeat sem consultar pedidos a cada 5 segundos", () => {
  const controller = read("src/controllers/adminRealController.js");
  assert.match(controller, /adminRealtimeService\.subscribe\(/);
  assert.match(controller, /heartbeatTimer\s*=\s*setInterval/);
  assert.match(controller, /25_000/);
  assert.doesNotMatch(controller, /setInterval\(\s*enviarEvento\s*,\s*5000\s*\)/);
});

test("criação de pedido publica sinal somente depois da persistência", () => {
  const queue = read("src/services/printQueueService.js");
  assert.match(queue, /function notificarPedidoCriadoNoPainel/);
  assert.match(queue, /adminRealtimeService\.publish\(pedido\.estabelecimentoId/);
  assert.match(
    queue,
    /await session\.withTransaction[\s\S]*?notificarPedidoCriadoNoPainel\(pedido\);[\s\S]*?return anexarResultadoPublico/,
  );
});

test("painel mantém fallback seguro de 60 segundos e remove polling de mesas a cada 4 segundos", () => {
  const view = read("src/views/admin-real.ejs");
  assert.match(view, /pedidosFallbackTimer\s*=\s*window\.setInterval/);
  assert.match(view, /60_000/);
  assert.doesNotMatch(view, /void atualizarResumoMesas\(\);\s*\},\s*4000/);
  assert.match(view, /String\(evento\?\.mesaId \|\| ''\)/);
});
