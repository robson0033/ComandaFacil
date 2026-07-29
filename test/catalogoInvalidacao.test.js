"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const admin = require("../src/controllers/adminRealController");
const models = require("../src/models/painelModels");
const printQueueService = require("../src/services/printQueueService");

const LOJA = "507f191e810c19729de860ea";
const PRODUTO = "507f191e810c19729de860eb";
const OUTRO_PRODUTO = "507f191e810c19729de860ec";

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function requisicao(itens) {
  return {
    params: { slug: "loja-teste" },
    body: {
      cliente: "Cliente",
      telefone: "71999999999",
      canal: "retirada",
      formaPagamento: "cartao",
      itens,
    },
  };
}

function configurarMocks({
  produtos = [],
  ingredientesAtivos,
  criarPedido,
} = {}) {
  const originals = {
    configuracaoFindOne: models.Configuracao.findOne,
    produtoFind: models.Produto.find,
    estoqueFind: models.Estoque.find,
    assinaturaFindOne: models.Assinatura.findOne,
    criarPedido: printQueueService.criarPedidoComJobsAutomaticos,
  };
  models.Configuracao.findOne = () => ({
    lean: async () => ({
      estabelecimentoId: LOJA,
      horarioAbertura: "00:00",
      horarioFechamento: "00:00",
      diasFuncionamento: [0, 1, 2, 3, 4, 5, 6],
    }),
  });
  models.Produto.find = () => ({
    lean: async () => produtos,
  });
  models.Assinatura.findOne = () => ({
    lean: async () => ({
      status: "teste",
      fimTeste: new Date(Date.now() + 60_000),
    }),
  });
  models.Estoque.find = () => ({
    select() { return this; },
    lean: async () => ingredientesAtivos ?? produtos.flatMap(produto =>
      (produto.fichaTecnica || []).map(item => ({ _id: item.estoqueId }))),
  });
  let criacoes = 0;
  printQueueService.criarPedidoComJobsAutomaticos = async payload => {
    criacoes += 1;
    return criarPedido ? criarPedido(payload) : { _id: "pedido", numeroPedido: 1 };
  };
  return {
    get criacoes() {
      return criacoes;
    },
    restore() {
      models.Configuracao.findOne = originals.configuracaoFindOne;
      models.Produto.find = originals.produtoFind;
      models.Estoque.find = originals.estoqueFind;
      models.Assinatura.findOne = originals.assinaturaFindOne;
      printQueueService.criarPedidoComJobsAutomaticos = originals.criarPedido;
    },
  };
}

test("produto indisponível retorna 409 antes de criar pedido ou PrintJob", async () => {
  const mock = configurarMocks({ produtos: [] });
  const res = response();
  try {
    await admin.criarPedidoCatalogo(
      requisicao([
        { produtoId: PRODUTO, preco: 10, quantidade: 1, adicionais: [] },
        { produtoId: OUTRO_PRODUTO, preco: 20, quantidade: 1, adicionais: [] },
      ]),
      res,
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.code, "PRODUTO_INDISPONIVEL");
    assert.deepEqual(res.payload.produtosInvalidos, [PRODUTO, OUTRO_PRODUTO]);
    assert.equal(mock.criacoes, 0);
  } finally {
    mock.restore();
  }
});

test("produto de outra loja é indistinguível de produto inexistente", async () => {
  const mock = configurarMocks({ produtos: [] });
  const res = response();
  try {
    await admin.criarPedidoCatalogo(
      requisicao([{ produtoId: PRODUTO, preco: 10, quantidade: 1 }]),
      res,
    );
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.payload.produtosInvalidos, [PRODUTO]);
    assert.equal("estabelecimentoId" in res.payload, false);
  } finally {
    mock.restore();
  }
});

test("preço alterado retorna 409 e exige nova confirmação", async () => {
  const mock = configurarMocks({
    produtos: [{
      _id: PRODUTO,
      nome: "Produto atual",
      preco: 12,
      imagem: "imagem-atual",
      adicionais: [],
    }],
  });
  const res = response();
  try {
    await admin.criarPedidoCatalogo(
      requisicao([{ produtoId: PRODUTO, preco: 10, quantidade: 1 }]),
      res,
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.code, "PRECO_ATUALIZADO");
    assert.equal(res.payload.produtosAtualizados[0].preco, 12);
    assert.equal(mock.criacoes, 0);
  } finally {
    mock.restore();
  }
});

test("produto com ingrediente desativado é indisponível antes de criar pedido", async () => {
  const mock = configurarMocks({
    produtos: [{
      _id: PRODUTO,
      nome: "Produto",
      preco: 10,
      adicionais: [],
      fichaTecnica: [{ estoqueId: "507f191e810c19729de860ed" }],
    }],
    ingredientesAtivos: [],
  });
  const res = response();
  try {
    await admin.criarPedidoCatalogo(
      requisicao([{ produtoId: PRODUTO, preco: 10, quantidade: 1 }]),
      res,
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.code, "PRODUTO_INDISPONIVEL");
    assert.equal(mock.criacoes, 0);
  } finally {
    mock.restore();
  }
});

test("catálogo público usa rota de sincronização e storage isolado por slug", () => {
  const fs = require("node:fs");
  const view = fs.readFileSync("src/views/catalogo-publico.ejs", "utf8");
  assert.match(view, /`catalogo-cart-\$\{storeSlug\}`/);
  assert.match(view, /produtos-status/);
  assert.match(view, /visibilitychange/);
  assert.match(view, /PRODUTO_INDISPONIVEL/);
  assert.match(view, /preco:\s*Number\(item\.price\)/);
});

test("exclusão de produto é definitiva, multi-tenant e preserva snapshots", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync("src/controllers/adminRealController.js", "utf8");
  const inicio = source.indexOf("exports.excluirProduto");
  const fim = source.indexOf("CATÁLOGO PÚBLICO", inicio);
  const trecho = source.slice(inicio, fim);
  assert.match(trecho, /Produto\.deleteOne/);
  assert.match(trecho, /estabelecimentoId:\s*idEstabelecimento/);
  assert.match(trecho, /fichaTecnicaSnapshotCriado/);
  assert.doesNotMatch(trecho, /\$set:\s*\{\s*ativo:\s*false\s*\}/);
});
