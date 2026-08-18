"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const models = require("../src/models/painelModels");
const estoqueService = require("../src/services/estoqueService");
const admin = require("../src/controllers/adminRealController");

const LOJA = "507f191e810c19729de860ea";
const PRODUTO = "507f191e810c19729de860eb";
const INGREDIENTE = "507f191e810c19729de860ec";
const PEDIDO = "507f1f77bcf86cd799439011";

function queryLean(value) {
  return { lean: async () => value };
}

function requestProduto(body, params = {}) {
  return {
    body,
    params,
    file: null,
    flash() {},
    session: {
      user: { id: LOJA, estabelecimentoId: LOJA },
      save(callback) { callback(); },
    },
  };
}

function responseRedirect() {
  return {
    redirect(value) { return value; },
  };
}

test("ficha técnica válida é montada e vinculada somente à loja", async () => {
  const original = models.Estoque.find;
  let filtro;
  models.Estoque.find = query => {
    filtro = query;
    return queryLean([{
      _id: INGREDIENTE,
      nome: "Farinha",
      unidade: "kg",
      custoUnitario: 10,
    }]);
  };
  try {
    const ficha = await admin._testing.montarFichaTecnicaProduto({
      fichaEstoqueId: [INGREDIENTE],
      fichaQuantidade: ["100"],
      fichaUnidade: ["g"],
      estabelecimentoId: "loja-injetada",
    }, LOJA);
    assert.equal(String(filtro.estabelecimentoId), LOJA);
    assert.equal("estabelecimentoId" in ficha[0], false);
    assert.deepEqual(ficha[0], {
      estoqueId: INGREDIENTE,
      nome: "Farinha",
      quantidade: 100,
      unidade: "g",
      custoCalculado: 1,
    });
  } finally {
    models.Estoque.find = original;
  }
});

test("ficha vazia remove todos os ingredientes", async () => {
  assert.deepEqual(
    await admin._testing.montarFichaTecnicaProduto({}, LOJA),
    [],
  );
});

test("cadastro persiste fichaTecnica validada", async () => {
  const originals = {
    categoriaFindOne: models.Categoria.findOne,
    estoqueFind: models.Estoque.find,
    estoqueCountDocuments: models.Estoque.countDocuments,
    produtoCreate: models.Produto.create,
  };
  let criado;
  models.Categoria.findOne = () => queryLean({
    _id: "507f191e810c19729de860ed",
    tipo: "catalogo",
    tipoProduto: "normal",
  });
  models.Estoque.find = () => queryLean([{
    _id: INGREDIENTE,
    nome: "Farinha",
    unidade: "kg",
    custoUnitario: 10,
  }]);
  models.Estoque.countDocuments = async () => 1;
  models.Produto.create = async data => {
    criado = data;
    return data;
  };
  try {
    await admin.criarProduto(requestProduto({
      nome: "Pizza",
      categoriaId: "507f191e810c19729de860ed",
      preco: "30",
      custo: "5",
      fichaEstoqueId: [INGREDIENTE],
      fichaQuantidade: ["100"],
      fichaUnidade: ["g"],
      ativo: "on",
    }), responseRedirect());
    assert.equal(criado.fichaTecnica.length, 1);
    assert.equal(criado.fichaTecnica[0].quantidade, 100);
  } finally {
    models.Categoria.findOne = originals.categoriaFindOne;
    models.Estoque.find = originals.estoqueFind;
    models.Estoque.countDocuments = originals.estoqueCountDocuments;
    models.Produto.create = originals.produtoCreate;
  }
});

test("edição substitui e também remove toda a fichaTecnica", async () => {
  const originals = {
    categoriaFindOne: models.Categoria.findOne,
    estoqueFind: models.Estoque.find,
    produtoFindOne: models.Produto.findOne,
  };
  const produto = {
    nome: "Pizza",
    categoriaId: "507f191e810c19729de860ed",
    preco: 30,
    custo: 5,
    fichaTecnica: [{ estoqueId: INGREDIENTE }],
    async save() {},
  };
  models.Categoria.findOne = () => queryLean({
    _id: "507f191e810c19729de860ed",
    tipo: "catalogo",
    tipoProduto: "normal",
  });
  models.Estoque.find = () => queryLean([{
    _id: INGREDIENTE,
    nome: "Farinha",
    unidade: "kg",
    custoUnitario: 10,
  }]);
  models.Produto.findOne = async () => produto;
  try {
    await admin.editarProduto(requestProduto({
      nome: "Pizza",
      categoriaId: produto.categoriaId,
      preco: "31",
      custo: "6",
      fichaEstoqueId: [INGREDIENTE],
      fichaQuantidade: ["200"],
      fichaUnidade: ["g"],
    }, { id: PRODUTO }), responseRedirect());
    assert.equal(produto.fichaTecnica[0].quantidade, 200);

    await admin.editarProduto(requestProduto({
      nome: "Pizza",
      categoriaId: produto.categoriaId,
      preco: "31",
      custo: "6",
    }, { id: PRODUTO }), responseRedirect());
    assert.deepEqual(produto.fichaTecnica, []);
  } finally {
    models.Categoria.findOne = originals.categoriaFindOne;
    models.Estoque.find = originals.estoqueFind;
    models.Produto.findOne = originals.produtoFindOne;
  }
});

