"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");
const queue = require("../src/services/printQueueService");
const view = fs.readFileSync(path.join(__dirname, "../src/views/admin-real.ejs"), "utf8");
const cashBlockStart = view.indexOf("<% if (pedido.formaPagamento === 'dinheiro' || (");
assert.ok(cashBlockStart > 0);
const cashBlockEnd = view.indexOf("<% } %>", cashBlockStart) + "<% } %>".length;
const serverBlock = view.slice(cashBlockStart, cashBlockEnd);
const helpers = view.slice(view.indexOf("function formatarMoedaPedido("), view.indexOf("function escaparHtml(", view.indexOf("function formatarMoedaPedido(")));
const cardStart = view.indexOf("function criarCardPedido(");
const cardSource = ejs.render(view.slice(cardStart, view.indexOf("async function verificarPrintAgent", cardStart)), { csrfToken: "fixture" });
const money = value => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
function fixture(overrides = {}) {
  return { id: "pedido", _id: "507f1f77bcf86cd799439011", cliente: "Cliente teste", status: "novo", pagamentoStatus: "pendente", canal: "delivery", numero: "0002", total: 54,
    origem: { tipo: "delivery", icone: "", texto: "Delivery" },
    formaPagamento: "combinado", pagamentos: [
      { formaPagamento: "cartao", valorCentavos: 3000 },
      { formaPagamento: "dinheiro", valorCentavos: 2400 },
    ], precisaTroco: true, trocoPara: 50, valorTroco: 26, itens: [], ...overrides };
}
function renderServer(pedido) {
  return ejs.render(serverBlock, { pedido, pagamentosPedido: (pedido.pagamentos || []).filter(p => Number(p.valorCentavos || 0) > 0), formatarMoeda: money });
}
function renderDynamic(pedido) {
  const context = { document: { createElement: () => ({ dataset: {} }) },
    buildOrderSearchText: () => "", escaparHtml: x => String(x || "").replace(/[<>&"']/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;"}[c])),
    formatarDataPedido: () => "", criarHtmlItensPedido: () => "",
    podeArquivarPedidos: false, podeImprimirPedidos: false, printAgentConectado: false };
  vm.runInNewContext(helpers + "\n" + cardSource, context);
  return context.criarCardPedido(pedido).innerHTML;
}

for (const [name, render] of [["card inicial EJS", renderServer], ["card automático JavaScript", renderDynamic]]) {
  test(`${name}: cartão 30 + dinheiro 24 mostra troco para 50 e devolução de 26`, () => {
    const html = render(fixture());
    assert.match(html, /<strong>Troco:<\/strong>/);
    assert.match(html.replace(/\s/g, ""), /TrocoparaR\$50,00.*devolverR\$26,00/);
  });
  test(`${name}: dinheiro primeiro ou segundo com Pix ou cartão continua visível`, () => {
    for (const other of ["pix_online", "cartao"]) for (const reverse of [false, true]) {
      const pagamentos = [{ formaPagamento: "dinheiro", valorCentavos: 2400 }, { formaPagamento: other, valorCentavos: 3000 }];
      if (reverse) pagamentos.reverse();
      assert.match(render(fixture({ pagamentos })), /<strong>Troco:<\/strong>/);
    }
  });
  test(`${name}: sem dinheiro não mostra dados de troco antigos`, () => {
    const html = render(fixture({ pagamentos: [{ formaPagamento: "pix_online", valorCentavos: 3000 }, { formaPagamento: "cartao", valorCentavos: 2400 }] }));
    assert.doesNotMatch(html, /<strong>Troco:<\/strong>/);
    assert.doesNotMatch(render(fixture({ pagamentos: [{ formaPagamento: "dinheiro", valorCentavos: 0 }, { formaPagamento: "cartao", valorCentavos: 5400 }] })), /<strong>Troco:<\/strong>/);
  });
  test(`${name}: Não precisa de troco e dinheiro único são preservados`, () => {
    assert.match(render(fixture({ precisaTroco: false, trocoPara: null, valorTroco: null })), /Não precisa de troco/);
    assert.match(render(fixture({ formaPagamento: "dinheiro", pagamentos: [], trocoPara: 100, valorTroco: 46 })).replace(/\s/g, ""), /TrocoparaR\$100,00.*devolverR\$46,00/);
  });
}

test("snapshot da impressão transporta o troco combinado sem calcular pelo total integral", async () => {
  const snapshot = await queue.montarSnapshotValidado({
    pedido: { ...fixture(), createdAt: new Date(), itens: [{ nome: "Produto", quantidade: 1, preco: 54, subtotal: 54, adicionais: [] }] },
    configuracao: { nomeEstabelecimento: "Loja teste" }, dono: {},
    impressora: { nome: "Impressora teste", tipoConexao: "usb", deviceName: "Fixture", papel: "80mm", modo: "manual_automatica", copias: 1 },
  });
  assert.equal(snapshot.pedido.formaPagamento, "combinado");
  assert.equal(snapshot.pedido.precisaTroco, true);
  assert.equal(snapshot.pedido.trocoPara, 50);
  assert.equal(snapshot.pedido.valorTroco, 26);
  assert.deepEqual(snapshot.pedido.pagamentos, fixture().pagamentos);
});
