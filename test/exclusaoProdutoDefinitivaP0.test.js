"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const mongoose = require("mongoose");
const models = require("../src/models/painelModels");
const storageService = require("../src/services/storageService");
const estoqueService = require("../src/services/estoqueService");
const admin = require("../src/controllers/adminRealController");
const duplicateAudit = require("../scripts/auditar-produtos-duplicados");

const LOJA = "507f191e810c19729de860ea";
const OUTRA_LOJA = "507f191e810c19729de860ef";
const PRODUTO = "507f191e810c19729de860eb";
const INGREDIENTE = "507f191e810c19729de860ec";

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

function request(id = PRODUTO) {
  return {
    params: { id },
    correlationId: "CORRELATION",
    session: {
      user: {
        id: LOJA,
        estabelecimentoId: LOJA,
        tipo: "proprietario",
      },
    },
  };
}

function sessionQuery(value) {
  return { session: async () => value };
}

async function withDeletionMocks(run, {
  product = {
    _id: PRODUTO,
    estabelecimentoId: LOJA,
    nome: "Xburguer",
    custo: 4,
    fichaTecnica: [{
      estoqueId: INGREDIENTE,
      nome: "Carne",
      quantidade: 1,
      unidade: "un",
      custoCalculado: 4,
    }],
    imagemArquivo: {
      storageKey: `estabelecimentos/${LOJA}/produtos/imagem.webp`,
    },
  },
  sharedImage = false,
  cleanupFails = false,
} = {}) {
  const originals = {
    startSession: mongoose.startSession,
    findOne: models.Produto.findOne,
    exists: models.Produto.exists,
    deleteOne: models.Produto.deleteOne,
    create: models.Produto.create,
    updateMany: models.Pedido.updateMany,
  };
  const calls = {
    created: 0,
    deleted: [],
    orders: [],
    cleanup: [],
    ended: 0,
  };
  mongoose.startSession = async () => ({
    async withTransaction(callback) {
      await callback();
    },
    async endSession() {
      calls.ended += 1;
    },
  });
  models.Produto.findOne = filter => {
    calls.findFilter = filter;
    return sessionQuery(product);
  };
  models.Produto.exists = filter => {
    calls.sharedFilter = filter;
    return sessionQuery(sharedImage);
  };
  models.Produto.deleteOne = async (filter, options) => {
    calls.deleted.push({ filter, options });
    return { deletedCount: 1 };
  };
  models.Produto.create = async () => {
    calls.created += 1;
    throw new Error("Produto.create não deve ser chamado");
  };
  models.Pedido.updateMany = async (filter, update, options) => {
    calls.orders.push({ filter, update, options });
    return { modifiedCount: 1 };
  };
  storageService.setAdapterForTests({
    async remove(key, context) {
      calls.cleanup.push({ key, context });
      if (cleanupFails) throw new Error("cloudinary indisponível");
      return { removed: true };
    },
  });

  try {
    return await run(calls);
  } finally {
    mongoose.startSession = originals.startSession;
    models.Produto.findOne = originals.findOne;
    models.Produto.exists = originals.exists;
    models.Produto.deleteOne = originals.deleteOne;
    models.Produto.create = originals.create;
    models.Pedido.updateMany = originals.updateMany;
    storageService.setAdapterForTests(null);
  }
}

test("exclusão remove exatamente o produto da loja e não cria outro", async () => {
  await withDeletionMocks(async calls => {
    const res = response();
    let nextError;
    await admin.excluirProduto(request(), res, error => {
      nextError = error;
    });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.code, "PRODUCT_DELETED");
    assert.equal(res.body.produtoId, PRODUTO);
    assert.deepEqual(calls.findFilter, {
      _id: PRODUTO,
      estabelecimentoId: LOJA,
    });
    assert.equal(calls.deleted.length, 1);
    assert.equal(String(calls.deleted[0].filter.estabelecimentoId), LOJA);
    assert.equal(calls.created, 0);
    assert.equal(calls.cleanup.length, 1);
    assert.equal(calls.ended, 1);
  });
});

test("antes do hard delete materializa ficha nos pedidos sem apagar estoque", async () => {
  await withDeletionMocks(async calls => {
    await admin.excluirProduto(request(), response(), () => {});
    assert.equal(calls.orders.length, 1);
    assert.equal(calls.orders[0].filter.estabelecimentoId, LOJA);
    assert.equal(calls.orders[0].filter["itens.produtoId"], PRODUTO);
    assert.equal(
      calls.orders[0].update.$set[
        "itens.$[item].fichaTecnicaSnapshotCriado"
      ],
      true,
    );
    assert.equal(
      calls.orders[0].update.$set[
        "itens.$[item].fichaTecnicaSnapshot"
      ][0].estoqueId,
      INGREDIENTE,
    );
    assert.equal("Estoque" in calls, false);
  });
});

test("produto inexistente ou de outra loja retorna 404 neutro", async () => {
  await withDeletionMocks(async calls => {
    const res = response();
    await admin.excluirProduto(request(), res, () => {});
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, "PRODUCT_NOT_FOUND");
    assert.equal(calls.deleted.length, 0);
    assert.equal(calls.cleanup.length, 0);
  }, { product: null });
});

test("ID inválido é rejeitado antes de abrir transação", async () => {
  const original = mongoose.startSession;
  let connected = false;
  mongoose.startSession = async () => {
    connected = true;
  };
  try {
    const res = response();
    await admin.excluirProduto(request("id-invalido"), res, () => {});
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, "PRODUCT_ID_INVALID");
    assert.equal(connected, false);
  } finally {
    mongoose.startSession = original;
  }
});

