"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function source(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

test("monitor não trata espera por agente offline como fila crítica travada", () => {
  const monitor = source("src/services/printQueueAlertMonitor.js");
  const server = source("server.js");

  assert.match(monitor, /isAgentOnline\s*=\s*\(\)\s*=>\s*true/);
  assert.match(monitor, /isProtocolEnabled\s*=\s*\(\)\s*=>\s*true/);
  assert.match(monitor, /if \(!isProtocolEnabled\(storeId\)\) return false/);
  assert.match(monitor, /if \(!isAgentOnline\(storeId\)\) return false/);
  assert.match(server, /isAgentOnline:\s*estabelecimentoId\s*=>\s*printAgentHub\.isOnline/);
  assert.match(server, /isProtocolEnabled:\s*estabelecimentoId\s*=>/);
});

test("fila corrige jobs órfãos e trabalhos com tentativas esgotadas", () => {
  const queue = source("src/services/printQueueService.js");
  const controller = source("src/controllers/adminRealController.js");

  assert.match(queue, /async function reconciliarJobsComImpressorasAtuais/);
  assert.match(queue, /Impressora removida, desativada ou não configurada para esta origem/);
  assert.match(queue, /async function finalizarJobsEsgotados/);
  assert.match(queue, /tentativas:\s*\{ \$gte: MAX_ATTEMPTS \}/);
  assert.match(queue, /status:\s*"falhou"/);
  assert.match(queue, /\["entregando", "recebido", "processando", "enviado", "resultado_desconhecido"\]/);
  assert.match(controller, /reconciliarJobsComImpressorasAtuais\(/);
});

test("jobs legados sem nextAttemptAt continuam elegíveis para claim", () => {
  const queue = source("src/services/printQueueService.js");
  assert.match(queue, /\{ nextAttemptAt: null \}/);
  assert.match(queue, /\{ nextAttemptAt: \{ \$lte: now \} \}/);
});
