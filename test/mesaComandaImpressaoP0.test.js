"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  construirChaveComanda,
  montarPedidoComandaMesaParaImpressao,
} = require("../src/services/mesaComandaImpressaoService");

function pedido(id, codigo, total, item, createdAt) {
  return {
    _id: id,
    estabelecimentoId: "loja-1",
    canal: "mesa",
    mesaId: { _id: "mesa-1", numero: 1, setor: "Salão" },
    codigoPublico: codigo,
    cliente: "Mesa 1",
    pagamentoStatus: "pendente",
    status: "novo",
    total,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    observacao: "",
    itens: [item],
  };
}

test("monta uma única comanda com itens e total de todos os pedidos da mesa", () => {
  const pedidos = [
    pedido(
      "507f1f77bcf86cd799439011",
      "AB17DB8",
      10,
      { nome: "Pizza", quantidade: 1, preco: 10, subtotal: 10, adicionais: [] },
      "2026-08-11T10:47:23.000Z",
    ),
    pedido(
      "507f1f77bcf86cd799439012",
      "0218AA7A",
      18,
      { nome: "Xburger", quantidade: 1, preco: 18, subtotal: 18, adicionais: [] },
      "2026-08-11T10:47:41.000Z",
    ),
  ];

  const comanda = montarPedidoComandaMesaParaImpressao({
    pedidos,
    mesa: { _id: "mesa-1", numero: 1, setor: "Salão" },
    estabelecimentoId: "loja-1",
  });

  assert.equal(comanda.documentoTipo, "comanda_mesa");
  assert.equal(comanda.codigoPublico, "COMANDA");
  assert.equal(comanda.canal, "mesa");
  assert.equal(comanda.mesaId.numero, 1);
  assert.equal(comanda.comandaQuantidadePedidos, 2);
  assert.deepEqual(comanda.comandaPedidoIds, [
    "507f1f77bcf86cd799439011",
    "507f1f77bcf86cd799439012",
  ]);
  assert.equal(comanda.itens.length, 2);
  assert.equal(comanda.itens[0].nome, "Pizza");
  assert.equal(comanda.itens[1].nome, "Xburger");
  assert.equal(comanda.total, 28);
  assert.equal(comanda.subtotalProdutos, 28);
  assert.match(comanda.cliente, /Mesa 1 - 2 pedido/);
  assert.match(comanda.observacao, /Comanda da Mesa 1 com 2 pedido/);
  assert.equal(comanda.comandaChave.length, 64);
});

test("chave muda quando entra novo pedido ou o conteúdo da comanda muda", () => {
  const base = [
    pedido(
      "507f1f77bcf86cd799439011",
      "AB17DB8",
      10,
      { nome: "Pizza", quantidade: 1, preco: 10, subtotal: 10, adicionais: [] },
      "2026-08-11T10:47:23.000Z",
    ),
  ];
  const primeira = construirChaveComanda(base, "mesa-1");
  const segunda = construirChaveComanda([
    ...base,
    pedido(
      "507f1f77bcf86cd799439012",
      "0218AA7A",
      18,
      { nome: "Xburger", quantidade: 1, preco: 18, subtotal: 18, adicionais: [] },
      "2026-08-11T10:47:41.000Z",
    ),
  ], "mesa-1");
  assert.notEqual(primeira, segunda);
});

test("painel envia uma única requisição de impressão por comanda, sem loop por pedido", () => {
  const view = fs.readFileSync(
    path.join(__dirname, "../src/views/admin-real.ejs"),
    "utf8",
  );
  const inicio = view.indexOf("async function imprimirPedidosDaMesa");
  const fim = view.indexOf("document.addEventListener(\n      'click'", inicio);
  const funcao = view.slice(inicio, fim);

  assert.match(funcao, /\/admin\/agente\/pedidos\/\$\{encodeURIComponent\(pedidoReferenciaId\)\}\/imprimir/);
  assert.match(funcao, /scope:\s*['"]mesa_comanda['"]/);
  assert.match(funcao, /content-type/);
  assert.match(funcao, /PRINT_NON_JSON_RESPONSE/);
  assert.match(funcao, /UMA ÚNICA comanda/);
  assert.doesNotMatch(funcao, /for\s*\(\s*let indice/);
  assert.doesNotMatch(funcao, /imprimirPedido\s*\(/);
});

test("backend aceita comanda pela rota existente de impressão e mantém a rota dedicada como alias", () => {
  const controller = fs.readFileSync(
    path.join(__dirname, "../src/controllers/adminRealController.js"),
    "utf8",
  );
  const routes = fs.readFileSync(
    path.join(__dirname, "../route.js"),
    "utf8",
  );
  const queue = fs.readFileSync(
    path.join(__dirname, "../src/services/printQueueService.js"),
    "utf8",
  );

  assert.match(routes, /\/admin\/agente\/pedidos\/:id\/imprimir/);
  assert.match(routes, /\/admin\/agente\/mesas\/:id\/imprimir-comanda/);
  assert.match(controller, /req\.body\?\.scope === "mesa_comanda"/);
  assert.match(controller, /responderImpressaoComandaMesa/);
  assert.match(controller, /exports\.imprimirComandaMesaRemota/);
  assert.match(controller, /montarPedidoComandaMesaParaImpressao/);
  assert.match(controller, /printQueueService\.criarJobManual/);
  assert.match(controller, /"pedido\.comandaChave"/);
  assert.match(queue, /comandaPedidoIds/);
  assert.match(queue, /documentoTipo/);
  assert.match(queue, /sanitizarPedidoParaAgente/);
  assert.match(queue, /pedido:\s*sanitizarPedidoParaAgente\(entregando\.pedido\)/);
});