test("falha da transação é encaminhada e não executa hard delete parcial", async () => {
  const originals = {
    startSession: mongoose.startSession,
    deleteOne: models.Produto.deleteOne,
  };
  let deleted = false;
  let ended = false;
  mongoose.startSession = async () => ({
    async withTransaction() {
      throw new Error("transactions are not supported");
    },
    async endSession() {
      ended = true;
    },
  });
  models.Produto.deleteOne = async () => {
    deleted = true;
    return { deletedCount: 1 };
  };
  try {
    let nextError;
    await admin.excluirProduto(request(), response(), error => {
      nextError = error;
    });
    assert.match(nextError.message, /transactions are not supported/);
    assert.equal(deleted, false);
    assert.equal(ended, true);
  } finally {
    mongoose.startSession = originals.startSession;
    models.Produto.deleteOne = originals.deleteOne;
  }
});

test("imagem compartilhada não é removida", async () => {
  await withDeletionMocks(async calls => {
    await admin.excluirProduto(request(), response(), () => {});
    assert.equal(calls.cleanup.length, 0);
    assert.equal(calls.sharedFilter.estabelecimentoId, LOJA);
  }, { sharedImage: true });
});

test("falha externa não recria nem desfaz produto já excluído", async () => {
  await withDeletionMocks(async calls => {
    const res = response();
    await admin.excluirProduto(request(), res, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.limpezaImagemPendente, true);
    assert.equal(calls.deleted.length, 1);
    assert.equal(calls.created, 0);
  }, { cleanupFails: true });
});

test("estoque usa snapshot do item mesmo depois do produto desaparecer", () => {
  const consumos = estoqueService.montarConsumosDoPedido({
    itens: [{
      produtoId: PRODUTO,
      quantidade: 2,
      fichaTecnicaSnapshotCriado: true,
      fichaTecnicaSnapshot: [{
        estoqueId: INGREDIENTE,
        quantidade: 1,
        unidade: "un",
      }],
    }],
  }, []);
  assert.equal(consumos.length, 1);
  assert.equal(consumos[0].quantidadeConsumida, 2);
  assert.equal(String(consumos[0].produtoId), PRODUTO);
});

test("frontend usa botão independente, DELETE único e remove o card", () => {
  const view = fs.readFileSync("src/views/admin-real.ejs", "utf8");
  assert.match(view, /class="mini-button delete btn-excluir-produto"/);
  assert.match(view, /type="button"[\s\S]*btn-excluir-produto/);
  assert.doesNotMatch(view, /<form[\s\S]{0,300}data-product-delete/);
  assert.match(view, /button\.dataset\.loading === 'true'/);
  assert.match(view, /method:\s*'DELETE'/);
  assert.match(view, /payload\.code !== 'PRODUCT_DELETED'/);
  assert.match(view, /\[data-product-card="\$\{CSS\.escape\(produtoId\)\}"\][\s\S]*\?\.remove\(\)/);
  assert.match(view, /window\.location\.hash = '#catalogo'/);
  assert.equal(
    [...view.matchAll(/closest\('\.btn-excluir-produto'\)/g)].length,
    1,
  );
});

test("rota DELETE preserva todas as proteções", () => {
  const routes = fs.readFileSync("route.js", "utf8");
  assert.match(
    routes,
    /route\.delete\(\s*'\/admin\/produtos\/:id',[\s\S]*?loginRequired,[\s\S]*?assinaturaRequired,[\s\S]*?permissao\('catalogo'\),[\s\S]*?admin\.excluirProduto/,
  );
});

test("auditoria de duplicados pagina e não conecta sem autorização", async () => {
  let calls = 0;
  const batches = [
    [
      {
        _id: "1",
        estabelecimentoId: LOJA,
        nome: "Xbúrguer",
        categoriaId: "cat",
        preco: 20,
        ativo: false,
      },
      {
        _id: "2",
        estabelecimentoId: LOJA,
        nome: "  xburguer ",
        categoriaId: "cat",
        preco: 20,
        ativo: true,
      },
    ],
    [],
  ];
  const report = await duplicateAudit.auditProducts({
    batchSize: 2,
    source: {
      async nextBatch() {
        return batches[calls++] || [];
      },
    },
  });
  assert.equal(report.analyzed, 2);
  assert.equal(report.duplicateGroups, 1);

  let connected = false;
  const result = await duplicateAudit.main({
    env: {},
    connect: async () => {
      connected = true;
    },
    logger: { error() {}, log() {} },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(connected, false);
});

test("script de diagnóstico não contém operação de escrita", () => {
  const source = fs.readFileSync(
    "scripts/auditar-produtos-duplicados.js",
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\.(?:create|insertMany|updateOne|updateMany|deleteOne|deleteMany|bulkWrite)\s*\(/,
  );
  assert.match(source, /ALLOW_READONLY_AUDIT/);
});

test("isolamento não aceita estabelecimento do body", () => {
  const controller = fs.readFileSync(
    "src/controllers/adminRealController.js",
    "utf8",
  );
  const block = controller.match(
    /exports\.excluirProduto[\s\S]*?\/\*\n\|[-\s]*\| MESAS/,
  )?.[0] || "";
  assert.match(block, /const idEstabelecimento = estabelecimentoId\(req\)/);
  assert.doesNotMatch(block, /req\.body[^;\n]*estabelecimentoId/);
  assert.doesNotMatch(block, /findByIdAndDelete|findById\(/);
});
