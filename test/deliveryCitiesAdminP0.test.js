"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  PEDIDO_MINIMO_MAXIMO_CENTAVOS,
  TAXA_ENTREGA_MAXIMA_CENTAVOS,
  converterPedidoMinimoParaCentavos,
  converterTaxaEntregaParaCentavos,
  montarDadosCidadeEntrega,
  normalizarNomeCidadeEntrega,
  normalizarUf,
} = require("../src/services/cidadeEntregaService");

const raiz = path.resolve(__dirname, "..");
const ler = arquivo => fs.readFileSync(path.join(raiz, arquivo), "utf8");

test("cidade de entrega normaliza nome, UF e taxa em centavos", () => {
  assert.equal(normalizarNomeCidadeEntrega("  Ribeirão   das Neves  "), "ribeirao das neves");
  assert.equal(normalizarUf(" mg "), "MG");
  assert.equal(converterTaxaEntregaParaCentavos("12,50"), 1250);
  assert.equal(converterTaxaEntregaParaCentavos("0"), 0);

  assert.deepEqual(
    montarDadosCidadeEntrega({
      nome: "  Ribeirão   das Neves  ",
      uf: "mg",
      taxa: "18,90",
      pedidoMinimo: "35,00",
      abaixoMinimoModo: "taxa_especial",
      taxaAbaixoMinimo: "25,00",
    }),
    {
      nome: "Ribeirão das Neves",
      nomeNormalizado: "ribeirao das neves",
      uf: "MG",
      taxaCentavos: 1890,
      pedidoMinimoCentavos: 3500,
      abaixoMinimoModo: "taxa_especial",
      taxaAbaixoMinimoCentavos: 2500,
    },
  );
});

test("cidade de entrega rejeita UF e taxa inválidas", () => {
  assert.equal(TAXA_ENTREGA_MAXIMA_CENTAVOS, 50_000);
  assert.equal(PEDIDO_MINIMO_MAXIMO_CENTAVOS, 1_000_000);
  assert.equal(converterPedidoMinimoParaCentavos("35,90"), 3590);
  assert.throws(() => converterPedidoMinimoParaCentavos("10000,01"), /pedido mínimo válido/);
  assert.throws(() => normalizarUf("XX"), /UF válida/);
  assert.throws(() => converterTaxaEntregaParaCentavos("-1"), /taxa válida/);
  assert.throws(() => converterTaxaEntregaParaCentavos("500,01"), /taxa válida/);
  assert.throws(() => converterTaxaEntregaParaCentavos("1.000,00"), /taxa válida/);
  assert.throws(
    () => montarDadosCidadeEntrega({ nome: "A", uf: "SP", taxa: "5,00" }),
    /2 a 120/,
  );
});

test("modelo isola cidades por loja e impede duplicidade de cidade e UF", () => {
  const models = ler("src/models/painelModels.js");

  assert.match(models, /const cidadeEntregaSchema = new mongoose\.Schema/);
  assert.match(models, /const CidadeEntrega = mongoose\.model\("CidadeEntrega", cidadeEntregaSchema\)/);
  assert.match(models, /taxaCentavos:[\s\S]*Number\.isSafeInteger/);
  assert.match(models, /taxaCentavos:[\s\S]*max: 50_000/);
  assert.match(models, /pedidoMinimoCentavos:[\s\S]*max: 1_000_000/);
  assert.match(models, /abaixoMinimoModo:[\s\S]*taxa_especial/);
  assert.match(models, /taxaAbaixoMinimoCentavos:[\s\S]*max: 50_000/);
  assert.match(
    models,
    /\{ estabelecimentoId: 1, nomeNormalizado: 1, uf: 1 \}[\s\S]*unique: true[\s\S]*cidade_entrega_tenant_nome_uf_unico/,
  );
  assert.match(models, /module\.exports = \{[\s\S]*CidadeEntrega/);
});

test("rotas administrativas exigem sessão, assinatura e permissão de configurações", () => {
  const route = ler("route.js");
  const csrfIndex = route.indexOf("route.use('/admin', csrfSameOriginProtection)");
  const createIndex = route.indexOf("'/admin/cidades-entrega'");

  assert.ok(csrfIndex >= 0 && createIndex > csrfIndex);

  for (const [pathPattern, controller] of [
    ["/admin/cidades-entrega", "criarCidadeEntrega"],
    ["/admin/cidades-entrega/:id/editar", "editarCidadeEntrega"],
    ["/admin/cidades-entrega/:id/status", "alterarStatusCidadeEntrega"],
  ]) {
    const escaped = pathPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = new RegExp(
      `route\\.post\\([\\s\\S]{0,80}'${escaped}'[\\s\\S]{0,400}`
      + `loginRequired[\\s\\S]*carregarAssinatura[\\s\\S]*assinaturaRequired`
      + `[\\s\\S]*permissao\\('configuracoes'\\)[\\s\\S]*admin\\.${controller}`,
    );
    assert.match(route, block);
  }
});

test("controller consulta e altera cidades somente dentro do estabelecimento autenticado", () => {
  const controller = ler("src/controllers/adminRealController.js");

  assert.match(controller, /podeConfiguracoes[\s\S]*CidadeEntrega\.find\(\{[\s\S]*estabelecimentoId:/);
  assert.match(controller, /exports\.criarCidadeEntrega[\s\S]*estabelecimentoId: idEstabelecimento/);
  assert.match(
    controller,
    /exports\.editarCidadeEntrega[\s\S]*CidadeEntrega\.findOne\(\{[\s\S]*_id: req\.params\.id,[\s\S]*estabelecimentoId: idEstabelecimento/,
  );
  assert.match(
    controller,
    /exports\.alterarStatusCidadeEntrega[\s\S]*CidadeEntrega\.findOne\(\{[\s\S]*_id: req\.params\.id,[\s\S]*estabelecimentoId: idEstabelecimento/,
  );
  assert.match(controller, /cidadesEntrega:[\s\S]*podeConfiguracoes[\s\S]*\? cidadesEntrega/);
  assert.doesNotMatch(controller, /CidadeEntrega\.deleteOne|CidadeEntrega\.deleteMany/);
});

test("painel permite cadastrar, editar e desativar cidades com CSRF", () => {
  const view = ler("src/views/admin-real.ejs");

  assert.match(view, /Cidades, taxas e pedido mínimo/);
  assert.match(view, /action="\/admin\/cidades-entrega"[\s\S]*name="_csrf"/);
  assert.match(view, /action="\/admin\/cidades-entrega\/<%= cidade\._id %>\/editar"[\s\S]*name="_csrf"/);
  assert.match(view, /action="\/admin\/cidades-entrega\/<%= cidade\._id %>\/status"[\s\S]*name="_csrf"/);
  assert.match(view, /name="taxa"[\s\S]*inputmode="decimal"/);
  assert.match(view, /name="pedidoMinimo"/);
  assert.match(view, /name="abaixoMinimoModo"/);
  assert.match(view, /name="taxaAbaixoMinimo"/);
  assert.match(view, /cidade\.taxaCentavos/);
  assert.match(view, /cidade\.pedidoMinimoCentavos/);
  assert.match(view, /Desativar cidade/);
  assert.match(view, /Reativar cidade/);
});
