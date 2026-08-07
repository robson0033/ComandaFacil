"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_EXAMPLES,
  auditOrder,
  auditProduct,
  auditStock,
  createReport,
  main,
  runAudit,
  scanInBatches,
} = require("../scripts/auditar-estoque-legado");

function source(documents, related = []) {
  return {
    writes: 0,
    async fetchPage({ afterId, limit }) {
      const start = afterId === null
        ? 0
        : documents.findIndex(item => item._id === afterId) + 1;
      return documents.slice(start, start + limit);
    },
    async findByIds(ids) {
      return related.filter(item => ids.includes(String(item._id)));
    },
    async updateOne() { this.writes += 1; throw new Error("write"); },
    async deleteOne() { this.writes += 1; throw new Error("write"); },
    async insertOne() { this.writes += 1; throw new Error("write"); },
    async createIndex() { this.writes += 1; throw new Error("write"); },
  };
}

test("sem ALLOW_READONLY_AUDIT não conecta", async () => {
  let connections = 0;
  const result = await main({
    env: {},
    connect: async () => { connections += 1; },
    output: { log() {}, error() {} },
  });
  assert.equal(result.skipped, true);
  assert.equal(connections, 0);
});

test("paginação por cursor processa todos os lotes", async () => {
  const pages = [];
  const documents = Array.from({ length: 7 }, (_, index) => ({
    _id: String(index + 1),
  }));
  const total = await scanInBatches(
    source(documents),
    async batch => pages.push(batch.map(item => item._id)),
    3,
  );
  assert.equal(total, 7);
  assert.deepEqual(pages, [["1", "2", "3"], ["4", "5", "6"], ["7"]]);
});

test("auditoria não chama operações de escrita", async () => {
  const pedidos = source([{ _id: "p1", estabelecimentoId: "e1" }]);
  const produtos = source([{ _id: "pr1", estabelecimentoId: "e1" }]);
  const estoques = source([{
    _id: "s1",
    estabelecimentoId: "e1",
    quantidade: 1,
    unidade: "kg",
  }]);
  await runAudit({
    pedidoSource: pedidos,
    produtoSource: produtos,
    estoqueSource: estoques,
    batchSize: 1,
  });
  assert.equal(pedidos.writes + produtos.writes + estoques.writes, 0);
});

test("saída contém somente IDs técnicos e não vaza dados pessoais", async () => {
  const report = await runAudit({
    pedidoSource: source([{
      _id: "pedido-1",
      estabelecimentoId: "loja-1",
      cliente: "Nome Sigiloso",
      telefone: "71999999999",
      endereco: "Rua Sigilosa",
      estoqueBaixado: true,
      estoqueSnapshotCriado: false,
    }]),
    produtoSource: source([]),
    estoqueSource: source([]),
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /Nome Sigiloso|71999999999|Rua Sigilosa/);
  assert.match(serialized, /pedido-1/);
  assert.match(serialized, /loja-1/);
});

test("limite de exemplos é respeitado", () => {
  const report = createReport();
  for (let index = 0; index < MAX_EXAMPLES + 8; index += 1) {
    auditOrder(report, {
      _id: `pedido-${index}`,
      estabelecimentoId: "loja",
      estoqueProcessamento: "falhou",
    });
  }
  const problem = report.problems.pedido_processamento_falhou;
  assert.equal(problem.count, MAX_EXAMPLES + 8);
  assert.equal(problem.examples.length, MAX_EXAMPLES);
});

test("inconsistências de pedido, snapshot, lock e histórico são detectadas", () => {
  const report = createReport();
  auditOrder(report, {
    _id: "pedido",
    estabelecimentoId: "loja",
    estoqueBaixado: true,
    estoqueRestaurado: true,
    estoqueSnapshotCriado: false,
    estoqueProcessamento: "restaurado",
    estoqueLockId: "lock",
    estoqueLockExpiraEm: new Date("2020-01-01"),
    estoqueConsumos: [{
      estoqueId: null,
      quantidadeNaUnidadeEstoque: -1,
      unidadeEstoque: "",
      operationKey: "duplicada",
      estado: "desconhecido",
    }, {
      estoqueId: "estoque",
      quantidadeNaUnidadeEstoque: Number.NaN,
      unidadeEstoque: "kg",
      operationKey: "duplicada",
      estado: "baixado",
    }],
    historicoFinanceiro: [{
      operationKey: "",
      registradoEm: null,
    }, {
      operationKey: "hist",
      registradoEm: new Date(),
    }, {
      operationKey: "hist",
      registradoEm: new Date(),
    }],
  }, new Date("2026-01-01"));
  for (const expected of [
    "pedido_baixado_sem_snapshot",
    "pedido_baixado_e_restaurado",
    "pedido_restaurado_com_consumo_baixado",
    "snapshot_estoque_id_ausente",
    "snapshot_quantidade_invalida",
    "snapshot_operation_key_duplicada",
    "snapshot_estado_invalido",
    "lock_expirado_preenchido",
    "historico_operation_key_ausente",
    "historico_registrado_em_ausente",
    "historico_operation_key_duplicada",
  ]) {
    assert.ok(report.problems[expected], expected);
  }
});

test("inconsistências de estoque são detectadas", () => {
  const report = createReport();
  const operations = Array.from({ length: 2001 }, (_, index) => `op-${index}`);
  operations.push("op-1");
  auditStock(report, {
    _id: "estoque",
    estabelecimentoId: "loja",
    quantidade: -1,
    unidade: "desconhecida",
    estoqueOperacoes: operations,
  });
  assert.ok(report.problems.estoque_operacoes_excessivo);
  assert.ok(report.problems.estoque_operation_key_duplicada);
  assert.ok(report.problems.estoque_quantidade_negativa_ou_invalida);
  assert.ok(report.problems.estoque_unidade_desconhecida);
});

test("inconsistências da ficha técnica são detectadas", () => {
  const report = createReport();
  auditProduct(report, {
    _id: "produto",
    estabelecimentoId: "loja-a",
    fichaTecnica: [{
      estoqueId: "estoque-1",
      quantidade: 0,
      unidade: "g",
    }, {
      estoqueId: "estoque-1",
      quantidade: 1,
      unidade: "kg",
    }, {
      estoqueId: "inexistente",
      quantidade: 1,
      unidade: "g",
    }],
  }, new Map([["estoque-1", {
    _id: "estoque-1",
    estabelecimentoId: "loja-b",
    unidade: "ml",
  }]]));
  assert.ok(report.problems.ficha_quantidade_invalida);
  assert.ok(report.problems.ficha_ingrediente_duplicado);
  assert.ok(report.problems.ficha_ingrediente_inexistente);
  assert.ok(report.problems.ficha_ingrediente_de_outro_estabelecimento);
  assert.ok(report.problems.ficha_unidade_incompativel);
});
