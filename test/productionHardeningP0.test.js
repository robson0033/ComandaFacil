"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createRateLimiter,
  hashKey,
  mongoStoreEnabled,
  stopRateLimiters,
} = require("../src/middleware/rateLimit");
const {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePassword,
} = require("../src/utils/passwordPolicy");
const {
  PUBLIC_ORDER_LIMITS,
  normalizeIdempotencyKey,
  validatePublicOrderBase,
} = require("../src/utils/publicOrderValidation");
const {
  createIdempotencyConflictError,
  hashPublicOrderPayload,
} = require("../src/utils/publicOrderIdempotency");
const {
  gerarTokenAcompanhamentoIdempotente,
  tokenTemFormatoValido,
} = require("../src/services/pedidoPublicoTokenService");
const {
  buildRecord,
  sanitizeString,
  sanitizeValue,
} = require("../src/utils/logger");

function source(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

function validOrder(overrides = {}) {
  return {
    idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    cliente: "Cliente",
    telefone: "98999999999",
    canal: "retirada",
    itens: [{
      produtoId: "507f1f77bcf86cd799439011",
      quantidade: 1,
      adicionais: [],
      observacao: "",
    }],
    ...overrides,
  };
}

test.after(() => stopRateLimiters());

test("política de senha aceita frases-senha e bloqueia senhas curtas/comuns", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12);
  assert.equal(MAX_PASSWORD_LENGTH, 64);
  assert.equal(validatePassword("Frase longa e exclusiva 2026!").valid, true);
  assert.equal(validatePassword("curta123").valid, false);
  assert.equal(validatePassword("senha123456").valid, false);
  assert.equal(validatePassword("aaaaaaaaaaaa").valid, false);
  assert.equal(validatePassword("á".repeat(40)).valid, false, "bcrypt limita a 72 bytes");
});

test("pedido público rejeita quantidade decimal, infinita, excessiva e carrinho gigante", () => {
  for (const quantidade of [0, 1.5, 100, Infinity, -1, "1.5"]) {
    const result = validatePublicOrderBase(validOrder({
      itens: [{ produtoId: "x", quantidade }],
    }));
    assert.equal(result.valid, false, String(quantidade));
  }

  const tooManyItems = Array.from(
    { length: PUBLIC_ORDER_LIMITS.maxItems + 1 },
    (_, index) => ({ produtoId: String(index), quantidade: 1 }),
  );
  assert.equal(validatePublicOrderBase(validOrder({ itens: tooManyItems })).valid, false);

  const tooManyAdditions = Array.from(
    { length: PUBLIC_ORDER_LIMITS.maxAdditionsPerItem + 1 },
    (_, index) => String(index),
  );
  assert.equal(validatePublicOrderBase(validOrder({
    itens: [{ produtoId: "x", quantidade: 1, adicionais: tooManyAdditions }],
  })).valid, false);
});

