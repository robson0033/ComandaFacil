"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const admin = require("../src/controllers/adminRealController");
const queue = require("../src/services/printQueueService");
const { buildJobEnvelope } = require("../src/services/printAgentProtocol");
const {
  normalizePrinterLayoutConfig,
  normalizeRightMarginMm,
} = require("../src/services/printerLayoutConfig");

function printerBody(value) {
  return {
    impressoras: [{
      nome: "Caixa",
      tipoConexao: "usb",
      deviceName: "Printer",
      papel: "80mm",
      modo: "manual_automatica",
      origemPedidos: "delivery",
      margemDireitaMm: value,
    }],
  };
}

test("formulário usa o nome canônico, limites decimais e preserva zero", () => {
  const view = fs.readFileSync(path.join(__dirname, "../src/views/admin-real.ejs"), "utf8");
  assert.match(view, /\['margemDireitaMm', 'Margem direita', 20\]/);
  assert.match(view, /step="0\.1"/);
  assert.match(view, /campo\('margemDireitaMm'\)\?\.value \?\?/);
});

test("normaliza zero e decimal sem substituir pelo padrão", () => {
  assert.equal(normalizeRightMarginMm(0), 0);
  assert.equal(normalizeRightMarginMm("1.5"), 1.5);
  assert.equal(admin._testing.normalizarImpressoras(printerBody("0"))[0].margemDireitaMm, 0);
  assert.equal(admin._testing.normalizarImpressoras(printerBody("1.5"))[0].margemDireitaMm, 1.5);
  assert.equal(admin._testing.normalizarImpressoras(printerBody("1.5"))[0].origemPedidos, "delivery");
  assert.equal(admin._testing.normalizarImpressoras({ impressoras: [{}] })[0].origemPedidos, "todas");
});

test("rejeita espaçamento direito inválido, negativo e acima do limite", () => {
  for (const value of ["inválido", -0.1, 20.1]) {
    assert.throws(
      () => normalizeRightMarginMm(value),
      error => error.code === "VALIDATION_ERROR" && error.statusCode === 422,
    );
  }
});

test("registro antigo recebe fallback e margem zero permanece no snapshot", async () => {
  assert.equal(normalizePrinterLayoutConfig({}).margemDireitaMm, 2);
  const snapshot = await queue.montarSnapshotValidado({
    pedido: {
      _id: "507f1f77bcf86cd799439011",
      estabelecimentoId: "507f1f77bcf86cd799439012",
      canal: "retirada",
      itens: [],
      total: 0,
      createdAt: new Date(),
    },
    configuracao: {},
    dono: {},
    impressora: {
      nome: "Caixa",
      tipoConexao: "usb",
      deviceName: "Printer",
      papel: "80mm",
      modo: "manual_automatica",
      margemEsquerdaMm: 3,
      margemDireitaMm: 0,
    },
  });
  assert.equal(snapshot.impressora.margemEsquerdaMm, 3);
  assert.equal(snapshot.impressora.margemDireitaMm, 0);
});

test("envelope do agente preserva a margem direita do snapshot no retry", () => {
  const impressora = queue.sanitizarImpressora({
    tipoConexao: "usb",
    deviceName: "Printer",
    margemDireitaMm: 7.5,
  });
  const build = attempt => buildJobEnvelope({
    jobId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    impressoraId: "usb:printer",
    attempt,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    modo: "manual",
    estabelecimento: {},
    pedido: {},
    impressoras: [impressora],
  });
  assert.equal(build(1).impressoras[0].margemDireitaMm, 7.5);
  assert.equal(build(2).impressoras[0].margemDireitaMm, 7.5);
});
