"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const models = require("../src/models/painelModels");
const estoqueService = require("../src/services/estoqueService");

test("cadastro novo preserva acumuladores e legado não recebe histórico inventado", () => {
  const novo = new models.Estoque({
    estabelecimentoId: "507f191e810c19729de860ea",
    categoriaId: "507f191e810c19729de860eb",
    nome: "Farinha",
    quantidade: 10,
    quantidadeInicial: 10,
    totalEntradas: 10,
    totalConsumido: 0,
    unidade: "kg",
  });
  assert.equal(novo.quantidade, 10);
  assert.equal(novo.quantidadeInicial, 10);
  assert.equal(novo.totalEntradas, 10);
  assert.equal(novo.totalConsumido, 0);

  const legado = new models.Estoque({
    estabelecimentoId: "507f191e810c19729de860ea",
    categoriaId: "507f191e810c19729de860eb",
    nome: "Legado",
    quantidade: 9.8,
    unidade: "kg",
  });
  assert.equal(legado.totalEntradas, undefined);
  assert.equal(legado.totalConsumido, undefined);
});

test("conversões da ficha técnica produzem 0,2 kg, 0,5 l e unidade", () => {
  assert.equal(estoqueService.converterQuantidade(200, "g", "kg"), 0.2);
  assert.equal(estoqueService.converterQuantidade(500, "ml", "l"), 0.5);
  assert.equal(estoqueService.converterQuantidade(1, "un", "un"), 1);
});

test("exemplo 10 kg menos 200 g resulta em 9,8, 0,2 e 98%", () => {
  const entrada = 10;
  const consumo = estoqueService.converterQuantidade(200, "g", "kg");
  const restante = entrada - consumo;
  const percentual = Math.max(0, Math.min(100, (restante / entrada) * 100));
  assert.equal(restante, 9.8);
  assert.equal(consumo, 0.2);
  assert.ok(Math.abs(percentual - 98) < 1e-9);
});

test("view usa acumuladores, limita percentual e sinaliza legado", () => {
  const view = fs.readFileSync("src/views/admin-real.ejs", "utf8");
  assert.match(view, /item\.totalEntradas !== undefined/);
  assert.match(view, /item\.totalConsumido !== undefined/);
  assert.match(view, /Math\.max\(0,\s*Math\.min\(100,/);
  assert.match(view, /quantidadeCadastrada === null \? 'Revisar'/);
  assert.match(view, /percentualRestante\.toFixed\(1\) %>%/);
});

test("baixa e restauração atualizam totalConsumido de forma idempotente", () => {
  const service = fs.readFileSync("src/services/estoqueService.js", "utf8");
  assert.match(
    service,
    /\$inc:\s*\{\s*quantidade:\s*-consumo\.quantidadeNaUnidadeEstoque,\s*totalConsumido:\s*consumo\.quantidadeNaUnidadeEstoque/,
  );
  assert.match(
    service,
    /totalConsumido:\s*\{\s*\$gte:\s*consumo\.quantidadeNaUnidadeEstoque[\s\S]*?totalConsumido:\s*-consumo\.quantidadeNaUnidadeEstoque/,
  );
  assert.match(service, /\$addToSet:\s*\{\s*estoqueOperacoes:/);
});