test("ficha rejeita linha incompleta, quantidade, unidade e ObjectId inválidos", async () => {
  await assert.rejects(
    admin._testing.montarFichaTecnicaProduto({
      fichaEstoqueId: [INGREDIENTE],
      fichaQuantidade: [""],
      fichaUnidade: ["g"],
    }, LOJA),
    /incompleta/,
  );
  await assert.rejects(
    admin._testing.montarFichaTecnicaProduto({
      fichaEstoqueId: [INGREDIENTE],
      fichaQuantidade: ["-1"],
      fichaUnidade: ["g"],
    }, LOJA),
    /Quantidade inválida/,
  );
  await assert.rejects(
    admin._testing.montarFichaTecnicaProduto({
      fichaEstoqueId: [INGREDIENTE],
      fichaQuantidade: ["1"],
      fichaUnidade: ["caixa"],
    }, LOJA),
    /Unidade inválida/,
  );
  await assert.rejects(
    admin._testing.montarFichaTecnicaProduto({
      fichaEstoqueId: ["invalido"],
      fichaQuantidade: ["1"],
      fichaUnidade: ["g"],
    }, LOJA),
    /Ingrediente inválido/,
  );
});

test("ficha rejeita ingrediente duplicado e de outra loja", async () => {
  await assert.rejects(
    admin._testing.montarFichaTecnicaProduto({
      fichaEstoqueId: [INGREDIENTE, INGREDIENTE],
      fichaQuantidade: ["1", "2"],
      fichaUnidade: ["g", "g"],
    }, LOJA),
    /duplicados/,
  );
  const original = models.Estoque.find;
  models.Estoque.find = () => queryLean([]);
  try {
    await assert.rejects(
      admin._testing.montarFichaTecnicaProduto({
        fichaEstoqueId: [INGREDIENTE],
        fichaQuantidade: ["1"],
        fichaUnidade: ["g"],
      }, LOJA),
      /não pertence/,
    );
  } finally {
    models.Estoque.find = original;
  }
});

test("snapshot contém consumo convertido e identidade imutável da operação", async () => {
  const originals = {
    produtoFind: models.Produto.find,
    estoqueFind: models.Estoque.find,
  };
  const produto = {
    _id: PRODUTO,
    fichaTecnica: [{
      estoqueId: INGREDIENTE,
      quantidade: 250,
      unidade: "g",
    }],
  };
  models.Produto.find = () => queryLean([produto]);
  models.Estoque.find = () => queryLean([{
    _id: INGREDIENTE,
    nome: "Carne",
    unidade: "kg",
  }]);
  try {
    const snapshot = await estoqueService.calcularSnapshot({
      _id: PEDIDO,
      estabelecimentoId: LOJA,
      itens: [{ produtoId: PRODUTO, quantidade: 2 }],
    });
    produto.fichaTecnica[0].quantidade = 999;
    assert.equal(snapshot[0].quantidadeConsumida, 500);
    assert.equal(snapshot[0].quantidadeNaUnidadeEstoque, 0.5);
    assert.equal(snapshot[0].unidadeEstoque, "kg");
    assert.match(snapshot[0].operationKey, new RegExp(PEDIDO));
  } finally {
    models.Produto.find = originals.produtoFind;
    models.Estoque.find = originals.estoqueFind;
  }
});

test("schema possui snapshot, restauração e lease explícitos", () => {
  const paths = models.Pedido.schema.paths;
  assert.ok(paths.estoqueConsumos);
  assert.ok(paths.estoqueRestaurado);
  assert.ok(paths.estoqueRestauradoEm);
  assert.ok(paths.estoqueLockId);
  assert.ok(paths.estoqueLockExpiraEm);
  assert.ok(paths.estoqueSnapshotCriado);
});

