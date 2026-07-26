"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const admin = require("../src/controllers/adminRealController");
const models = require("../src/models/painelModels");

const LOJA = "507f191e810c19729de860ea";
const OUTRA_LOJA = "507f191e810c19729de860eb";
const INGREDIENTE = "507f191e810c19729de860ec";

function req(overrides = {}) {
  return {
    params: { id: INGREDIENTE },
    body: {},
    session: {
      user: { id: LOJA, estabelecimentoId: LOJA, tipo: "proprietario" },
    },
    ...overrides,
  };
}

function res() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function selectable(value) {
  return { select: async () => value };
}

function mocks({
  referencias = { quantidadeProdutos: 0, produtos: [] },
  atualizado = { _id: INGREDIENTE, ativo: false },
  existente = null,
} = {}) {
  const originals = {
    aggregate: models.Produto.aggregate,
    findOneAndUpdate: models.Estoque.findOneAndUpdate,
    findOne: models.Estoque.findOne,
    deleteOne: models.Estoque.deleteOne,
  };
  const calls = {
    aggregate: [],
    updates: [],
    finds: [],
    deletes: 0,
  };
  models.Produto.aggregate = async pipeline => {
    calls.aggregate.push(pipeline);
    return [referencias];
  };
  models.Estoque.findOneAndUpdate = async (filter, update, options) => {
    calls.updates.push({ filter, update, options });
    return atualizado;
  };
  models.Estoque.findOne = filter => {
    calls.finds.push(filter);
    return selectable(existente);
  };
  models.Estoque.deleteOne = async () => {
    calls.deletes += 1;
    throw new Error("deleteOne não pode ser chamado");
  };
  return {
    calls,
    restore() {
      models.Produto.aggregate = originals.aggregate;
      models.Estoque.findOneAndUpdate = originals.findOneAndUpdate;
      models.Estoque.findOne = originals.findOne;
      models.Estoque.deleteOne = originals.deleteOne;
    },
  };
}

test("ingrediente livre é desativado com auditoria e nunca excluído", async () => {
  const mock = mocks();
  const response = res();
  try {
    await admin.excluirEstoque(req(), response);
    assert.equal(response.payload.status, "desativado");
    assert.equal(mock.calls.updates.length, 1);
    assert.equal(mock.calls.deletes, 0);
    const { filter, update } = mock.calls.updates[0];
    assert.equal(String(filter.estabelecimentoId), LOJA);
    assert.deepEqual(filter.ativo, { $ne: false });
    assert.equal(update.$set.ativo, false);
    assert.ok(update.$set.desativadoEm instanceof Date);
    assert.equal(String(update.$set.desativadoPor), LOJA);
    assert.equal(update.$push.auditoria.tipo, "ingrediente_desativado");
    assert.match(update.$push.auditoria.operationKey, /ingrediente_desativado/);
  } finally {
    mock.restore();
  }
});

test("histórico e snapshot não mudam a regra: sempre desativação lógica", async () => {
  const mock = mocks();
  try {
    await admin.excluirEstoque(req(), res());
    assert.equal(mock.calls.updates.length, 1);
    assert.equal(mock.calls.deletes, 0);
    assert.equal(
      JSON.stringify(mock.calls.aggregate).includes("estoqueConsumos"),
      false,
    );
  } finally {
    mock.restore();
  }
});

test("ingrediente em ficha retorna 409 usando uma agregação", async () => {
  const mock = mocks({
    referencias: {
      quantidadeProdutos: 12,
      produtos: Array.from({ length: 10 }, (_, i) => `Produto ${i + 1}`),
    },
  });
  const response = res();
  try {
    await admin.excluirEstoque(req(), response);
    assert.equal(response.statusCode, 409);
    assert.deepEqual(Object.keys(response.payload).sort(), [
      "message",
      "produtos",
      "quantidadeProdutos",
    ]);
    assert.equal(response.payload.quantidadeProdutos, 12);
    assert.equal(response.payload.produtos.length, 10);
    assert.match(response.payload.message, /antes de desativar/);
    assert.equal(mock.calls.aggregate.length, 1);
    assert.equal(mock.calls.updates.length, 0);
  } finally {
    mock.restore();
  }
});

test("agregação limita nomes e isola o estabelecimento da sessão", async () => {
  const mock = mocks();
  try {
    await admin.excluirEstoque(req({
      body: { estabelecimentoId: OUTRA_LOJA },
    }), res());
    const pipeline = mock.calls.aggregate[0];
    assert.equal(String(pipeline[0].$match.estabelecimentoId), LOJA);
    assert.equal(pipeline[1].$facet.produtos[1].$limit, 10);
    assert.equal(
      JSON.stringify(pipeline).includes(OUTRA_LOJA),
      false,
    );
  } finally {
    mock.restore();
  }
});

test("ingrediente já desativado responde 200 sem nova auditoria", async () => {
  const mock = mocks({
    atualizado: null,
    existente: { _id: INGREDIENTE, ativo: false },
  });
  const response = res();
  try {
    await admin.excluirEstoque(req(), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.status, "ja_desativado");
    assert.equal(mock.calls.updates.length, 1);
    assert.equal(mock.calls.deletes, 0);
  } finally {
    mock.restore();
  }
});

