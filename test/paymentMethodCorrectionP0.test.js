"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  montarPlanoPagamentoMesa,
  normalizarPagamentosPedido,
  totalParaCentavos,
} = require("../src/services/mesaPagamentoService");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("rota administrativa permite corrigir forma de pagamento com isolamento e permissão de pedidos", () => {
  const route = read("route.js");
  assert.match(
    route,
    /'\/admin\/pedidos\/:id\/forma-pagamento'[\s\S]*loginRequired[\s\S]*assinaturaRequired[\s\S]*permissao\('pedidos'\)[\s\S]*admin\.alterarFormaPagamentoPedido/,
  );
});

test("correção grava forma e pagamentos normalizados sem alterar pagamentoStatus", () => {
  const controller = read("src/controllers/adminRealController.js");
  const start = controller.indexOf("exports.alterarFormaPagamentoPedido");
  const end = controller.indexOf("exports.confirmarPagamentoPedido", start);
  const block = controller.slice(start, end);

  assert.match(block, /estabelecimentoId:\s*idEstabelecimento/);
  assert.match(block, /pedido\.formaPagamento = planoPagamento\.formaPagamento/);
  assert.match(block, /pedido\.pagamentos = planoPagamento\.pagamentos/);
  assert.match(block, /montarPlanoPagamentoMesa/);
  assert.doesNotMatch(block, /pedido\.pagamentoStatus\s*=(?!=)/);
  assert.match(block, /forma_pagamento_corrigida/);
});

test("normalização move o total integral para a nova forma de pagamento", () => {
  const totalCentavos = totalParaCentavos(47);
  const plano = normalizarPagamentosPedido({
    formaPagamento: "cartao",
    pagamentos: null,
    totalCentavos,
  });
  assert.deepEqual(plano, {
    formaPagamento: "cartao",
    pagamentos: [{ formaPagamento: "cartao", valorCentavos: 4700 }],
  });
});


test("correção permite combinar duas formas e calcula o restante pelo total do pedido", () => {
  const plano = montarPlanoPagamentoMesa({
    formaPagamento: "combinado",
    formaPagamento1: "dinheiro",
    valorPagamento1: "20,00",
    formaPagamento2: "cartao",
    valorPagamento2: "27,00",
  }, 4700);

  assert.deepEqual(plano, {
    formaPagamento: "combinado",
    pagamentos: [
      { formaPagamento: "dinheiro", valorCentavos: 2000 },
      { formaPagamento: "cartao", valorCentavos: 2700 },
    ],
  });
});

test("cards renderizados e cards em tempo real oferecem correção de pagamento", () => {
  const view = read("src/views/admin-real.ejs");
  const matches = view.match(/data-change-payment-method/g) || [];
  assert.ok(matches.length >= 3); // card inicial, card dinâmico e listener delegado
  assert.match(view, /Alterar para\.\.\./);
  assert.match(view, /Combinar 2 pagamentos/);
  assert.match(view, /data-correcao-valor-1/);
  assert.match(view, /data-correcao-valor-2/);
  assert.match(view, /Salvar pagamento/);
  assert.match(view, /Dashboard e os Relatórios passarão a contabilizar os valores nas formas escolhidas/);
});

test("dashboard e relatórios agregam pagamentos atuais dos pedidos pagos", () => {
  const controller = read("src/controllers/adminRealController.js");
  assert.match(controller, /pagamentoStatus:\s*"pago"/);
  assert.match(controller, /"\$pagamentos"/);
  assert.match(controller, /"\$componentesPagamento\.formaPagamento"/);
});