test("chave de idempotência pública exige UUID v4 e pedido válido a preserva", () => {
  assert.equal(normalizeIdempotencyKey("550e8400-e29b-41d4-a716-446655440000"),
    "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(normalizeIdempotencyKey("qualquer-chave"), "");
  assert.equal(validatePublicOrderBase(validOrder()).valid, true);
  const invalid = validatePublicOrderBase(validOrder({ idempotencyKey: "invalida" }));
  assert.equal(invalid.valid, false);
  assert.equal(invalid.code, "IDEMPOTENCY_KEY_INVALID");
});


test("hash e token idempotentes são determinísticos e detectam payload diferente", () => {
  const payload = {
    estabelecimentoId: "tenant-1",
    canal: "retirada",
    cliente: "Cliente",
    total: 25,
    itens: [{ produtoId: "produto-1", nome: "Lanche", quantidade: 1, preco: 25, subtotal: 25 }],
  };
  const firstHash = hashPublicOrderPayload(payload);
  assert.equal(firstHash, hashPublicOrderPayload({ ...payload }));
  assert.notEqual(firstHash, hashPublicOrderPayload({ ...payload, total: 26 }));
  assert.equal(firstHash.length, 64);

  const tokenA = gerarTokenAcompanhamentoIdempotente({
    estabelecimentoId: "tenant-1",
    canal: "retirada",
    idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    secret: "s".repeat(48),
  });
  const tokenB = gerarTokenAcompanhamentoIdempotente({
    estabelecimentoId: "tenant-1",
    canal: "retirada",
    idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    secret: "s".repeat(48),
  });
  assert.equal(tokenA.token, tokenB.token);
  assert.equal(tokenTemFormatoValido(tokenA.token), true);

  const conflict = createIdempotencyConflictError();
  assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(conflict.statusCode, 409);
});

test("rate limiter local limita rajadas, não guarda a identidade em texto e produção usa Mongo", async () => {
  assert.equal(mongoStoreEnabled({ NODE_ENV: "production" }), true);
  assert.equal(mongoStoreEnabled({ NODE_ENV: "development" }), false);
  assert.equal(mongoStoreEnabled({ NODE_ENV: "production", RATE_LIMIT_STORE: "memory" }), false);
  assert.equal(hashKey("cliente@example.com").includes("cliente@example.com"), false);

  const limiter = createRateLimiter({
    name: "test-burst",
    windowMs: 60_000,
    max: 2,
    env: { NODE_ENV: "test" },
  });
  const req = {
    ip: "127.0.0.1",
    body: {},
    get() { return "application/json"; },
  };

  function response() {
    return {
      headers: {},
      statusCode: 200,
      body: null,
      set(name, value) { this.headers[name] = value; return this; },
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; },
      send(value) { this.body = value; return this; },
    };
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = response();
    let nextCalled = false;
    await limiter(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  }

  const blocked = response();
  let blockedNext = false;
  await limiter(req, blocked, () => { blockedNext = true; });
  assert.equal(blockedNext, false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.code, "MUITAS_TENTATIVAS");
});

test("rotas críticas possuem rate limit e CSRF anônimo", () => {
  const routes = source("route.js");
  for (const limiter of [
    "limiteLoginIp",
    "limiteLoginIdentidade",
    "limiteCadastro",
    "limiteRecuperacaoSolicitar",
    "limiteRecuperacaoCodigo",
    "limiteNovaSenha",
    "limitePedidoCatalogo",
    "limitePedidoCatalogoHora",
    "limitePedidoMesa",
    "limitePedidoMesaHora",
  ]) {
    assert.match(routes, new RegExp(`\\b${limiter}\\b`));
  }
  assert.match(routes, /anonymousSameOriginProtection/);
  assert.match(routes, /'\/catalogo\/:slug\/pedidos'[\s\S]{0,350}limitePedidoCatalogo[\s\S]{0,350}anonymousSameOriginProtection/);
  assert.match(routes, /'\/mesa\/:token\/pedidos'[\s\S]{0,350}limitePedidoMesa[\s\S]{0,350}anonymousSameOriginProtection/);
});

test("idempotência existe no navegador, controller, serviço e índice único", () => {
  const catalog = source("src/views/catalogo-publico.ejs");
  const table = source("src/views/mesa-publica.ejs");
  const controller = source("src/controllers/adminRealController.js");
  const queue = source("src/services/printQueueService.js");
  const models = source("src/models/painelModels.js");
  const migration = source("scripts/create-mercado-pago-indexes.js");

  for (const page of [catalog, table]) {
    assert.match(page, /idempotencyKey/);
    assert.match(page, /X-CSRF-Token/);
    assert.match(page, /crypto\.randomUUID/);
  }
  assert.match(catalog, /let pedidoPreparacaoEmAndamento = false/);
  assert.match(catalog, /let pedidoEnvioEmAndamento = false/);
  assert.match(
    catalog,
    /orderForm\.addEventListener\("submit"[\s\S]{0,500}if \(pedidoPreparacaoEmAndamento \|\| pedidoEnvioEmAndamento\) return;[\s\S]{0,500}pedidoPreparacaoEmAndamento = true;[\s\S]{0,300}await sincronizarCarrinho\(\)/,
  );
  assert.match(
    catalog,
    /async function enviarPedido\(payload\) \{[\s\S]{0,160}if \(pedidoEnvioEmAndamento\) return;[\s\S]{0,120}pedidoEnvioEmAndamento = true;/,
  );
  assert.match(table, /let pedidoEnvioEmAndamento = false/);
  assert.match(
    table,
    /if \(pedidoEnvioEmAndamento\) return;[\s\S]{0,120}pedidoEnvioEmAndamento = true;[\s\S]{0,120}button\.disabled = true;/,
  );
  assert.match(controller, /validatePublicOrderBase/);
  assert.doesNotMatch(controller, /criarPedidoCatalogoAnterior/);
  assert.match(queue, /gerarTokenAcompanhamentoIdempotente/);
  assert.match(queue, /idempotencyPayloadHash/);
  assert.match(queue, /createIdempotencyConflictError/);
  assert.match(source("src/utils/publicOrderIdempotency.js"), /IDEMPOTENCY_CONFLICT/);
  assert.match(models, /pedido_criacao_idempotente_unica/);
  assert.match(models, /idempotencyPayloadHash/);
  assert.match(migration, /pedido_criacao_idempotente_unica/);
});


test("quantidades restantes do estoque são formatadas sem resíduos de ponto flutuante", () => {
  const admin = source("src/views/admin-real.ejs");
  assert.match(admin, /function formatarQuantidadeEstoque/);
  assert.match(admin, /maximumFractionDigits:\s*3/);
  assert.match(admin, /formatarQuantidadeEstoque\(item\.quantidade\)/);
  assert.equal(
    admin.includes("${Number(item.quantidade) || 0} ${escaparHtml(item.unidade)} em estoque"),
    false,
  );
});

test("servidor limita body, remove identificação Express, usa todas as origens e valida índices", () => {
  const server = source("server.js");
  assert.match(server, /app\.disable\("x-powered-by"\)/);
  assert.match(server, /express\.urlencoded\(\{[\s\S]*limit:\s*"64kb"[\s\S]*parameterLimit:\s*200/);
  assert.match(server, /express\.json\(\{[\s\S]*limit:\s*"128kb"[\s\S]*strict:\s*true/);
  assert.match(server, /configuredOrigins\(env\)/);
  assert.match(server, /verifyCriticalIndexes/);
  assert.match(server, /indexesReady/);
});


test("logger estruturado remove segredos e credenciais de erros", () => {
  const record = buildRecord("error", [
    "request_failed",
    {
      authorization: "Bearer segredo",
      password: "senha-real",
      correlationId: "ABC123",
      error: new Error("falhou token=segredo mongodb://user:pass@host/db"),
    },
  ]);
  const serialized = JSON.stringify(record);
  assert.match(serialized, /request_failed/);
  assert.match(serialized, /ABC123/);
  assert.doesNotMatch(serialized, /senha-real|Bearer segredo|user:pass|token=segredo/);
  assert.equal(sanitizeValue({ accessToken: "abc" }).accessToken, "[REMOVIDO]");
  assert.doesNotMatch(sanitizeString("mongodb://u:p@host/db"), /u:p/);
});

test("CSP usa nonce em estilos de elementos e todas as views têm nonce", () => {
  const headers = source("src/middleware/securityHeaders.js");
  assert.match(headers, /style-src 'self' 'nonce-\$\{nonce\}'/);
  assert.match(headers, /style-src-elem 'self' 'nonce-\$\{nonce\}'/);
  assert.doesNotMatch(headers, /style-src 'self' 'unsafe-inline'/);

  const viewsDir = path.resolve(__dirname, "../src/views");
  for (const file of fs.readdirSync(viewsDir).filter(name => name.endsWith(".ejs"))) {
    const contents = fs.readFileSync(path.join(viewsDir, file), "utf8");
    const totalStyleTags = (contents.match(/<style\b/g) || []).length;
    const nonceStyleTags = (contents.match(/<style nonce="<%= cspNonce %>">/g) || []).length;
    assert.equal(nonceStyleTags, totalStyleTags, file);
  }
});

test("runtime e documentação estão fixados em Node 24 e possuem gates de produção", () => {
  const packageJson = JSON.parse(source("package.json"));
  assert.match(packageJson.engines.node, /^>=24\./);
  assert.ok(packageJson.scripts.test);
  assert.ok(packageJson.scripts["test:production"]);
  assert.ok(packageJson.scripts["indexes:apply"]);
  assert.ok(packageJson.scripts["audit:production"]);
  assert.equal(source(".nvmrc").trim(), "24.18.1");
});
