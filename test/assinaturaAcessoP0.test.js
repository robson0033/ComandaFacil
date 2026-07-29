"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const admin = require("../src/controllers/adminRealController");
const pagamento = require("../src/controllers/pagamentoController");
const assinaturaMiddleware = require("../src/middleware/assinatura");
const auth = require("../src/middleware/auth");
const models = require("../src/models/painelModels");
const printQueueService = require("../src/services/printQueueService");
const {
  avaliarAcessoVenda,
  consultarAcessoVenda,
} = require("../src/services/assinaturaAcessoService");

const LOJA = "507f191e810c19729de860ea";
const PEDIDO = "507f191e810c19729de860eb";
const AGORA = new Date("2026-07-25T12:00:00.000Z");

function res() {
  return {
    statusCode: 200,
    payload: null,
    rendered: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    send(payload) { this.payload = payload; return this; },
    render(view, data) { this.rendered = { view, data }; return this; },
    redirect(url) { this.redirectedTo = url; return this; },
  };
}

test("regra central permite somente teste vigente ou plano pago vigente", () => {
  const teste = avaliarAcessoVenda({
    assinatura: {
      status: "teste",
      fimTeste: new Date(AGORA.getTime() + 1),
    },
    agora: AGORA,
  });
  assert.equal(teste.permitido, true);
  assert.equal(teste.status, "teste");

  const ativa = avaliarAcessoVenda({
    assinatura: {
      status: "ativa",
      ultimoPagamentoAprovadoId: "pagamento",
      planoExpira: new Date(AGORA.getTime() + 1),
    },
    agora: AGORA,
  });
  assert.equal(ativa.permitido, true);
  assert.equal(ativa.status, "ativa");
});

test("regra bloqueia teste vencido, plano vencido, cancelada e ausente", () => {
  const casos = [
    { status: "teste", fimTeste: new Date(AGORA.getTime() - 1) },
    {
      status: "ativa",
      ultimoPagamentoAprovadoId: "pagamento",
      planoExpira: new Date(AGORA.getTime() - 1),
    },
    { status: "cancelada", fimTeste: new Date(AGORA.getTime() + 60_000) },
    null,
  ];
  for (const assinatura of casos) {
    assert.equal(
      avaliarAcessoVenda({ assinatura, agora: AGORA }).permitido,
      false,
    );
  }
});

test("data exatamente no limite já está vencida", () => {
  const resultado = avaliarAcessoVenda({
    assinatura: { status: "teste", fimTeste: AGORA },
    agora: AGORA,
  });
  assert.equal(resultado.permitido, false);
  assert.equal(resultado.status, "vencida");
});

test("estabelecimento bloqueado prevalece sobre assinatura válida", () => {
  const resultado = avaliarAcessoVenda({
    estabelecimento: { bloqueado: true },
    assinatura: {
      status: "teste",
      fimTeste: new Date(AGORA.getTime() + 60_000),
    },
    agora: AGORA,
  });
  assert.equal(resultado.permitido, false);
  assert.equal(resultado.status, "bloqueada");
});

test("consulta de assinatura fica isolada pelo estabelecimento resolvido", async () => {
  const original = models.Assinatura.findOne;
  let filtro;
  models.Assinatura.findOne = recebido => {
    filtro = recebido;
    return { lean: async () => null };
  };
  try {
    await consultarAcessoVenda({ estabelecimentoId: LOJA });
    assert.deepEqual(filtro, { estabelecimentoId: LOJA });
  } finally {
    models.Assinatura.findOne = original;
  }
});

