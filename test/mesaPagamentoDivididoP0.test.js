"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  distribuirPagamentosPorPedidos,
  montarPlanoPagamentoMesa,
  normalizarPagamentosPedido,
  valorMonetarioParaCentavos,
} = require("../src/services/mesaPagamentoService");

const ROOT = path.join(__dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("valor monetário aceita padrão brasileiro sem erro de ponto flutuante", () => {
  assert.equal(valorMonetarioParaCentavos("1.234,56"), 123456);
  assert.equal(valorMonetarioParaCentavos("10,5"), 1050);
  assert.equal(valorMonetarioParaCentavos("10.50"), 1050);
  assert.throws(
    () => valorMonetarioParaCentavos("10,999"),
    /duas casas decimais/,
  );
});

test("pagamento único continua cobrindo o total integral da mesa", () => {
  assert.deepEqual(
    montarPlanoPagamentoMesa({ formaPagamento: "cartao" }, 7590),
    {
      formaPagamento: "cartao",
      pagamentos: [{ formaPagamento: "cartao", valorCentavos: 7590 }],
    },
  );
});

test("pagamento combinado calcula o segundo valor exclusivamente pelo total do servidor", () => {
  const plan = montarPlanoPagamentoMesa({
    formaPagamento: "combinado",
    formaPagamento1: "dinheiro",
    valorPagamento1: "30,00",
    formaPagamento2: "pix",
    valorPagamento2: "70,00",
    totalConta: "0,01",
  }, 10000);

  assert.deepEqual(plan, {
    formaPagamento: "combinado",
    pagamentos: [
      { formaPagamento: "dinheiro", valorCentavos: 3000 },
      { formaPagamento: "pix", valorCentavos: 7000 },
    ],
  });
});

test("conta de 150 reais recebe apenas o primeiro valor e calcula o restante", () => {
  const plan = montarPlanoPagamentoMesa({
    formaPagamento: "combinado",
    formaPagamento1: "pix",
    valorPagamento1: "50,00",
    formaPagamento2: "cartao",
  }, 15000);

  assert.deepEqual(plan, {
    formaPagamento: "combinado",
    pagamentos: [
      { formaPagamento: "pix", valorCentavos: 5000 },
      { formaPagamento: "cartao", valorCentavos: 10000 },
    ],
  });
});

test("pagamento combinado rejeita meios repetidos, valores zerados e soma adulterada", () => {
  assert.throws(
    () => montarPlanoPagamentoMesa({
      formaPagamento: "combinado",
      formaPagamento1: "pix",
      valorPagamento1: "30,00",
      formaPagamento2: "pix",
    }, 10000),
    /diferentes/,
  );
  assert.throws(
    () => montarPlanoPagamentoMesa({
      formaPagamento: "combinado",
      formaPagamento1: "pix",
      valorPagamento1: "100,00",
      formaPagamento2: "cartao",
    }, 10000),
    /maior que zero/,
  );
  assert.throws(
    () => montarPlanoPagamentoMesa({
      formaPagamento: "combinado",
      formaPagamento1: "pix",
      valorPagamento1: "30,00",
      formaPagamento2: "cartao",
      valorPagamento2: "60,00",
    }, 10000),
    /total atual/,
  );
});

test("divisão entre pedidos preserva centavos e não duplica valores", () => {
  const pedidos = [
    { _id: "pedido-1", total: 40, createdAt: new Date("2026-08-06T10:00:00Z") },
    { _id: "pedido-2", total: 60, createdAt: new Date("2026-08-06T11:00:00Z") },
  ];
  const result = distribuirPagamentosPorPedidos(pedidos, [
    { formaPagamento: "dinheiro", valorCentavos: 3000 },
    { formaPagamento: "cartao", valorCentavos: 7000 },
  ]);

  assert.deepEqual(result.map(item => ({
    pedido: item.pedido._id,
    formaPagamento: item.formaPagamento,
    pagamentos: item.pagamentos,
  })), [
    {
      pedido: "pedido-1",
      formaPagamento: "combinado",
      pagamentos: [
        { formaPagamento: "dinheiro", valorCentavos: 3000 },
        { formaPagamento: "cartao", valorCentavos: 1000 },
      ],
    },
    {
      pedido: "pedido-2",
      formaPagamento: "cartao",
      pagamentos: [
        { formaPagamento: "cartao", valorCentavos: 6000 },
      ],
    },
  ]);

  const distributedTotal = result.flatMap(item => item.pagamentos)
    .reduce((sum, item) => sum + item.valorCentavos, 0);
  assert.equal(distributedTotal, 10000);
});

test("registro do pedido exige que os pagamentos fechem exatamente com o total", () => {
  assert.deepEqual(normalizarPagamentosPedido({
    totalCentavos: 5050,
    pagamentos: [
      { formaPagamento: "pix", valorCentavos: 2500 },
      { formaPagamento: "cartao", valorCentavos: 2550 },
    ],
  }), {
    formaPagamento: "combinado",
    pagamentos: [
      { formaPagamento: "pix", valorCentavos: 2500 },
      { formaPagamento: "cartao", valorCentavos: 2550 },
    ],
  });

  assert.throws(
    () => normalizarPagamentosPedido({
      totalCentavos: 5050,
      pagamentos: [
        { formaPagamento: "pix", valorCentavos: 2500 },
        { formaPagamento: "cartao", valorCentavos: 2500 },
      ],
    }),
    /não fecham/,
  );
});

test("controller calcula a conta pelos pedidos pendentes e persiste a distribuição", () => {
  const controller = source("src/controllers/adminRealController.js");
  assert.match(controller, /totalContaCentavos = pedidosPendentes\.reduce/);
  assert.match(controller, /montarPlanoPagamentoMesa\(\s*req\.body,\s*totalContaCentavos/);
  assert.match(controller, /distribuirPagamentosPorPedidos\(\s*pedidosPendentes,\s*planoConta\.pagamentos/);
  assert.match(controller, /pagamentos: distribuicao\.pagamentos/);
  assert.doesNotMatch(controller, /totalContaCentavos\s*=\s*req\.body/);
});

test("schema, painel e impressão preservam a composição do pagamento", () => {
  const model = source("src/models/painelModels.js");
  const view = source("src/views/admin-real.ejs");
  const print = source("src/services/printQueueService.js");

  assert.match(model, /"combinado"/);
  assert.match(model, /pagamentos:\s*\{\s*type:\s*\[pagamentoPedidoSchema\]/);
  assert.match(view, /Combinar 2 pagamentos/);
  assert.match(view, /data-valor-pagamento-1/);
  assert.match(view, /O restante será calculado automaticamente/);
  assert.match(view, /textoFormaPagamentoPedido/);
  assert.match(view, /Recebimentos por forma de pagamento/);
  assert.match(view, /painelDashboard\.formasPagamento/);
  assert.match(view, /relatorios\.formasPagamento/);
  assert.match(print, /pagamentos:\s*Array\.isArray\(pedido\.pagamentos\)/);
});

test("dashboard e relatórios somam cada parte no meio correspondente", () => {
  const controller = source("src/controllers/adminRealController.js");

  assert.match(controller, /etapasAgregacaoFormasPagamento/);
  assert.match(controller, /\$unwind:\s*"\$componentesPagamento"/);
  assert.match(controller, /pix_online/);
  assert.match(controller, /formasPagamento:\s*dashboardAgregado/);
  assert.match(controller, /formasPagamento:\s*agregadoRelatorios/);
});
