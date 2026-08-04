"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createOperationalAlertService,
} = require("../src/services/operationalAlertService");
const {
  createHttp5xxAlertMiddleware,
  normalizeRoutePath,
} = require("../src/middleware/http5xxAlert");
const {
  buildStuckPrintJobQuery,
  createPrintQueueAlertMonitor,
} = require("../src/services/printQueueAlertMonitor");

function source(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

function silentLogger() {
  return { info() {}, error() {}, warn() {}, log() {} };
}

test("serviço central deduplica, mascara segredos e envia recuperação", async () => {
  let currentTime = Date.parse("2026-08-04T13:00:00.000Z");
  const requests = [];
  const alerts = createOperationalAlertService({
    env: {
      NODE_ENV: "test",
      ALERT_WEBHOOK_URL: "https://alerts.example.test/incoming",
      ALERT_COOLDOWN_MS: "60000",
    },
    logger: silentLogger(),
    now: () => currentTime,
    fetchFn: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 204 };
    },
  });

  const first = alerts.trigger({
    event: "email_delivery_failed",
    key: "email:recovery",
    details: {
      recipientMasked: "r***@example.com",
      token: "nao-pode-sair",
      message: "token=segredo mongodb+srv://usuario:senha@host/banco",
    },
  });
  const duplicate = alerts.trigger({
    event: "email_delivery_failed",
    key: "email:recovery",
  });
  assert.equal(first.suppressed, false);
  assert.equal(duplicate.suppressed, true);

  currentTime += 1_000;
  const recovery = alerts.resolve({
    event: "email_delivery_failed",
    key: "email:recovery",
    details: { status: "recovered" },
  });
  assert.equal(recovery.suppressed, false);

  const results = await alerts.flush();
  assert.equal(results.length, 2);
  assert.equal(results.every(result => result.ok), true);
  assert.equal(requests.length, 2);
  const serialized = JSON.stringify(requests);
  assert.doesNotMatch(serialized, /nao-pode-sair|usuario:senha|token=segredo/);
  assert.match(serialized, /\[REMOVIDO\]|\[URI_REMOVIDA\]/);
  assert.equal(requests[0].body.state, "firing");
  assert.equal(requests[1].body.state, "resolved");
});

test("serviço serializa entregas e respeita Retry-After do Discord", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const waits = [];
  const alerts = createOperationalAlertService({
    env: {
      NODE_ENV: "test",
      ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
    },
    logger: silentLogger(),
    sleepFn: async milliseconds => { waits.push(milliseconds); },
    fetchFn: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;

      if (calls === 6) {
        return {
          ok: false,
          status: 429,
          headers: {
            get(name) {
              return String(name).toLowerCase() === "retry-after"
                ? "0.25"
                : null;
            },
          },
          async json() {
            return { retry_after: 0.25, global: false };
          },
        };
      }

      return { ok: true, status: 204 };
    },
  });

  for (let index = 0; index < 7; index += 1) {
    alerts.trigger({
      event: `homologation_${index}`,
      key: `homologation:${index}`,
      details: { index },
    });
  }

  const results = await alerts.flush();
  assert.equal(results.length, 7);
  assert.equal(results.every(result => result.ok), true);
  assert.equal(calls, 8);
  assert.equal(maxActive, 1);
  assert.deepEqual(waits, [250]);
});

test("middleware 5xx só alerta ao atingir limiar e ignora ready tratado", () => {
  const calls = [];
  const middleware = createHttp5xxAlertMiddleware({
    env: {
      ALERT_5XX_THRESHOLD: "2",
      ALERT_5XX_WINDOW_MS: "60000",
    },
    alertService: { trigger: input => calls.push(input) },
    now: () => 1_000,
  });

  function finish(pathname, statusCode, handled = false) {
    const req = {
      method: "GET",
      path: pathname,
      correlationId: "corr-1",
    };
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.locals = handled ? { operationalAlertHandled: true } : {};
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    res.emit("finish");
    assert.equal(nextCalled, true);
  }

  finish("/admin/pedidos/507f1f77bcf86cd799439011", 500);
  assert.equal(calls.length, 0);
  finish("/admin/pedidos/507f1f77bcf86cd799439011", 500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].details.count, 2);
  assert.equal(calls[0].details.path, "/admin/pedidos/:objectId");
  finish("/ready", 503, true);
  assert.equal(calls.length, 1);
});