test("ingrediente ausente ou de outra loja retorna 404", async () => {
  const mock = mocks({ atualizado: null, existente: null });
  const response = res();
  try {
    await admin.excluirEstoque(req(), response);
    assert.equal(response.statusCode, 404);
    assert.equal(mock.calls.deletes, 0);
    assert.ok(mock.calls.finds.every(filter =>
      String(filter.estabelecimentoId) === LOJA));
  } finally {
    mock.restore();
  }
});

test("ficha nova rejeita ingrediente desativado", async () => {
  const original = models.Estoque.find;
  models.Estoque.find = () => ({
    lean: async () => [{
      _id: INGREDIENTE,
      nome: "Farinha",
      unidade: "kg",
      custoUnitario: 1,
      ativo: false,
    }],
  });
  try {
    await assert.rejects(
      admin._testing.montarFichaTecnicaProduto({
        fichaEstoqueId: [INGREDIENTE],
        fichaQuantidade: ["1"],
        fichaUnidade: ["g"],
      }, LOJA),
      error => error.code === "INGREDIENTE_DESATIVADO",
    );
  } finally {
    models.Estoque.find = original;
  }
});

test("edição pode preservar, remover ou substituir referência legada", async () => {
  const ATIVO = "507f191e810c19729de860ed";
  const original = models.Estoque.find;
  models.Estoque.find = filter => ({
    lean: async () => (filter._id.$in || []).map(id => ({
      _id: id,
      nome: String(id) === INGREDIENTE ? "Legado" : "Ativo",
      unidade: "kg",
      custoUnitario: 1,
      ativo: String(id) === INGREDIENTE ? false : true,
    })),
  });
  try {
    const anterior = [{ estoqueId: INGREDIENTE }];
    const preservada = await admin._testing.montarFichaTecnicaProduto({
      fichaEstoqueId: [INGREDIENTE],
      fichaQuantidade: ["1"],
      fichaUnidade: ["g"],
    }, LOJA, { fichaAnterior: anterior });
    assert.equal(String(preservada[0].estoqueId), INGREDIENTE);
    assert.deepEqual(
      await admin._testing.montarFichaTecnicaProduto(
        {},
        LOJA,
        { fichaAnterior: anterior },
      ),
      [],
    );
    const substituida = await admin._testing.montarFichaTecnicaProduto({
      fichaEstoqueId: [ATIVO],
      fichaQuantidade: ["1"],
      fichaUnidade: ["g"],
    }, LOJA, { fichaAnterior: anterior });
    assert.equal(String(substituida[0].estoqueId), ATIVO);
  } finally {
    models.Estoque.find = original;
  }
});

test("painel busca somente desativados referenciados por produtos carregados", () => {
  const ATIVO = "507f191e810c19729de860ed";
  assert.deepEqual(
    admin._testing.idsDeIngredientesDesativadosReferenciados(
      [{ _id: ATIVO, ativo: true }],
      [{
        fichaTecnica: [
          { estoqueId: ATIVO },
          { estoqueId: INGREDIENTE },
          { estoqueId: INGREDIENTE },
        ],
      }],
    ),
    [INGREDIENTE],
  );
});

test("ingrediente desativado não pode ser copiado para outro produto", async () => {
  const original = models.Estoque.find;
  models.Estoque.find = () => ({
    lean: async () => [{
      _id: INGREDIENTE,
      nome: "Legado",
      unidade: "kg",
      custoUnitario: 1,
      ativo: false,
    }],
  });
  try {
    await assert.rejects(
      admin._testing.montarFichaTecnicaProduto({
        fichaEstoqueId: [INGREDIENTE],
        fichaQuantidade: ["1"],
        fichaUnidade: ["g"],
      }, LOJA, {
        fichaAnterior: [{ estoqueId: "507f191e810c19729de860ff" }],
      }),
      error => error.code === "INGREDIENTE_DESATIVADO",
    );
  } finally {
    models.Estoque.find = original;
  }
});

test("validação final detecta desativação concorrente", async () => {
  const original = models.Estoque.countDocuments;
  models.Estoque.countDocuments = async () => 0;
  try {
    await assert.rejects(
      admin._testing.validarFichaAntesDeSalvar(
        [{ estoqueId: INGREDIENTE }],
        LOJA,
      ),
      error => error.code === "INGREDIENTE_DESATIVADO",
    );
  } finally {
    models.Estoque.countDocuments = original;
  }
});

test("frontend exibe a mensagem HTTP retornada", () => {
  const view = fs.readFileSync(
    require.resolve("../src/views/admin-real.ejs"),
    "utf8",
  );
  assert.match(view, /throw new Error\(result\.message/);
  assert.match(view, /alert\(error\.message\)/);
  assert.match(view, /— desativado/);
  assert.match(view, /data-desativado="true"/);
});
