"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  montarPlanoPagamentoCatalogo,
  pedidoTemPixOnline,
  valorFormaPagamentoCentavos,
  valorPixOnlinePedidoCentavos,
} = require("../src/services/mesaPagamentoService");

const ROOT = path.join(__dirname, "..");
const source = relativePath => fs.readFileSync(
  path.join(ROOT, relativePath),
  "utf8",
);

test("pagamento único do catálogo preserva o valor integral", () => {
  assert.deepEqual(
    montarPlanoPagamentoCatalogo(
      { formaPagamento: "cartao" },
      15000,
      { pixDisponivel: true },
    ),
    {
      formaPagamento: "cartao",
      pagamentos: [
        { formaPagamento: "cartao", valorCentavos: 15000 },
      ],
    },
  );
});

test("catálogo calcula automaticamente o segundo pagamento usando o total do servidor", () => {
  const plano = montarPlanoPagamentoCatalogo({
    formaPagamento: "combinado",
    formaPagamento1: "pix",
    valorPagamento1: "50,00",
    formaPagamento2: "cartao",
  }, 15000, { pixDisponivel: true });

  assert.deepEqual(plano, {
    formaPagamento: "combinado",
    pagamentos: [
      { formaPagamento: "pix_online", valorCentavos: 5000 },
      { formaPagamento: "cartao", valorCentavos: 10000 },
    ],
  });
  assert.equal(valorPixOnlinePedidoCentavos({
    total: 150,
    ...plano,
  }), 5000);
  assert.equal(valorFormaPagamentoCentavos({
    total: 150,
    ...plano,
  }, ["cartao"]), 10000);
  assert.equal(pedidoTemPixOnline({ total: 150, ...plano }), true);
});

test("Pix também pode ser o segundo meio e recebe apenas o valor restante", () => {
  const plano = montarPlanoPagamentoCatalogo({
    formaPagamento: "combinado",
    formaPagamento1: "dinheiro",
    valorPagamento1: "90,00",
    formaPagamento2: "pix",
  }, 15000, { pixDisponivel: true });

  assert.deepEqual(plano.pagamentos, [
    { formaPagamento: "dinheiro", valorCentavos: 9000 },
    { formaPagamento: "pix_online", valorCentavos: 6000 },
  ]);
  assert.equal(valorPixOnlinePedidoCentavos({
    total: 150,
    ...plano,
  }), 6000);
});

test("catálogo rejeita meios repetidos, valor fora do total e Pix indisponível", () => {
  assert.throws(
    () => montarPlanoPagamentoCatalogo({
      formaPagamento: "combinado",
      formaPagamento1: "cartao",
      valorPagamento1: "50,00",
      formaPagamento2: "cartao",
    }, 15000, { pixDisponivel: true }),
    error => error?.code === "PUBLIC_PAYMENT_VALIDATION"
      && /diferentes/.test(error.message),
  );

  assert.throws(
    () => montarPlanoPagamentoCatalogo({
      formaPagamento: "combinado",
      formaPagamento1: "pix",
      valorPagamento1: "150,00",
      formaPagamento2: "dinheiro",
    }, 15000, { pixDisponivel: true }),
    error => error?.code === "PUBLIC_PAYMENT_VALIDATION"
      && /maior que zero/.test(error.message),
  );

  assert.throws(
    () => montarPlanoPagamentoCatalogo({ formaPagamento: "pix" }, 15000, {
      pixDisponivel: false,
    }),
    error => error?.code === "PUBLIC_PAYMENT_VALIDATION"
      && /indisponível/.test(error.message),
  );
});

test("checkout público permite informar só o primeiro valor e mostra o restante bloqueado", () => {
  const view = source("src/views/catalogo-publico.ejs");

  assert.match(view, /<option value="combinado">Combinar 2 pagamentos<\/option>/);
  assert.match(view, /name="formaPagamento1"/);
  assert.match(view, /name="valorPagamento1"/);
  assert.match(view, /name="formaPagamento2"/);
  assert.match(view, /name="valorPagamento2"[\s\S]{0,180}readonly/);
  assert.match(view, /totalAtualPedidoCentavos\(\)/);
  assert.match(view, /const secondCents = firstCents == null \? 0 : totalCents - firstCents/);
  assert.match(view, /payloadIncluiForma\(payload, "pix"\)/);
  assert.match(view, /valorFormaPayloadCentavos\(payload, "dinheiro"\)/);
});

test("backend monta o plano somente após recalcular o total e não aceita total do navegador", () => {
  const controller = source("src/controllers/adminRealController.js");
  const financeStart = controller.indexOf("const resumoFinanceiro = calcularTotaisPedidoComEntrega");
  const planStart = controller.indexOf("planoPagamento = montarPlanoPagamentoCatalogo", financeStart);

  assert.ok(financeStart >= 0, "cálculo financeiro do servidor não encontrado");
  assert.ok(planStart > financeStart, "plano deveria ser montado após o total do servidor");
  assert.match(controller, /montarPlanoPagamentoCatalogo\([\s\S]{0,220}totalParaCentavos\(total\)/);
  assert.match(controller, /formaPagamento,\s*\n\s*pagamentos,/);
  assert.doesNotMatch(
    controller.slice(planStart, planStart + 600),
    /req\.body\.(?:total|valorTotal)/,
  );
});

test("Pix combinado cobra somente sua parte e aguarda o recebimento do restante", () => {
  const controller = source("src/controllers/pagamentoController.js");
  const print = source("src/services/printQueueService.js");

  assert.match(controller, /valorPixCentavos = valorPixOnlinePedidoCentavos\(pedido\)/);
  assert.match(controller, /transaction_amount:\s*valorPix/);
  assert.match(controller, /tipo:\s*"pix_parcial_aprovado"/);
  assert.match(controller, /aguardandoPagamentoRestante:/);
  assert.match(controller, /statusNovo:\s*"pendente"/);
  assert.match(print, /String\(pedido\.formaPagamento \|\| ""\) === "combinado"/);
});

test("idempotência, Dashboard e Relatórios preservam cada componente sem duplicar o total", () => {
  const idempotency = source("src/utils/publicOrderIdempotency.js");
  const adminController = source("src/controllers/adminRealController.js");
  const adminView = source("src/views/admin-real.ejs");

  assert.match(idempotency, /pagamentos:\s*\(data\.pagamentos \|\| \[\]\)\.map/);
  assert.match(adminController, /etapasAgregacaoFormasPagamento/);
  assert.match(adminController, /\$unwind:\s*"\$componentesPagamento"/);
  assert.match(adminView, /pagamentosDashboard/);
  assert.match(adminView, /Recebimentos por forma de pagamento/);
  assert.match(adminView, /painelDashboard\.formasPagamento/);
  assert.match(adminView, /relatorios\.formasPagamento/);
});