test("normalização de rota reduz cardinalidade sem incluir query string", () => {
  assert.equal(
    normalizeRoutePath("/pedido/507f1f77bcf86cd799439011?token=secreto"),
    "/pedido/:objectId",
  );
  assert.equal(
    normalizeRoutePath("/jobs/550e8400-e29b-41d4-a716-446655440000"),
    "/jobs/:uuid",
  );
});

test("monitor de fila detecta trabalho preso e envia recuperação", async () => {
  const now = new Date("2026-08-04T13:00:00.000Z");
  let jobs = [{
    estabelecimentoId: "507f1f77bcf86cd799439012",
    jobId: "550e8400-e29b-41d4-a716-446655440000",
    status: "pendente",
    createdAt: new Date(now.getTime() - 10 * 60_000),
  }];
  const calls = [];
  const chain = () => ({
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    async lean() { return jobs; },
  });
  const monitor = createPrintQueueAlertMonitor({
    PrintJobModel: { find: chain },
    alertService: {
      trigger: input => calls.push(["trigger", input]),
      resolve: input => calls.push(["resolve", input]),
    },
    logger: silentLogger(),
    env: {
      ALERT_QUEUE_STUCK_MS: "60000",
      ALERT_QUEUE_CHECK_INTERVAL_MS: "15000",
    },
    now: () => now,
  });

  const first = await monitor.check();
  assert.deepEqual(first, { checked: true, stuckJobs: 1, stores: 1 });
  assert.equal(calls.some(([type, input]) =>
    type === "trigger" && input.event === "print_queue_stuck"), true);

  jobs = [];
  await monitor.check();
  assert.equal(calls.some(([type, input]) =>
    type === "resolve" && input.event === "print_queue_stuck"), true);
});

test("consulta de fila cobre estados vencidos sem reenviar trabalhos", () => {
  const query = buildStuckPrintJobQuery({
    now: new Date("2026-08-04T13:00:00.000Z"),
    stuckMs: 180_000,
  });
  const serialized = JSON.stringify(query);
  assert.match(serialized, /pendente/);
  assert.match(serialized, /aguardando_retry/);
  assert.match(serialized, /processando/);
  assert.match(serialized, /resultado_desconhecido/);
  assert.doesNotMatch(serialized, /concluido|cancelado/);
});

test("integrações do item 17 são isoladas nos pontos corretos", () => {
  const server = source("server.js");
  const systemRoutes = source("src/routes/systemRoutes.js");
  const email = source("src/services/emailService.js");
  const payment = source("src/controllers/pagamentoController.js");
  const queueMonitor = source("src/services/printQueueAlertMonitor.js");

  assert.match(server, /createHttp5xxAlertMiddleware/);
  assert.match(server, /createPrintQueueAlertMonitor/);
  assert.match(server, /queueAlertMonitor\?\.stop/);
  assert.match(systemRoutes, /readiness_unavailable/);
  assert.match(systemRoutes, /operationalAlertHandled/);
  assert.match(email, /email_delivery_failed/);
  assert.match(email, /recipientMasked/);
  assert.match(payment, /mercado_pago_webhook_failed/);
  assert.match(payment, /if \(signatureValid\)/);
  assert.match(payment, /WEBHOOK_ALREADY_PROCESSED/);
  assert.match(queueMonitor, /print_queue_stuck/);
  assert.doesNotMatch(queueMonitor, /criarJob|retryJob|reconciliarJobManual/);
});
