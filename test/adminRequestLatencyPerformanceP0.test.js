"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");

test("assinatura e configuração operacional são consultadas em paralelo", () => {
  const source = read("src/middleware/assinatura.js");
  assert.match(source, /const \[assinaturaEncontrada, estabelecimento\] = await Promise\.all\(\[/);
  assert.match(source, /Assinatura\.findOne\(\{ estabelecimentoId: id\(req\) \}\)/);
  assert.match(source, /const camposConfiguracao = carregarCamposPainel/);
  assert.match(source, /"nomeEstabelecimento"/);
  assert.match(source, /"impressoras"/);
  assert.match(source, /:\s*"ativo bloqueado vendasBloqueadas"/);
  assert.match(source, /\.select\(camposConfiguracao\)[\s\S]*?\.lean\(\)/);
  assert.match(source, /req\.configuracaoPainel = carregarCamposPainel/);
  assert.doesNotMatch(source, /let assinatura = await Assinatura\.findOne/);
});

test("/admin reutiliza assinatura e configuração leve já lidas pelo middleware", () => {
  const source = read("src/controllers/adminRealController.js");
  assert.match(source, /const assinatura =\s*req\.assinatura \|\|\s*await obterAssinatura\(/);
  assert.match(source, /const configuracaoPainelDoMiddleware =\s*!precisaConfiguracaoCompleta \? req\.configuracaoPainel : null/);
  assert.match(source, /\(\) => configuracaoPainelDoMiddleware \|\| obterOuCriarConfiguracao\(/);
});

test("rota /admin mantém cadeia de autenticação e assinatura", () => {
  const source = read("route.js");
  assert.match(
    source,
    /route\.get\(\s*['"]\/admin['"],\s*loginRequired,\s*carregarAssinatura,\s*assinaturaRequired,\s*admin\.admin\s*\)/,
  );
});
