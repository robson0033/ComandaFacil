"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  avaliarRegraEntregaCidade,
  montarDadosCidadeEntrega,
} = require("../src/services/cidadeEntregaService");

const raiz = path.resolve(__dirname, "..");
const ler = arquivo => fs.readFileSync(path.join(raiz, arquivo), "utf8");

const cidadeBase = {
  nome: "Bela Vista",
  uf: "MA",
  taxaCentavos: 700,
  pedidoMinimoCentavos: 3000,
  abaixoMinimoModo: "bloquear",
  taxaAbaixoMinimoCentavos: 0,
};

test("cidade pode bloquear delivery abaixo do pedido mínimo", () => {
  const regra = avaliarRegraEntregaCidade({ subtotalProdutos: 20, cidade: cidadeBase });
  assert.equal(regra.permitido, false);
  assert.equal(regra.regra, "bloquear");
  assert.equal(regra.pedidoMinimoCentavos, 3000);
  assert.equal(regra.faltamCentavos, 1000);
  assert.equal(regra.taxaEntregaCentavos, 700);
});

test("ao atingir o mínimo volta a usar a taxa normal da cidade", () => {
  const regra = avaliarRegraEntregaCidade({ subtotalProdutos: 30, cidade: cidadeBase });
  assert.equal(regra.permitido, true);
  assert.equal(regra.abaixoDoMinimo, false);
  assert.equal(regra.taxaEntregaCentavos, 700);
});

test("cidade pode aceitar abaixo do mínimo com taxa especial", () => {
  const regra = avaliarRegraEntregaCidade({
    subtotalProdutos: 20,
    cidade: {
      ...cidadeBase,
      abaixoMinimoModo: "taxa_especial",
      taxaAbaixoMinimoCentavos: 1500,
    },
  });
  assert.equal(regra.permitido, true);
  assert.equal(regra.regra, "taxa_especial");
  assert.equal(regra.taxaEntregaCentavos, 1500);
  assert.equal(regra.taxaNormalCentavos, 700);
});

test("pedido mínimo zero mantém compatibilidade com cidades antigas", () => {
  const regra = avaliarRegraEntregaCidade({
    subtotalProdutos: 5,
    cidade: { nome: "Cidade antiga", taxaCentavos: 500 },
  });
  assert.equal(regra.permitido, true);
  assert.equal(regra.pedidoMinimoCentavos, 0);
  assert.equal(regra.taxaEntregaCentavos, 500);
});

test("configuração exige taxa especial quando esse modo é usado com mínimo", () => {
  assert.throws(
    () => montarDadosCidadeEntrega({
      nome: "Cidade X",
      uf: "MA",
      taxa: "7,00",
      pedidoMinimo: "30,00",
      abaixoMinimoModo: "taxa_especial",
      taxaAbaixoMinimo: "",
    }),
    /taxa especial/,
  );
});

test("catálogo mostra aviso e backend reaplica a regra sem confiar no navegador", () => {
  const view = ler("src/views/catalogo-publico.ejs");
  const controller = ler("src/controllers/adminRealController.js");

  assert.match(view, /data-pedido-minimo-centavos/);
  assert.match(view, /data-abaixo-minimo-modo/);
  assert.match(view, /data-taxa-abaixo-minimo-centavos/);
  assert.match(view, /id="deliveryMinimumNotice"/);
  assert.match(view, /function regraEntregaSelecionadaCliente\(\)/);
  assert.match(view, /function validarRegraEntregaAntesDoEnvio\(\)/);
  assert.match(controller, /avaliarRegraEntregaCidade\(\{/);
  assert.match(controller, /code: "PEDIDO_MINIMO_DELIVERY"/);
  assert.doesNotMatch(controller, /pedidoMinimoCentavos\s*=\s*Number\(req\.body/);
  assert.doesNotMatch(controller, /taxaAbaixoMinimoCentavos\s*=\s*Number\(req\.body/);
});