function mockLojaSemAssinatura() {
  const originals = {
    configuracaoFindOne: models.Configuracao.findOne,
    assinaturaFindOne: models.Assinatura.findOne,
    produtoFind: models.Produto.find,
    pedidoFindOne: models.Pedido.findOne,
    estoqueUpdateOne: models.Estoque.updateOne,
    criarPedido: printQueueService.criarPedidoComJobsAutomaticos,
  };
  let produtosConsultados = 0;
  let pedidosCriados = 0;
  let estoqueMovimentado = 0;
  let configuracoesConsultadas = 0;
  models.Configuracao.findOne = () => {
    configuracoesConsultadas += 1;
    return {
      lean: async () => ({
        estabelecimentoId: LOJA,
        slug: "loja",
        ativo: true,
        nomeEstabelecimento: "Loja",
      }),
    };
  };
  models.Assinatura.findOne = () => ({ lean: async () => null });
  models.Produto.find = () => {
    produtosConsultados += 1;
    return { lean: async () => [] };
  };
  models.Pedido.findOne = async () => ({
    _id: PEDIDO,
    estabelecimentoId: LOJA,
    pagamentoStatus: "pendente",
    mercadoPagoPaymentId: "",
    pixCopiaCola: "",
  });
  models.Estoque.updateOne = async () => {
    estoqueMovimentado += 1;
    return { modifiedCount: 1 };
  };
  printQueueService.criarPedidoComJobsAutomaticos = async () => {
    pedidosCriados += 1;
    return { _id: PEDIDO };
  };
  return {
    get produtosConsultados() { return produtosConsultados; },
    get pedidosCriados() { return pedidosCriados; },
    get estoqueMovimentado() { return estoqueMovimentado; },
    get configuracoesConsultadas() { return configuracoesConsultadas; },
    restore() {
      models.Configuracao.findOne = originals.configuracaoFindOne;
      models.Assinatura.findOne = originals.assinaturaFindOne;
      models.Produto.find = originals.produtoFind;
      models.Pedido.findOne = originals.pedidoFindOne;
      models.Estoque.updateOne = originals.estoqueUpdateOne;
      printQueueService.criarPedidoComJobsAutomaticos = originals.criarPedido;
    },
  };
}

test("cardápio indisponível não carrega produtos para venda", async () => {
  const mock = mockLojaSemAssinatura();
  const response = res();
  try {
    await admin.catalogoPublico(
      { params: { slug: "loja" } },
      response,
    );
    assert.equal(response.rendered.view, "catalogo-publico");
    assert.equal(response.rendered.data.lojaDisponivel, false);
    assert.deepEqual(response.rendered.data.produtos, []);
    assert.equal(mock.produtosConsultados, 0);
  } finally {
    mock.restore();
  }
});

test("pedido público bloqueado retorna 403 sem Pedido, PrintJob ou estoque", async () => {
  const mock = mockLojaSemAssinatura();
  const response = res();
  try {
    await admin.criarPedidoCatalogo(
      { params: { slug: "loja" }, body: {} },
      response,
    );
    assert.equal(response.statusCode, 403);
    assert.equal(response.payload.code, "LOJA_INDISPONIVEL");
    assert.equal(mock.pedidosCriados, 0);
    assert.equal(mock.estoqueMovimentado, 0);
    assert.equal(mock.produtosConsultados, 0);
  } finally {
    mock.restore();
  }
});

test("Pix novo é bloqueado antes de consultar credencial ou criar cobrança", async () => {
  const mock = mockLojaSemAssinatura();
  const response = res();
  try {
    await pagamento.gerarPixPedido(
      {
        params: { slug: "loja" },
        headers: { authorization: `Bearer ${"A".repeat(43)}` },
      },
      response,
    );
    assert.equal(response.statusCode, 403);
    assert.equal(response.payload.code, "LOJA_INDISPONIVEL");
    assert.equal(mock.configuracoesConsultadas, 1);
  } finally {
    mock.restore();
  }
});

test("proprietário vencido é redirecionado antes de acessar pedidos", () => {
  const owner = {
    path: "/admin/pedidos",
    session: {
      user: { tipo: "proprietario" },
      save(callback) { callback(); },
    },
    flash() {},
  };
  owner.assinaturaAcessoLiberado = false;
  const response = res();
  let operacaoLiberada = false;
  assinaturaMiddleware.assinaturaRequired(
    owner,
    response,
    () => { operacaoLiberada = true; },
  );
  assert.equal(operacaoLiberada, false);
  assert.equal(response.redirectedTo, "/assinatura");
});

