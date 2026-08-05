"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  calcularTotaisPedidoComEntrega,
} = require("../src/services/cidadeEntregaService");
const {
  hashPublicOrderPayload,
} = require("../src/utils/publicOrderIdempotency");

const raiz = path.resolve(__dirname, "..");
const ler = arquivo => fs.readFileSync(path.join(raiz, arquivo), "utf8");
const controller = ler("src/controllers/adminRealController.js");
const catalogView = ler("src/views/catalogo-publico.ejs");
const adminView = ler("src/views/admin-real.ejs");
const models = ler("src/models/painelModels.js");
const idempotency = ler("src/utils/publicOrderIdempotency.js");
const printQueue = ler("src/services/printQueueService.js");

test("catálogo carrega somente cidades ativas da própria loja", () => {
  assert.match(
    controller,
    /CidadeEntrega\.find\(\{\s*estabelecimentoId:\s*configuracao\.estabelecimentoId,\s*ativo:\s*true,/s,
  );
  assert.match(controller, /\.select\("nome uf taxaCentavos"\)/);
  assert.match(controller, /\.sort\(\{ nome: 1, uf: 1 \}\)/);
  assert.match(controller, /cidadesEntrega:\s*cidadesEntrega\.map\(/);
});

test("cardápio exige seleção da cidade somente para delivery", () => {
  assert.match(catalogView, /id="cidadeEntregaId"/);
  assert.match(catalogView, /name="cidadeEntregaId"/);
  assert.match(catalogView, /data-taxa-centavos="<%= cidade\.taxaCentavos %>"/);
  assert.match(catalogView, /cidade\.nome %> - <%= cidade\.uf/);
  assert.match(
    catalogView,
    /\[cidadeEntregaId, ruaEntrega, numeroEntrega, bairroEntrega\][\s\S]*input\.required = delivery/,
  );
  assert.match(catalogView, /cidadeEntregaId:\s*String\(formData\.get\("cidadeEntregaId"\)/);
});

test("delivery sem cidades cadastradas cai para retirada", () => {
  assert.match(catalogView, /const cidadesEntregaDisponiveis/);
  assert.match(catalogView, /if \(delivery && !cidadesEntregaDisponiveis\)/);
  assert.match(catalogView, /canalPedido\.value = "retirada"/);
});

test("backend busca a cidade ativa da loja e nunca aceita taxa enviada pelo navegador", () => {
  assert.match(controller, /mongoose\.isValidObjectId\(cidadeEntregaId\)/);
  assert.match(
    controller,
    /CidadeEntrega\.findOne\(\{\s*_id:\s*cidadeEntregaId,\s*estabelecimentoId:\s*configuracao\.estabelecimentoId,\s*ativo:\s*true,/s,
  );
  assert.match(controller, /\.select\("_id nome uf taxaCentavos"\)/);
  assert.match(controller, /code:\s*"CIDADE_ENTREGA_OBRIGATORIA"/);
  assert.match(controller, /code:\s*"CIDADE_ENTREGA_INDISPONIVEL"/);
  assert.doesNotMatch(controller, /taxaEntrega(?:Centavos)?\s*=\s*Number\(req\.body/);
  assert.doesNotMatch(catalogView, /taxaEntregaCentavos:\s*String\(formData/);
});

test("cálculo financeiro soma a taxa em centavos sem erro de ponto flutuante", () => {
  assert.deepEqual(
    calcularTotaisPedidoComEntrega({
      subtotalProdutos: 30,
      taxaEntregaCentavos: 1250,
    }),
    {
      subtotalProdutos: 30,
      taxaEntregaCentavos: 1250,
      taxaEntrega: 12.5,
      total: 42.5,
    },
  );

  assert.deepEqual(
    calcularTotaisPedidoComEntrega({
      subtotalProdutos: 0.1 + 0.2,
      taxaEntregaCentavos: 1,
    }),
    {
      subtotalProdutos: 0.3,
      taxaEntregaCentavos: 1,
      taxaEntrega: 0.01,
      total: 0.31,
    },
  );
});

test("pedido salva snapshot da cidade, subtotal e taxa aplicada", () => {
  assert.match(models, /cidadeEntregaId:[\s\S]*ref:\s*"CidadeEntrega"/);
  assert.match(models, /cidadeEntregaNome:[\s\S]*maxlength:\s*120/);
  assert.match(models, /cidadeEntregaUf:[\s\S]*maxlength:\s*2/);
  assert.match(models, /subtotalProdutos:[\s\S]*type:\s*Number/);
  assert.match(models, /taxaEntregaCentavos:[\s\S]*Number\.isSafeInteger/);
  assert.match(
    controller,
    /cidadeEntregaNome:\s*canal === "delivery"[\s\S]*cidadeEntregaSelecionada\.nome/,
  );
  assert.match(controller, /subtotalProdutos,[\s\S]*taxaEntregaCentavos,[\s\S]*total,/);
  assert.match(idempotency, /cidadeEntregaId:[\s\S]*taxaEntregaCentavos:/);

  const payloadBase = {
    estabelecimentoId: "loja-1",
    canal: "delivery",
    idempotencyKey: "00000000-0000-4000-8000-000000000000",
    cidadeEntregaId: "cidade-a",
    cidadeEntregaNome: "Cidade A",
    cidadeEntregaUf: "CE",
    subtotalProdutos: 30,
    taxaEntregaCentavos: 500,
    total: 35,
    itens: [],
  };
  assert.notEqual(
    hashPublicOrderPayload(payloadBase),
    hashPublicOrderPayload({
      ...payloadBase,
      cidadeEntregaId: "cidade-b",
      cidadeEntregaNome: "Cidade B",
    }),
  );
});

test("taxa participa do total, do troco, do Pix e do snapshot de impressão", () => {
  const calculoIndex = controller.indexOf("const resumoFinanceiro = calcularTotaisPedidoComEntrega");
  const trocoIndex = controller.indexOf("trocoParaRecebido < total", calculoIndex);
  const criacaoIndex = controller.indexOf("criarPedidoComJobsAutomaticos", calculoIndex);

  assert.ok(calculoIndex >= 0);
  assert.ok(trocoIndex > calculoIndex);
  assert.ok(criacaoIndex > trocoIndex);
  assert.match(printQueue, /taxaEntregaCentavos:/);
  assert.match(printQueue, /subtotalProdutos:/);
});

test("checkout mostra subtotal, taxa e total e atualiza ao trocar cidade", () => {
  assert.match(catalogView, /id="orderSubtotal"/);
  assert.match(catalogView, /id="orderDeliveryFee"/);
  assert.match(catalogView, /id="orderTotal"/);
  assert.match(catalogView, /function taxaEntregaSelecionadaCentavos\(\)/);
  assert.match(catalogView, /function atualizarResumoFinanceiroPedido\(\)/);
  assert.match(
    catalogView,
    /cidadeEntregaId\.addEventListener\([\s\S]*"change"[\s\S]*atualizarResumoFinanceiroPedido/,
  );
});

test("painel administrativo mostra cidade e composição financeira do delivery", () => {
  assert.match(adminView, /<strong>Cidade:<\/strong>/);
  assert.match(adminView, /Taxa de entrega/);
  assert.match(adminView, /order-total-breakdown/);
  assert.match(controller, /cidadeEntrega:\s*pedido\.cidadeEntregaNome/);
  assert.match(controller, /taxaEntrega:\s*Number\(pedido\.taxaEntregaCentavos/);
});