test("restauração usa somente snapshot mesmo sem Produto", async () => {
  const originals = {
    pedidoFindById: models.Pedido.findById,
    pedidoFindOneAndUpdate: models.Pedido.findOneAndUpdate,
    pedidoUpdateOne: models.Pedido.updateOne,
    produtoFind: models.Produto.find,
    estoqueUpdateOne: models.Estoque.updateOne,
  };
  const consumo = {
    estoqueId: INGREDIENTE,
    operationKey: `baixa:${PEDIDO}:0:${INGREDIENTE}`,
    quantidadeNaUnidadeEstoque: 2,
    estado: "baixado",
  };
  const pedido = {
    _id: PEDIDO,
    estabelecimentoId: LOJA,
    estoqueBaixado: true,
    estoqueRestaurado: false,
    estoqueSnapshotCriado: true,
    estoqueConsumos: [consumo],
  };
  let restaurado = false;
  models.Pedido.findById = async () => pedido;
  models.Pedido.findOneAndUpdate = async (filter, update) => ({
    ...pedido,
    estoqueLockId: update.$set.estoqueLockId,
    estoqueLockExpiraEm: update.$set.estoqueLockExpiraEm,
  });
  models.Pedido.updateOne = async () => ({ modifiedCount: 1 });
  models.Produto.find = () => {
    throw new Error("Produto não pode ser consultado na restauração");
  };
  models.Estoque.updateOne = async (filter, update) => {
    assert.equal(String(filter._id), INGREDIENTE);
    assert.equal(String(filter.estabelecimentoId), LOJA);
    assert.equal("ativo" in filter, false);
    assert.equal(update.$inc.quantidade, 2);
    restaurado = true;
    return { modifiedCount: 1 };
  };
  try {
    const result = await estoqueService.restaurarEstoqueDoPedido(PEDIDO);
    assert.equal(result.status, "restaurado");
    assert.equal(restaurado, true);
  } finally {
    models.Pedido.findById = originals.pedidoFindById;
    models.Pedido.findOneAndUpdate = originals.pedidoFindOneAndUpdate;
    models.Pedido.updateOne = originals.pedidoUpdateOne;
    models.Produto.find = originals.produtoFind;
    models.Estoque.updateOne = originals.estoqueUpdateOne;
  }
});

test("snapshot novo rejeita ingrediente desativado", async () => {
  const originals = {
    produtoFind: models.Produto.find,
    estoqueFind: models.Estoque.find,
  };
  models.Produto.find = () => queryLean([{
    _id: PRODUTO,
    fichaTecnica: [{
      estoqueId: INGREDIENTE,
      quantidade: 1,
      unidade: "un",
    }],
  }]);
  models.Estoque.find = filter => ({
    select() { return this; },
    lean: async () => filter.ativo === false
      ? [{ _id: INGREDIENTE, ativo: false }]
      : [],
  });
  try {
    await assert.rejects(
      estoqueService.calcularSnapshot({
        _id: PEDIDO,
        estabelecimentoId: LOJA,
        itens: [{ produtoId: PRODUTO, quantidade: 1 }],
      }),
      error => error.code === "INGREDIENTE_DESATIVADO"
        && error.retryable === false,
    );
  } finally {
    models.Produto.find = originals.produtoFind;
    models.Estoque.find = originals.estoqueFind;
  }
});

test("retry não continua consumo pendente de ingrediente desativado", async () => {
  const original = models.Estoque.find;
  models.Estoque.find = () => ({
    select() { return this; },
    lean: async () => [],
  });
  try {
    await assert.rejects(
      estoqueService.validarConsumosPendentesAtivos({
        estabelecimentoId: LOJA,
        estoqueConsumos: [{
          estoqueId: INGREDIENTE,
          estado: "pendente",
        }],
      }),
      error => error.code === "INGREDIENTE_DESATIVADO",
    );
  } finally {
    models.Estoque.find = original;
  }
});

test("compensação completa volta consumos para pendente sem dupla baixa", async () => {
  const originals = {
    pedidoUpdateOne: models.Pedido.updateOne,
    estoqueUpdateOne: models.Estoque.updateOne,
  };
  let compensacoes = 0;
  models.Pedido.updateOne = async () => ({ modifiedCount: 1 });
  models.Estoque.updateOne = async () => {
    compensacoes += 1;
    return { modifiedCount: 1 };
  };
  try {
    const completa = await estoqueService._testing.compensarBaixas({
      _id: PEDIDO,
      estabelecimentoId: LOJA,
      estoqueConsumos: [{
        estoqueId: INGREDIENTE,
        operationKey: `baixa:${PEDIDO}:0:${INGREDIENTE}`,
        quantidadeNaUnidadeEstoque: 1,
      }],
    }, "lock-atual");
    assert.equal(completa, true);
    assert.equal(compensacoes, 1);
  } finally {
    models.Pedido.updateOne = originals.pedidoUpdateOne;
    models.Estoque.updateOne = originals.estoqueUpdateOne;
  }
});