test("API, SSE e impressão vencidas retornam 403 padronizado", () => {
  for (const caso of [
    { path: "/admin/api/pedidos/novos", accept: "application/json" },
    { path: "/admin/api/pedidos/stream", accept: "text/event-stream" },
    { path: `/admin/api/pedidos/${PEDIDO}/impressao`, accept: "application/json" },
    { path: `/admin/agente/pedidos/${PEDIDO}/imprimir`, contentType: "application/json" },
  ]) {
    const request = {
      path: caso.path,
      assinaturaAcessoLiberado: false,
      session: { user: { tipo: "proprietario" } },
      get(nome) {
        if (nome === "accept") return caso.accept || "";
        if (nome === "content-type") return caso.contentType || "";
        return "";
      },
    };
    const response = res();
    assinaturaMiddleware.assinaturaRequired(
      request,
      response,
      () => assert.fail("controller não pode ser executado"),
    );
    assert.equal(response.statusCode, 403);
    assert.equal(response.payload.code, "ASSINATURA_NECESSARIA");
  }
});

test("funcionário vencido permanece totalmente bloqueado", () => {
  const employee = {
    path: "/admin",
    session: { user: { tipo: "funcionario" } },
    assinaturaAcessoLiberado: false,
    get() { return ""; },
  };
  const employeeResponse = res();
  assinaturaMiddleware.assinaturaRequired(
    employee,
    employeeResponse,
    () => assert.fail("funcionário não pode avançar"),
  );
  assert.equal(employeeResponse.statusCode, 403);
});

test("renovação confirmada reativa o middleware sem alterar pedidos", () => {
  let liberado = false;
  const original = models.Pedido.find;
  models.Pedido.find = () => assert.fail("middleware não consulta pedidos");
  try {
    assinaturaMiddleware.assinaturaRequired(
      { assinaturaAcessoLiberado: true },
      res(),
      () => { liberado = true; },
    );
    assert.equal(liberado, true);
  } finally {
    models.Pedido.find = original;
  }
});

test("assinatura, callback, webhook e logout permanecem fora do bloqueio operacional", () => {
  let ownerSubscription = false;
  auth.somenteProprietario(
    { session: { user: { tipo: "proprietario" } } },
    res(),
    () => { ownerSubscription = true; },
  );
  assert.equal(ownerSubscription, true);
  const routes = fs.readFileSync("route.js", "utf8");
  assert.match(routes, /'\/assinatura'[\s\S]*?somenteProprietario[\s\S]*?pagamento\.pagina/);
  assert.match(routes, /'\/assinatura\/retorno'[\s\S]*?pagamento\.retorno/);
  assert.match(routes, /'\/webhook\/mercado-pago'[\s\S]*?pagamento\.webhook/);
  assert.match(routes, /'\/login\/logout'[\s\S]*?loginController\.logout/);
  const assinaturaView = fs.readFileSync("src/views/assinatura.ejs", "utf8");
  assert.match(assinaturaView, />Assinatura</);
  assert.match(assinaturaView, /form action="\/login\/logout" method="POST"/);
  assert.match(assinaturaView, /name="_csrf"/);
  assert.doesNotMatch(assinaturaView, /href="\/admin">Voltar ao painel/);
});

test("views tratam indisponibilidade sem expor motivo financeiro", () => {
  const catalogo = fs.readFileSync("src/views/catalogo-publico.ejs", "utf8");
  const mesa = fs.readFileSync("src/views/mesa-publica.ejs", "utf8");
  for (const view of [catalogo, mesa]) {
    assert.match(
      view,
      /Esta loja está temporariamente indisponível para novos pedidos\./,
    );
    assert.doesNotMatch(view, /dívida|valor da assinatura|paymentId/i);
  }
  assert.match(catalogo, /LOJA_INDISPONIVEL/);
  assert.match(mesa, /LOJA_INDISPONIVEL/);
});
