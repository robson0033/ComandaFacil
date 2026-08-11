"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  filtrarComandasMesaParaPainel,
  montarComandasMesaAbertas,
  pedidoMesaEstaAberto,
} = require("../src/services/mesaComandaPainelService");

function pedido(id, mesaId, mesaNumero, total, extras = {}) {
  return {
    _id: id,
    canal: "mesa",
    mesaId: { _id: mesaId, numero: mesaNumero, setor: "Salão" },
    pagamentoStatus: "pendente",
    status: "novo",
    total,
    createdAt: extras.createdAt || new Date("2026-08-11T18:00:00.000Z"),
    ...extras,
  };
}

test("considera aberto somente pedido de mesa pendente e não cancelado", () => {
  assert.equal(pedidoMesaEstaAberto(pedido("p1", "m1", 1, 10)), true);
  assert.equal(pedidoMesaEstaAberto(pedido("p2", "m1", 1, 10, { pagamentoStatus: "pago" })), false);
  assert.equal(pedidoMesaEstaAberto(pedido("p3", "m1", 1, 10, { status: "cancelado" })), false);
  assert.equal(pedidoMesaEstaAberto(pedido("p4", "m1", 1, 10, { canal: "delivery" })), false);
});

test("agrupa vários pedidos abertos da mesma mesa em uma única comanda", () => {
  const comandas = montarComandasMesaAbertas([
    pedido("p1", "m1", 1, 18, { createdAt: new Date("2026-08-11T18:00:00Z") }),
    pedido("p2", "m1", 1, 20, { createdAt: new Date("2026-08-11T18:05:00Z") }),
    pedido("p3", "m2", 2, 12, { createdAt: new Date("2026-08-11T18:03:00Z") }),
  ]);

  assert.equal(comandas.length, 2);
  assert.equal(comandas[0].mesaId, "m1");
  assert.equal(comandas[0].quantidadePedidos, 2);
  assert.equal(comandas[0].total, 38);
  assert.deepEqual(comandas[0].pedidoIds, ["p1", "p2"]);
  assert.equal(comandas[1].mesaId, "m2");
});

test("pedido pago sai da comanda aberta e próximo pedido inicia nova conta", () => {
  const comandas = montarComandasMesaAbertas([
    pedido("antigo", "m1", 1, 30, { pagamentoStatus: "pago" }),
    pedido("novo", "m1", 1, 15, { createdAt: new Date("2026-08-11T19:00:00Z") }),
  ]);

  assert.equal(comandas.length, 1);
  assert.equal(comandas[0].quantidadePedidos, 1);
  assert.deepEqual(comandas[0].pedidoIds, ["novo"]);
  assert.equal(comandas[0].total, 15);
});

test("filtro de canal e status mantém a comanda como uma unidade", () => {
  const comandas = montarComandasMesaAbertas([
    pedido("p1", "m1", 1, 10, { status: "preparo" }),
    pedido("p2", "m1", 1, 15, { status: "novo" }),
  ]);

  assert.equal(filtrarComandasMesaParaPainel(comandas, { canal: "delivery" }).length, 0);
  assert.equal(filtrarComandasMesaParaPainel(comandas, { canal: "mesa", status: "preparo" }).length, 1);
  assert.equal(filtrarComandasMesaParaPainel(comandas, { canal: "mesa", status: "pronto" }).length, 0);
});
