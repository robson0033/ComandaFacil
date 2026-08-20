"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const scriptPath = path.join(__dirname, "..", "scripts", "create-performance-indexes.js");
const source = fs.readFileSync(scriptPath, "utf8");

const expectedNames = [
  "categoria_tenant_tipo_nome",
  "estoque_tenant_ativo_nome",
  "produto_tenant_nome",
  "mesa_tenant_numero",
  "funcionario_tenant_nome",
  "pedido_tenant_arquivado_data",
  "pedido_tenant_canal_pagamento_data",
  "pedido_tenant_updated",
  "whatsapp_conversa_tenant_updated",
];

test("índices de leitura cobrem as consultas pesadas do painel", () => {
  for (const name of expectedNames) {
    assert.match(source, new RegExp(`name:\\s*[\"']${name}[\"']`));
  }
  assert.match(source, /estabelecimentoId:\s*1,\s*excluido:\s*1,\s*excluidoEm:\s*-1/);
  assert.match(source, /estabelecimentoId:\s*1,\s*canal:\s*1,\s*pagamentoStatus:\s*1,\s*createdAt:\s*1/);
  assert.match(source, /estabelecimentoId:\s*1,\s*updatedAt:\s*1/);
});

test("migração é somente aditiva e não cria novos índices únicos", () => {
  assert.doesNotMatch(source, /dropIndex\s*\(/);
  assert.doesNotMatch(source, /dropIndexes\s*\(/);
  assert.doesNotMatch(source, /deleteMany\s*\(/);
  assert.doesNotMatch(source, /unique:\s*true/);
  assert.match(source, /createIndex\s*\(/);
});

test("aplicação exige autorização explícita e dry-run é o padrão", () => {
  assert.match(source, /ALLOW_INDEX_MIGRATION/);
  assert.match(source, /process\.env\.ALLOW_INDEX_MIGRATION\s*!==\s*[\"']true[\"']/);
  assert.match(source, /process\.argv\.includes\([\"']--dry-run[\"']\)\s*\|\|\s*!apply/);
  assert.match(source, /SAFE_TO_APPLY=/);
});
