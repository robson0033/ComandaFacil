"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const models = require("../src/models/painelModels");
const estoqueService = require("../src/services/estoqueService");
const admin = require("../src/controllers/adminRealController");

function pedidoFixture(overrides = {}) {
  return {
    _id: "507f1f77bcf86cd799439011",
    estabelecimentoId: "507f191e810c19729de860ea",
    itens: [{
      produtoId: "507f191e810c19729de860eb",
      quantidade: 2,
    }],
    ...overrides,
  };
}

test("fichaTecnica real gera consumo; campo receita não é usado", () => {
  const pedido = pedidoFixture();
  const consumos = estoqueService.montarConsumosDoPedido(pedido, [{
    _id: pedido.itens[0].produtoId,
    fichaTecnica: [{
      estoqueId: "507f191e810c19729de860ec",
      quantidade: 150,
      unidade: "g",
    }],
    receita: [{
      estoqueId: "507f191e810c19729de860ed",
      quantidade: 999,
      unidade: "g",
    }],
  }]);
  assert.equal(consumos.length, 1);
  assert.deepEqual(consumos[0], {
    estoqueId: "507f191e810c19729de860ec",
    produtoId: pedido.itens[0].produtoId,
    itemPedidoIndice: 0,
    quantidadeProduto: 2,
    quantidadeConsumida: 300,
    unidadeFicha: "g",
  });
});

test("produto sem ficha técnica conclui sem inventar consumo", () => {
  const pedido = pedidoFixture();
  const consumos = estoqueService.montarConsumosDoPedido(pedido, [{
    _id: pedido.itens[0].produtoId,
    fichaTecnica: [],
  }]);
  assert.equal(consumos.length, 0);
});

test("produto ausente no estabelecimento é rejeitado", () => {
  assert.throws(
    () => estoqueService.montarConsumosDoPedido(pedidoFixture(), []),
    /não foi encontrado no estabelecimento/,
  );
});

test("dinheiro e cartão só são confirmados depois da baixa", async () => {
  for (const formaPagamento of ["dinheiro", "cartao"]) {
    const calls = [];
    const pedido = {
      _id: `pedido-${formaPagamento}`,
      pagamentoStatus: "pendente",
      formaPagamento,
      pagoEm: null,
      async save() { calls.push("save"); },
    };
    await admin._testing.confirmarPedidoComEstoque(
      pedido,
      {},
      async id => {
        calls.push(`estoque:${id}`);
        return { success: true, status: "concluido" };
      },
    );
    assert.deepEqual(calls, [`estoque:${pedido._id}`, "save"]);
    assert.equal(pedido.pagamentoStatus, "pago");
    assert.equal(pedido.formaPagamento, formaPagamento);
    assert.ok(pedido.pagoEm instanceof Date);
  }
});

test("pagamento de mesa baixa estoque e finaliza o pedido", async () => {
  const pedido = {
    _id: "pedido-mesa",
    pagamentoStatus: "pendente",
    status: "novo",
    async save() {},
  };
  await admin._testing.confirmarPedidoComEstoque(
    pedido,
    { formaPagamento: "dinheiro", finalizar: true },
    async () => ({ success: true, status: "concluido" }),
  );
  assert.equal(pedido.pagamentoStatus, "pago");
  assert.equal(pedido.status, "finalizado");
  assert.equal(pedido.formaPagamento, "dinheiro");
});

test("confirmação manual duplicada reutiliza a idempotência do estoque", async () => {
  let chamadas = 0;
  const pedido = {
    _id: "pedido-duplicado",
    pagamentoStatus: "pendente",
    async save() {},
  };
  const baixar = async () => ({
    success: true,
    status: chamadas++ === 0 ? "concluido" : "ja_concluido",
  });
  await admin._testing.confirmarPedidoComEstoque(pedido, {}, baixar);
  await admin._testing.confirmarPedidoComEstoque(pedido, {}, baixar);
  assert.equal(chamadas, 2);
  assert.equal(pedido.pagamentoStatus, "pago");
});

