"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  isPersonalDataKey,
  maskDocument,
  maskEmail,
  maskPhone,
  redactPersonalString,
} = require("../src/utils/privacy");
const {
  DATA_CLASSES,
  DEFAULT_AUDIT_THRESHOLDS_DAYS,
  cutoffDate,
  resolveAuditThresholds,
} = require("../src/services/privacyRetentionPolicy");
const {
  createDatabaseReport,
  createStaticReport,
  main,
} = require("../scripts/auditar-privacidade-retencao");
const {
  buildRecord,
  sanitizeString,
  sanitizeValue,
} = require("../src/utils/logger");

function source(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

test("mascaramento cobre e-mail, CPF/CNPJ, telefone e chaves pessoais", () => {
  assert.equal(maskEmail("cliente@example.com"), "c***@example.com");
  assert.equal(maskDocument("529.982.247-25"), "***.***.***-25");
  assert.equal(maskDocument("12.345.678/0001-95"), "**.***.***/****-95");
  assert.equal(maskPhone("(98) 97006-7117"), "***7117");
  for (const key of [
    "emailCliente",
    "telefoneCliente",
    "cpfCnpj",
    "enderecoEntrega",
    "referenciaEntrega",
    "ipAceite",
    "userAgent",
  ]) {
    assert.equal(isPersonalDataKey(key), true, key);
  }
  assert.equal(isPersonalDataKey("correlationId"), false);
  assert.equal(isPersonalDataKey("payerEmailPresent"), false);
});

test("logger remove dados pessoais de objetos e mensagens de erro", () => {
  const record = buildRecord("error", [
    "falha_privacidade",
    {
      emailCliente: "cliente@example.com",
      telefoneCliente: "98970067117",
      cpfCnpj: "52998224725",
      enderecoEntrega: "Rua Sigilosa, 10",
      correlationId: "ABC123",
      error: new Error(
        'E11000 duplicate key { email: "cliente@example.com", cpfCnpj: "52998224725" }',
      ),
    },
  ]);
  const serialized = JSON.stringify(record);
  assert.match(serialized, /ABC123/);
  assert.doesNotMatch(
    serialized,
    /cliente@example\.com|98970067117|52998224725|Rua Sigilosa/,
  );
  assert.equal(sanitizeValue({ telefone: "98970067117" }).telefone, "[REMOVIDO]");
  assert.doesNotMatch(
    sanitizeString("contato cliente@example.com cpf 529.982.247-25"),
    /cliente@example\.com|529\.982\.247-25/,
  );
  assert.match(
    redactPersonalString("telefone=98970067117 endereco=Rua A, 20"),
    /DADO_PESSOAL_REMOVIDO/,
  );
});

test("inventário registra classes temporárias e lacunas sem ativar exclusão", () => {
  assert.ok(Object.keys(DATA_CLASSES).length >= 10);
  assert.equal(DATA_CLASSES.sessions.automaticExpiry, true);
  assert.equal(DATA_CLASSES.oauthStates.automaticExpiry, true);
  assert.equal(DATA_CLASSES.passwordRecovery.automaticExpiry, true);
  assert.equal(DATA_CLASSES.customerOrders.automaticExpiry, false);
  assert.equal(DATA_CLASSES.printQueue.automaticExpiry, false);
  assert.equal(DATA_CLASSES.employees.risk, "alto");
  const report = createStaticReport();
  assert.ok(report.automaticExpiryClasses >= 3);
  assert.ok(report.manualRetentionClasses >= 5);
  assert.ok(report.highRiskNames.includes("customerOrders"));
});

test("limites de auditoria são configuráveis e não representam deleção", () => {
  assert.deepEqual(resolveAuditThresholds({}), DEFAULT_AUDIT_THRESHOLDS_DAYS);
  assert.equal(resolveAuditThresholds({ PRIVACY_AUDIT_PRINT_JOB_DAYS: "30" }).printJobs, 30);
  assert.equal(resolveAuditThresholds({ PRIVACY_AUDIT_PRINT_JOB_DAYS: "0" }).printJobs, 90);
  const now = new Date("2026-08-04T12:00:00.000Z");
  assert.equal(cutoffDate(1, now).toISOString(), "2026-08-03T12:00:00.000Z");
});

test("auditoria de banco usa somente contagens e filtros temporais", async () => {
  const calls = [];
  function model(name, result) {
    return {
      countDocuments(filter) {
        calls.push({ name, filter });
        return Promise.resolve(result);
      },
    };
  }
  const report = await createDatabaseReport({
    models: {
      Pedido: model("Pedido", 3),
      PrintJob: model("PrintJob", 4),
      AuditoriaEvento: model("AuditoriaEvento", 5),
      Funcionario: model("Funcionario", 6),
    },
    thresholds: DEFAULT_AUDIT_THRESHOLDS_DAYS,
    now: new Date("2026-08-04T12:00:00.000Z"),
  });
  assert.equal(calls.length, 5);
  assert.equal(report.counts.activeOrdersBeyondThreshold, 3);
  assert.equal(report.counts.archivedOrdersBeyondThreshold, 3);
  assert.equal(report.counts.printJobsBeyondThreshold, 4);
  assert.equal(report.counts.auditEventsBeyondThreshold, 5);
  assert.equal(report.counts.inactiveEmployeesBeyondThreshold, 6);
  assert.ok(calls.every(call => !JSON.stringify(call.filter).match(/cliente|telefone|cpf|endereco/i)));
});

test("execução padrão não conecta, não escreve e não exibe dados pessoais", async () => {
  const lines = [];
  const result = await main({
    env: {},
    connect() {
      throw new Error("não deveria conectar");
    },
    disconnect() {
      throw new Error("não deveria desconectar");
    },
    logger: {
      log(value) { lines.push(String(value)); },
      error(value) { lines.push(String(value)); },
    },
  });
  const output = lines.join("\n");
  assert.equal(result.exitCode, 0);
  assert.equal(result.connected, false);
  assert.match(output, /OPERACOES_DE_ESCRITA=0/);
  assert.match(output, /DADOS_PESSOAIS_EXIBIDOS=NAO/);
  assert.match(output, /REVISAO_TECNICA_ITEM_20=CONCLUIDA/);
});

test("documentação e comando do item 20 estão presentes", () => {
  const packageJson = JSON.parse(source("package.json"));
  assert.equal(
    packageJson.scripts["audit:privacy"],
    "node scripts/auditar-privacidade-retencao.js",
  );
  const docs = source("docs/privacidade-retencao.md");
  assert.match(docs, /Pedidos e dados de clientes/);
  assert.match(docs, /Fila de impressão/);
  assert.match(docs, /Funcionários/);
  assert.match(docs, /CPF\/CNPJ/);
  assert.match(docs, /VALIDACAO_JURIDICA_DOS_PRAZOS=PENDENTE/);
  const auditSource = source("scripts/auditar-privacidade-retencao.js");
  assert.doesNotMatch(
    auditSource,
    /\.(?:deleteOne|deleteMany|findOneAndDelete|updateOne|updateMany|replaceOne|bulkWrite|create|save)\s*\(/,
  );
});
