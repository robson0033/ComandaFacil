"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
  Avaliacao,
  Configuracao,
  Pedido,
  Produto,
} = require("../src/models/painelModels");
const { registroModel } = require("../src/models/registroModel");
const { createRateLimiter } = require("../src/middleware/rateLimit");
const { securityHeaders } = require("../src/middleware/securityHeaders");
const tokenService = require("../src/services/pedidoPublicoTokenService");
const printQueueService = require("../src/services/printQueueService");
const trackingStorage = require("../public/js/pedidoTrackingStorage");
const admin = require("../src/controllers/adminRealController");

const TOKEN_TESTE = "A".repeat(43);
const LOJA_ID = "507f1f77bcf86cd799439011";

function queryLean(resultado, capturarSelecao = () => {}) {
  return {
    select(value) {
      capturarSelecao(value);
      return this;
    },
    lean: async () => resultado,
  };
}

function queryDocumento(resultado) {
  return {
    then(resolve, reject) {
      return Promise.resolve(resultado).then(resolve, reject);
    },
  };
}

function responseMock() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
  };
}

test("token usa 32 bytes em base64url, SHA-256 e validade de 90 dias", () => {
  const agora = new Date("2026-01-01T00:00:00.000Z");
  const gerado = tokenService.gerarTokenAcompanhamento(agora);
  assert.match(gerado.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(gerado.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(gerado.hash, gerado.token);
  assert.equal(gerado.hash, tokenService.hashToken(gerado.token));
  assert.equal(
    gerado.expiraEm.getTime() - gerado.criadoEm.getTime(),
    90 * 24 * 60 * 60 * 1000,
  );
});

test("criação persiste somente hash e entrega token puro fora do documento", async t => {
  const originais = {
    startSession: Pedido.startSession,
    create: Pedido.create,
    findOne: Pedido.findOne,
    configuracao: Configuracao.findOne,
    registro: registroModel.findById,
  };
  let persistido;
  Pedido.startSession = async () => ({
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  });
  Pedido.create = async ([dados]) => {
    persistido = dados;
    return [{ ...dados, _id: "507f1f77bcf86cd799439012" }];
  };
  Pedido.findOne = filtro => ({
    async select() {
      return { _id: filtro._id, estabelecimentoId: filtro.estabelecimentoId };
    },
  });
  Configuracao.findOne = () => queryLean({ impressoras: [] });
  registroModel.findById = () => queryLean({});
  t.after(() => {
    Pedido.startSession = originais.startSession;
    Pedido.create = originais.create;
    Pedido.findOne = originais.findOne;
    Configuracao.findOne = originais.configuracao;
    registroModel.findById = originais.registro;
  });

  const pedido = await printQueueService.criarPedidoComJobsAutomaticos({
    estabelecimentoId: LOJA_ID,
    itens: [],
    total: 0,
  });
  assert.match(pedido.acompanhamentoToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(persistido.acompanhamentoToken, undefined);
  assert.equal(
    persistido.acompanhamentoTokenHash,
    tokenService.hashToken(pedido.acompanhamentoToken),
  );
  assert.equal(Object.keys(pedido).includes("acompanhamentoToken"), false);
});

test("consulta válida vincula hash, loja, expiração e exclusão lógica", async t => {
  const original = Pedido.findOne;
  let filtro;
  let selecao;
  const esperado = { _id: "pedido" };
  Pedido.findOne = value => {
    filtro = value;
    return queryLean(esperado, value => { selecao = value; });
  };
  t.after(() => { Pedido.findOne = original; });

  const agora = new Date("2026-01-01T00:00:00.000Z");
  const pedido = await tokenService.buscarPedidoPorToken({
    estabelecimentoId: LOJA_ID,
    token: TOKEN_TESTE,
    agora,
  });
  assert.equal(pedido, esperado);
  assert.equal(filtro.estabelecimentoId, LOJA_ID);
  assert.equal(filtro.acompanhamentoTokenHash, tokenService.hashToken(TOKEN_TESTE));
  assert.deepEqual(filtro.acompanhamentoTokenExpiraEm, { $gt: agora });
  assert.deepEqual(filtro.excluido, { $ne: true });
  assert.equal(filtro.excluidoEm, null);
  assert.doesNotMatch(selecao, /telefone|email|payment|estoque|historico/i);
  assert.match(selecao, /itens\.produtoId/);
});

test("token inválido ou pedido antigo sem token não dispara consulta", async t => {
  const original = Pedido.findOne;
  let chamadas = 0;
  Pedido.findOne = () => { chamadas += 1; };
  t.after(() => { Pedido.findOne = original; });
  assert.equal(await tokenService.buscarPedidoPorToken({
    estabelecimentoId: LOJA_ID,
    token: "previsivel",
  }), null);
  assert.equal(await tokenService.buscarPedidoPorToken({
    estabelecimentoId: LOJA_ID,
  }), null);
  assert.equal(chamadas, 0);
});

test("token expirado e token de outra loja recebem resultado neutro do filtro", async t => {
  const original = Pedido.findOne;
  const filtros = [];
  Pedido.findOne = filtro => {
    filtros.push(filtro);
    return queryLean(null);
  };
  t.after(() => { Pedido.findOne = original; });
  assert.equal(await tokenService.buscarPedidoPorToken({
    estabelecimentoId: LOJA_ID,
    token: TOKEN_TESTE,
  }), null);
  assert.equal(await tokenService.buscarPedidoPorToken({
    estabelecimentoId: "507f1f77bcf86cd799439099",
    token: TOKEN_TESTE,
  }), null);
  assert.notEqual(filtros[0].estabelecimentoId, filtros[1].estabelecimentoId);
});

test("serialização pública aplica lista permitida e remove campos internos", () => {
  const publico = tokenService.serializarPedidoPublico({
    _id: "507f1f77bcf86cd799439012",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "preparo",
    pagamentoStatus: "pago",
    canal: "delivery",
    itens: [{ nome: "Lanche", quantidade: 2, observacao: "interno" }],
    total: 25,
    previsaoEntrega: "40 minutos",
    telefoneCliente: "999999999",
    emailCliente: "cliente@example.com",
    acompanhamentoTokenHash: "segredo",
    mercadoPagoPaymentId: "123",
    estoqueConsumos: [{ segredo: true }],
    historicoFinanceiro: [{ segredo: true }],
  });
  assert.deepEqual(Object.keys(publico), [
    "codigoPublico", "data", "status", "pagamentoStatus", "formaEntrega",
    "itens", "total", "previsao", "mensagem",
  ]);
  assert.deepEqual(
    Object.keys(publico.itens[0]),
    ["produtoId", "nome", "quantidade"],
  );
  assert.doesNotMatch(JSON.stringify(publico), /telefone|email|TokenHash|mercadoPago|estoque|historico|observacao/i);
});

test("rate limit separa IP e slug e responde JSON 429", () => {
  const limite = createRateLimiter({
    windowMs: 60_000,
    max: 1,
    key: req => `${req.ip}|${req.params.slug}`,
    onLimit: (req, res) => res.status(429).json({
      code: "MUITAS_TENTATIVAS",
      message: "Muitas tentativas. Aguarde e tente novamente.",
    }),
  });
  function resposta() {
    return {
      headers: {},
      statusCode: 200,
      body: null,
      set(name, value) { this.headers[name] = value; return this; },
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; },
    };
  }
  let permitidas = 0;
  const req = { ip: "192.0.2.1", params: { slug: "loja-a" } };
  limite(req, resposta(), () => { permitidas += 1; });
  const bloqueada = resposta();
  limite(req, bloqueada, () => { permitidas += 1; });
  limite(
    { ip: "192.0.2.1", params: { slug: "loja-b" } },
    resposta(),
    () => { permitidas += 1; },
  );
  assert.equal(permitidas, 2);
  assert.equal(bloqueada.statusCode, 429);
  assert.equal(bloqueada.body.code, "MUITAS_TENTATIVAS");
});

test("frontend não usa localStorage como autoridade e consulta por telefone e código", () => {
  const view = fs.readFileSync("src/views/catalogo-publico.ejs", "utf8");
  const routes = fs.readFileSync("route.js", "utf8");
  assert.doesNotMatch(view, /pedidos-acompanhamento:\$\{slug\}/);
  assert.doesNotMatch(view, /localStorage\.getItem\(trackingStorageKey/);
  assert.match(view, /orderLookupPhone/);
  assert.match(view, /orderLookupSuffix/);
  assert.match(view, /orderLookupFull/);
  assert.match(routes, /pedidos\/consultar/);
  assert.doesNotMatch(view, /pedidos\/consulta\/(?:iniciar|verificar)/);
  assert.doesNotMatch(routes, /pedido\/:token|pedidos\/:pedidoId\/pix/);
  assert.match(routes, /catalogo\/:slug\/pedido\/consultar/);
  assert.match(routes, /catalogo\/:slug\/pedido\/avaliacao/);
  assert.match(view, /Authorization['"]?: `Bearer \$\{/);
});

test("código não registra o token puro em logs", () => {
  const files = [
    "src/services/pedidoPublicoTokenService.js",
    "src/services/printQueueService.js",
    "src/controllers/adminRealController.js",
  ].map(file => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(
    files,
    /console\.(?:log|info|warn|error)\s*\([^)]*acompanhamentoToken/i,
  );
});

test("bearer ausente ou malformado é rejeitado e token válido é extraído", () => {
  assert.equal(tokenService.extrairBearerToken({ headers: {} }), null);
  assert.equal(tokenService.extrairBearerToken({
    headers: { authorization: TOKEN_TESTE },
  }), null);
  assert.equal(tokenService.extrairBearerToken({
    headers: { authorization: `Basic ${TOKEN_TESTE}` },
  }), null);
  assert.equal(tokenService.extrairBearerToken({
    headers: { authorization: `Bearer ${TOKEN_TESTE} extra` },
  }), null);
  assert.equal(tokenService.extrairBearerToken({
    headers: { authorization: `Bearer ${TOKEN_TESTE}` },
  }), TOKEN_TESTE);
});

test("referências locais expiram, rejeitam data inválida e deduplicam", () => {
  const agora = new Date("2026-07-01T00:00:00.000Z");
  const outroToken = "B".repeat(43);
  const registros = trackingStorage.normalizar([
    {
      codigoPublico: "ATUAL",
      token: TOKEN_TESTE,
      criadoEm: "2026-06-30T00:00:00.000Z",
      status: "não deve persistir",
      telefone: "não deve persistir",
    },
    {
      codigoPublico: "TOKEN-DUPLICADO",
      token: TOKEN_TESTE,
      criadoEm: "2026-06-29T00:00:00.000Z",
    },
    {
      codigoPublico: "ATUAL",
      token: outroToken,
      criadoEm: "2026-06-28T00:00:00.000Z",
    },
    {
      codigoPublico: "EXPIRADO",
      token: "C".repeat(43),
      criadoEm: "2026-01-01T00:00:00.000Z",
    },
    {
      codigoPublico: "INVALIDO",
      token: "D".repeat(43),
      criadoEm: "não é data",
    },
  ], agora);
  assert.deepEqual(registros, [{
    codigoPublico: "ATUAL",
    token: TOKEN_TESTE,
    criadoEm: "2026-06-30T00:00:00.000Z",
  }]);
});

test("referências locais ficam limitadas a 50", () => {
  const agora = new Date("2026-07-01T00:00:00.000Z");
  const registros = Array.from({ length: 60 }, (_, index) => ({
    codigoPublico: `P${index}`,
    token: Buffer.alloc(32, index + 1).toString("base64url"),
    criadoEm: "2026-06-30T00:00:00.000Z",
  }));
  assert.equal(trackingStorage.normalizar(registros, agora).length, 50);
});

test("avaliação pública exige token, compra paga e produto do pedido/loja", async t => {
  const originais = {
    configuracao: Configuracao.findOne,
    pedido: Pedido.findOne,
    produto: Produto.exists,
    avaliacao: Avaliacao.findOneAndUpdate,
  };
  const produtoId = "507f1f77bcf86cd799439022";
  let upserts = 0;
  const filtrosAvaliacao = [];
  Configuracao.findOne = () => queryLean({ estabelecimentoId: LOJA_ID });
  Pedido.findOne = () => queryDocumento({
    _id: "507f1f77bcf86cd799439033",
    cliente: "Cliente",
    pagamentoStatus: "pago",
    itens: [{ produtoId }],
  });
  Produto.exists = async filtro =>
    String(filtro.estabelecimentoId) === LOJA_ID && filtro._id === produtoId;
  Avaliacao.findOneAndUpdate = async filtro => {
    upserts += 1;
    filtrosAvaliacao.push(filtro);
    return {};
  };
  t.after(() => {
    Configuracao.findOne = originais.configuracao;
    Pedido.findOne = originais.pedido;
    Produto.exists = originais.produto;
    Avaliacao.findOneAndUpdate = originais.avaliacao;
  });
  const req = {
    params: { slug: "loja" },
    body: { produtoId, nota: 5, comentario: " Ótimo ", telefone: "9999" },
    headers: { authorization: `Bearer ${TOKEN_TESTE}` },
  };
  const primeira = responseMock();
  await admin.avaliarProdutoCatalogo(req, primeira);
  const segunda = responseMock();
  await admin.avaliarProdutoCatalogo(req, segunda);
  assert.equal(primeira.statusCode, 200);
  assert.equal(segunda.statusCode, 200);
  assert.equal(upserts, 2);
  assert.deepEqual(filtrosAvaliacao[0], filtrosAvaliacao[1]);
  assert.equal(filtrosAvaliacao[0].estabelecimentoId, LOJA_ID);

  const semToken = responseMock();
  await admin.avaliarProdutoCatalogo({
    params: { slug: "loja" },
    body: { produtoId, nota: 5, telefone: "9999" },
    headers: {},
  }, semToken);
  assert.equal(semToken.statusCode, 404);
});

test("avaliação rejeita produto não comprado, pedido não pago e outra loja", async t => {
  const originais = {
    configuracao: Configuracao.findOne,
    pedido: Pedido.findOne,
    produto: Produto.exists,
    avaliacao: Avaliacao.findOneAndUpdate,
  };
  const produtoId = "507f1f77bcf86cd799439022";
  Configuracao.findOne = () => queryLean({ estabelecimentoId: LOJA_ID });
  Produto.exists = async () => false;
  Avaliacao.findOneAndUpdate = async () => {
    throw new Error("não deveria gravar");
  };
  t.after(() => {
    Configuracao.findOne = originais.configuracao;
    Pedido.findOne = originais.pedido;
    Produto.exists = originais.produto;
    Avaliacao.findOneAndUpdate = originais.avaliacao;
  });
  const req = {
    params: { slug: "loja" },
    body: { produtoId, nota: 5 },
    headers: { authorization: `Bearer ${TOKEN_TESTE}` },
  };

  Pedido.findOne = () => queryDocumento({
    pagamentoStatus: "pago",
    itens: [{ produtoId: "507f1f77bcf86cd799439099" }],
  });
  const naoComprado = responseMock();
  await admin.avaliarProdutoCatalogo(req, naoComprado);
  assert.equal(naoComprado.statusCode, 403);

  Pedido.findOne = () => queryDocumento({
    pagamentoStatus: "pendente",
    itens: [{ produtoId }],
  });
  const naoPago = responseMock();
  await admin.avaliarProdutoCatalogo(req, naoPago);
  assert.equal(naoPago.statusCode, 403);

  Pedido.findOne = () => queryDocumento({
    pagamentoStatus: "pago",
    itens: [{ produtoId }],
  });
  const outraLoja = responseMock();
  await admin.avaliarProdutoCatalogo(req, outraLoja);
  assert.equal(outraLoja.statusCode, 404);
});

test("rotas públicas de pedido são POST, sem token no path e sem cache", () => {
  const router = require("../route");
  const paths = router.stack
    .filter(layer => layer.route)
    .map(layer => ({
      path: layer.route.path,
      methods: layer.route.methods,
      handlers: layer.route.stack.map(item => item.handle),
    }));
  const publicas = paths.filter(item =>
    String(item.path).startsWith("/catalogo/:slug/pedido/"));
  assert.deepEqual(
    publicas.map(item => item.path).sort(),
    [
      "/catalogo/:slug/pedido/avaliacao",
      "/catalogo/:slug/pedido/consultar",
      "/catalogo/:slug/pedido/pagamento-status",
      "/catalogo/:slug/pedido/pix",
    ],
  );
  assert.equal(publicas.every(item => item.methods.post), true);
  assert.equal(publicas.some(item => String(item.path).includes(":token")), false);
  for (const route of publicas) {
    const middleware = route.handlers.find(handler =>
      handler.name === "respostaPedidoSemCache");
    const res = responseMock();
    let nextCalled = false;
    middleware({}, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(res.headers.Pragma, "no-cache");
  }
  for (const path of [
    "/catalogo/:slug/pedidos",
    "/mesa/:token/pedidos",
  ]) {
    const route = paths.find(item => item.path === path);
    const middleware = route.handlers.find(handler =>
      handler.name === "respostaPedidoSemCache");
    const res = responseMock();
    middleware({}, res, () => {});
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(res.headers.Pragma, "no-cache");
  }
});

test("Referrer-Policy global e metas públicas usam strict-origin-when-cross-origin", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /app\.use\(securityHeaders\)/);
  const res = responseMock();
  let nextCalled = false;
  securityHeaders({}, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  for (const view of [
    "catalogo-publico.ejs",
    "mesa-publica.ejs",
    "assinatura.ejs",
    "index.ejs",
  ]) {
    const source = fs.readFileSync(`src/views/${view}`, "utf8");
    assert.match(source, /<meta name="referrer" content="strict-origin-when-cross-origin">/);
  }
});