test("lock ocupado impede confirmação manual", async () => {
  let saved = false;
  const pedido = {
    _id: "pedido-lock",
    pagamentoStatus: "pendente",
    async save() { saved = true; },
  };
  await assert.rejects(
    admin._testing.confirmarPedidoComEstoque(
      pedido,
      {},
      async () => ({
        success: false,
        status: "lock_ocupado",
        retryable: true,
        errorCode: "ESTOQUE_LOCK_OCUPADO",
      }),
    ),
    error => error.code === "ESTOQUE_LOCK_OCUPADO"
      && error.retryable === true,
  );
  assert.equal(saved, true);
  assert.equal(pedido.pagamentoStatus, "pendente");
});

test("ingrediente desativado impede confirmação do pagamento", async () => {
  const pedido = {
    _id: "pedido-ingrediente-desativado",
    pagamentoStatus: "pendente",
    historicoFinanceiro: [],
    async save() {},
  };
  await assert.rejects(
    admin._testing.confirmarPedidoComEstoque(
      pedido,
      {},
      async () => ({
        success: false,
        status: "falhou",
        retryable: false,
        errorCode: "INGREDIENTE_DESATIVADO",
      }),
    ),
    error => error.code === "INGREDIENTE_DESATIVADO"
      && error.retryable === false,
  );
  assert.equal(pedido.pagamentoStatus, "pendente");
});

test("ingrediente de outra loja falha e persiste estado para retry", async () => {
  const originals = {
    pedidoFindOneAndUpdate: models.Pedido.findOneAndUpdate,
    pedidoFindById: models.Pedido.findById,
    pedidoUpdateOne: models.Pedido.updateOne,
    produtoFind: models.Produto.find,
    estoqueFind: models.Estoque.find,
  };
  const pedido = pedidoFixture();
  const updates = [];
  models.Pedido.findOneAndUpdate = async (filter, update) => ({
    ...pedido,
    estoqueLockId: update.$set.estoqueLockId,
    estoqueLockExpiraEm: update.$set.estoqueLockExpiraEm,
    estoqueConsumos: [],
    estoqueSnapshotCriado: false,
  });
  models.Pedido.findById = async () => ({
    ...pedido,
    estoqueBaixado: false,
    estoqueProcessamento: "falhou",
  });
  models.Pedido.updateOne = async (filter, update) => {
    updates.push(update);
    return { modifiedCount: 1 };
  };
  models.Produto.find = () => ({ lean: async () => [{
    _id: pedido.itens[0].produtoId,
    fichaTecnica: [{
      estoqueId: "507f191e810c19729de860ff",
      quantidade: 1,
      unidade: "un",
    }],
  }] });
  models.Estoque.find = () => ({
    lean: async () => [],
    select() { return this; },
  });
  try {
    const result = await estoqueService.baixarEstoqueDoPedido(pedido._id);
    assert.equal(result.success, false);
    assert.equal(result.retryable, true);
    assert.equal(
      updates.some(update =>
        update.$set?.estoqueProcessamento === "falhou"
        && /não pertence/.test(update.$set?.estoqueErro)),
      true,
    );
    assert.equal(
      updates.some(update => update.$set?.estoqueBaixado === true),
      false,
    );
  } finally {
    models.Pedido.findOneAndUpdate = originals.pedidoFindOneAndUpdate;
    models.Pedido.findById = originals.pedidoFindById;
    models.Pedido.updateOne = originals.pedidoUpdateOne;
    models.Produto.find = originals.produtoFind;
    models.Estoque.find = originals.estoqueFind;
  }
});

test("cancelamento duplicado é idempotente", async () => {
  const originals = {
    findOneAndUpdate: models.Pedido.findOneAndUpdate,
    findById: models.Pedido.findById,
  };
  models.Pedido.findOneAndUpdate = async () => null;
  models.Pedido.findById = async () => ({
    estoqueBaixado: false,
    estoqueRestaurado: true,
    estoqueProcessamento: "restaurado",
  });
  try {
    const first = await estoqueService.restaurarEstoqueDoPedido("pedido");
    const second = await estoqueService.restaurarEstoqueDoPedido("pedido");
    assert.equal(first.status, "ja_restaurado");
    assert.equal(second.status, "ja_restaurado");
  } finally {
    models.Pedido.findOneAndUpdate = originals.findOneAndUpdate;
    models.Pedido.findById = originals.findById;
  }
});
