"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("Etapa 11 instrumenta somente GET /admin e protege producao por opt-in", () => {
  const helper = read("src/utils/adminServerTiming.js");
  assert.match(helper, /pathname === "\/admin"/);
  assert.match(helper, /NODE_ENV[^\n]+production/);
  assert.match(helper, /ADMIN_SERVER_TIMING_ENABLED/);
  assert.match(helper, /Server-Timing/);
  assert.doesNotMatch(helper, /estabelecimentoId|paymentId|cliente|telefone|cpf|cnpj/i);
});

test("sessao e render sao instrumentados no pipeline global sem mudar a rota /admin", () => {
  const server = read("server.js");
  const route = read("route.js");
  assert.match(server, /adminServerTiming\.beginRequest/);
  assert.match(server, /adminServerTiming\.beforeSession[\s\S]*app\.use\(sessionMiddleware\);[\s\S]*adminServerTiming\.afterSession/);
  assert.match(server, /adminServerTiming\.afterSession[\s\S]*adminServerTiming\.wrapAdminRender/);
  assert.match(route, /route\.get\(\s*['"]\/admin['"],\s*loginRequired,\s*carregarAssinatura,\s*assinaturaRequired,\s*admin\.admin\s*\)/);
});

test("auth, assinatura, configuracao, leituras e dashboard possuem medicao isolada", () => {
  const auth = read("src/middleware/auth.js");
  const assinatura = read("src/middleware/assinatura.js");
  const controller = read("src/controllers/adminRealController.js");
  assert.match(auth, /adminServerTiming\.beginStage\(req, "auth"\)/);
  assert.match(auth, /adminServerTiming\.endStage\(req, "auth"\)/);
  assert.match(assinatura, /adminServerTiming\.beginStage\(req, "assinatura"\)/);
  assert.match(assinatura, /adminServerTiming\.endStage\(req, "assinatura"\)/);
  assert.match(controller, /adminServerTiming\.beginStage\(req, "controller"\)/);
  assert.match(controller, /adminServerTiming\.measureAsync\([\s\S]*"config"/);
  assert.match(controller, /adminServerTiming\.measureAsync\([\s\S]*"reads"/);
  assert.match(controller, /adminServerTiming\.measureAsync\([\s\S]*"dashboard"/);
});

test("helper fica desligado por padrao em producao e nao instrumenta APIs administrativas", () => {
  const helperPath = path.join(ROOT, "src/utils/adminServerTiming.js");
  delete require.cache[require.resolve(helperPath)];
  const helper = require(helperPath);
  const adminReq = { method: "GET", originalUrl: "/admin" };
  const apiReq = { method: "GET", originalUrl: "/admin/api/pedidos/novos" };
  assert.equal(helper.isEnabled(adminReq, { NODE_ENV: "development" }), true);
  assert.equal(helper.isEnabled(adminReq, { NODE_ENV: "production" }), false);
  assert.equal(helper.isEnabled(adminReq, {
    NODE_ENV: "production",
    ADMIN_SERVER_TIMING_ENABLED: "true",
  }), true);
  assert.equal(helper.isEnabled(apiReq, { NODE_ENV: "development" }), false);
});