test("falha na compensação exige reconciliação", async () => {
  const originals = {
    pedidoUpdateOne: models.Pedido.updateOne,
    estoqueUpdateOne: models.Estoque.updateOne,
  };
  models.Pedido.updateOne = async () => ({ modifiedCount: 1 });
  models.Estoque.updateOne = async () => {
    throw new Error("spool de estoque indisponível");
  };
  try {
    const completa = await estoqueService._testing.compensarBaixas({
      _id: PEDIDO,
      estabelecimentoId: LOJA,
      estoqueConsumos: [{
        estoqueId: INGREDIENTE,
        operationKey: `baixa:${PEDIDO}:0:${INGREDIENTE}`,
        quantidadeNaUnidadeEstoque: 1,
      }],
    }, "lock-atual");
    assert.equal(completa, false);
  } finally {
    models.Pedido.updateOne = originals.pedidoUpdateOne;
    models.Estoque.updateOne = originals.estoqueUpdateOne;
  }
});

test("falha no segundo ingrediente compensa o primeiro e permite retry", async () => {
  const originals = {
    pedidoFindById: models.Pedido.findById,
    pedidoFindOneAndUpdate: models.Pedido.findOneAndUpdate,
    pedidoUpdateOne: models.Pedido.updateOne,
    estoqueFind: models.Estoque.find,
    estoqueFindOne: models.Estoque.findOne,
    estoqueUpdateOne: models.Estoque.updateOne,
  };
  const segundo = "507f191e810c19729de860ed";
  const consumos = [
    {
      estoqueId: INGREDIENTE,
      nomeIngrediente: "Ingrediente 1",
      operationKey: `baixa:${PEDIDO}:0:${INGREDIENTE}`,
      quantidadeNaUnidadeEstoque: 2,
      estado: "pendente",
    },
    {
      estoqueId: segundo,
      nomeIngrediente: "Ingrediente 2",
      operationKey: `baixa:${PEDIDO}:0:${segundo}`,
      quantidadeNaUnidadeEstoque: 3,
      estado: "pendente",
    },
  ];
  const stocks = new Map([
    [INGREDIENTE, { quantidade: 10, estoqueOperacoes: [] }],
    [segundo, { quantidade: 1, estoqueOperacoes: [] }],
  ]);
  const pedido = {
    _id: PEDIDO,
    estabelecimentoId: LOJA,
    estoqueBaixado: false,
    estoqueRestaurado: false,
    estoqueSnapshotCriado: true,
    estoqueConsumos: consumos,
    estoqueProcessamento: "nao_iniciado",
  };
  models.Pedido.findById = async () => pedido;
  models.Pedido.findOneAndUpdate = async (filter, update) => {
    pedido.estoqueLockId = update.$set.estoqueLockId;
    pedido.estoqueLockExpiraEm = update.$set.estoqueLockExpiraEm;
    return pedido;
  };
  models.Pedido.updateOne = async (filter, update) => {
    if (filter.estoqueLockId !== pedido.estoqueLockId) {
      return { modifiedCount: 0 };
    }
    if (filter["estoqueConsumos.operationKey"]) {
      const consumo = consumos.find(item =>
        item.operationKey === filter["estoqueConsumos.operationKey"]);
      consumo.estado = update.$set["estoqueConsumos.$.estado"];
    } else if (update.$set) {
      Object.assign(pedido, update.$set);
    }
    return { modifiedCount: 1 };
  };
  models.Estoque.findOne = query => ({
    select: async () => {
      const stock = stocks.get(String(query._id));
      return stock ? { ...stock } : null;
    },
  });
  models.Estoque.find = filter => ({
    select() { return this; },
    lean: async () => (filter._id.$in || []).map(id => ({ _id: id })),
  });
  models.Estoque.updateOne = async (filter, update) => {
    const stock = stocks.get(String(filter._id));
    const operationKey =
      update.$addToSet?.estoqueOperacoes
      || update.$pull?.estoqueOperacoes;
    if (update.$inc.quantidade < 0) {
      const quantidade = -update.$inc.quantidade;
      if (stock.estoqueOperacoes.includes(operationKey)) {
        return { modifiedCount: 0 };
      }
      if (stock.quantidade < quantidade) return { modifiedCount: 0 };
      stock.quantidade -= quantidade;
      stock.estoqueOperacoes.push(operationKey);
      return { modifiedCount: 1 };
    }
    if (!stock.estoqueOperacoes.includes(operationKey)) {
      return { modifiedCount: 0 };
    }
    stock.quantidade += update.$inc.quantidade;
    stock.estoqueOperacoes = stock.estoqueOperacoes.filter(
      key => key !== operationKey,
    );
    return { modifiedCount: 1 };
  };
  try {
    const falha = await estoqueService.baixarEstoqueDoPedido(PEDIDO);
    assert.equal(falha.status, "falhou");
    assert.equal(stocks.get(INGREDIENTE).quantidade, 10);
    assert.equal(stocks.get(INGREDIENTE).estoqueOperacoes.length, 0);
    assert.deepEqual(consumos.map(item => item.estado), ["pendente", "pendente"]);

    stocks.get(segundo).quantidade = 10;
    const retry = await estoqueService.baixarEstoqueDoPedido(PEDIDO);
    assert.equal(retry.status, "concluido");
    assert.equal(stocks.get(INGREDIENTE).quantidade, 8);
    assert.equal(stocks.get(segundo).quantidade, 7);
    assert.deepEqual(consumos.map(item => item.estado), ["baixado", "baixado"]);
  } finally {
    models.Pedido.findById = originals.pedidoFindById;
    models.Pedido.findOneAndUpdate = originals.pedidoFindOneAndUpdate;
    models.Pedido.updateOne = originals.pedidoUpdateOne;
    models.Estoque.find = originals.estoqueFind;
    models.Estoque.findOne = originals.estoqueFindOne;
    models.Estoque.updateOne = originals.estoqueUpdateOne;
  }
});

test("worker antigo não renova nem libera lease de outro worker", async () => {
  const original = models.Pedido.updateOne;
  models.Pedido.updateOne = async filter => {
    assert.equal(filter.estoqueLockId, "worker-antigo");
    return { modifiedCount: 0 };
  };
  try {
    await assert.rejects(
      estoqueService._testing.renovarLock(
        PEDIDO,
        "worker-antigo",
        "baixando",
      ),
      error => error.code === "ESTOQUE_LOCK_PERDIDO",
    );
    await assert.rejects(
      estoqueService._testing.liberarLock(
        PEDIDO,
        "worker-antigo",
        { estoqueProcessamento: "concluido" },
      ),
      error => error.code === "ESTOQUE_LOCK_PERDIDO",
    );
  } finally {
    models.Pedido.updateOne = original;
  }
});

test("pedido antigo baixado sem snapshot exige reconciliação", async () => {
  const originals = {
    findById: models.Pedido.findById,
    updateOne: models.Pedido.updateOne,
  };
  const pedido = {
    _id: PEDIDO,
    estoqueBaixado: true,
    estoqueRestaurado: false,
    estoqueSnapshotCriado: false,
  };
  models.Pedido.findById = async () => pedido;
  let reconciliacao = false;
  models.Pedido.updateOne = async (filter, update) => {
    reconciliacao =
      update.$set.estoqueProcessamento === "reconciliacao_necessaria";
    return { modifiedCount: 1 };
  };
  try {
    const result = await estoqueService.restaurarEstoqueDoPedido(PEDIDO);
    assert.equal(result.status, "reconciliacao_necessaria");
    assert.equal(result.errorCode, "ESTOQUE_LEGADO_SEM_SNAPSHOT");
    assert.equal(reconciliacao, true);
  } finally {
    models.Pedido.findById = originals.findById;
    models.Pedido.updateOne = originals.updateOne;
  }
});

test("histórico financeiro manual é idempotente por operationKey", () => {
  const pedido = {
    total: 50,
    formaPagamento: "dinheiro",
    historicoFinanceiro: [],
  };
  const entrada = {
    tipo: "pagamento_manual",
    statusAnterior: "pendente",
    statusNovo: "pago",
    operationKey: "pagamento_manual:pedido",
  };
  assert.equal(admin._testing.adicionarHistoricoFinanceiro(pedido, entrada), true);
  assert.equal(admin._testing.adicionarHistoricoFinanceiro(pedido, entrada), false);
  assert.equal(pedido.historicoFinanceiro.length, 1);
});
