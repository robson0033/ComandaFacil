"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
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


function carregarEmailServiceComFakes({ sendMail, alertService }) {
  const modulePath = require.resolve("../src/services/emailService");
  const originalLoad = Module._load;
  const transportOptions = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent?.filename === modulePath && request === "nodemailer") {
      return {
        createTransport(options) {
          transportOptions.push(options);
          return { sendMail };
        },
      };
    }
    if (
      parent?.filename === modulePath
      && request === "./operationalAlertService"
    ) {
      return { operationalAlerts: alertService };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[modulePath];
  try {
    return {
      emailService: require(modulePath),
      transportOptions,
    };
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
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



test("e-mail aplica timeouts, detalha ESOCKET e resolve alerta após recuperação", async () => {
  const previousEnv = {
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
  };
  process.env.EMAIL_PROVIDER = "smtp";
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_PORT = "465";
  process.env.SMTP_USER = "mailer@example.test";
  process.env.SMTP_PASS = "senha-nao-exposta";

  const calls = [];
  let fail = true;
  const socketError = Object.assign(new Error("connect ETIMEDOUT 203.0.113.10:465"), {
    code: "ESOCKET",
    errno: "ETIMEDOUT",
    syscall: "connect",
    command: "CONN",
    address: "203.0.113.10",
    port: 465,
  });

  const { emailService, transportOptions } = carregarEmailServiceComFakes({
    sendMail: async () => {
      if (fail) throw socketError;
      return { messageId: "message-1" };
    },
    alertService: {
      trigger(input) { calls.push(["trigger", input]); },
      resolve(input) { calls.push(["resolve", input]); },
    },
  });

  try {
    await assert.rejects(
      emailService._testing.enviarComAlerta({
        tipo: "password_recovery",
        destinatario: "real@example.com",
        mensagem: { to: "real@example.com" },
      }),
      error => error === socketError,
    );

    assert.equal(transportOptions[0].secure, true);
    assert.equal(
      transportOptions[0].connectionTimeout,
      emailService._testing.SMTP_CONNECTION_TIMEOUT_MS,
    );
    assert.equal(
      transportOptions[0].greetingTimeout,
      emailService._testing.SMTP_GREETING_TIMEOUT_MS,
    );
    assert.equal(
      transportOptions[0].socketTimeout,
      emailService._testing.SMTP_SOCKET_TIMEOUT_MS,
    );

    const failure = calls.find(([type]) => type === "trigger")?.[1];
    assert.equal(failure.event, "email_delivery_failed");
    assert.equal(failure.details.recipientMasked, "r***@example.com");
    assert.equal(failure.details.errorCode, "ESOCKET");
    assert.equal(failure.details.errorErrno, "ETIMEDOUT");
    assert.equal(failure.details.errorSyscall, "connect");
    assert.equal(failure.details.smtpCommand, "CONN");
    assert.equal(failure.details.remotePort, 465);
    assert.doesNotMatch(JSON.stringify(failure), /senha-nao-exposta/);

    fail = false;
    const result = await emailService._testing.enviarComAlerta({
      tipo: "password_recovery",
      destinatario: "real@example.com",
      mensagem: { to: "real@example.com" },
    });
    assert.equal(result.messageId, "message-1");

    const recovery = calls.find(([type]) => type === "resolve")?.[1];
    assert.equal(recovery.event, "email_delivery_failed");
    assert.equal(recovery.key, failure.key);
    assert.equal(recovery.details.status, "delivery_recovered");

    process.env.SMTP_PORT = "587";
    emailService._testing.criarTransportador();
    assert.equal(transportOptions.at(-1).secure, false);
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});



test("Resend envia por HTTPS, converte mensagem e preserva alertas seguros", async () => {
  const calls = [];
  const requests = [];
  let fail = true;
  const { emailService } = carregarEmailServiceComFakes({
    sendMail: async () => {
      throw new Error("SMTP não deve ser usado com Resend");
    },
    alertService: {
      trigger(input) { calls.push(["trigger", input]); },
      resolve(input) { calls.push(["resolve", input]); },
    },
  });
  const env = {
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_chave_que_nao_pode_aparecer",
    EMAIL_FROM: "Comanda Fácil <nao-responda@mail.example.test>",
  };
  const fetchFn = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    if (fail) {
      return {
        ok: false,
        status: 422,
        async json() {
          return { name: "validation_error", message: "Remetente inválido." };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() { return { id: "email-resend-1" }; },
    };
  };

  await assert.rejects(
    emailService._testing.enviarComAlerta({
      tipo: "password_recovery",
      destinatario: "real@example.com",
      env,
      fetchFn,
      mensagem: {
        from: { name: "Loja via Comanda Fácil", address: "nao-responda@mail.example.test" },
        to: "real@example.com",
        replyTo: "loja@example.com",
        subject: "Assunto",
        text: "Texto",
        html: "<p>Texto</p>",
      },
    }),
    error => error.name === "ResendApiError" && error.responseCode === 422,
  );

  const failure = calls.find(([type]) => type === "trigger")?.[1];
  assert.equal(failure.details.emailProvider, "resend");
  assert.equal(failure.details.responseCode, 422);
  assert.equal(failure.details.remoteAddress, "api.resend.com");
  assert.equal(failure.details.remotePort, 443);
  assert.doesNotMatch(JSON.stringify(failure), /re_chave_que_nao_pode_aparecer/);

  fail = false;
  const result = await emailService._testing.enviarComAlerta({
    tipo: "password_recovery",
    destinatario: "real@example.com",
    env,
    fetchFn,
    mensagem: {
      from: { name: "Loja via Comanda Fácil", address: "nao-responda@mail.example.test" },
      to: "real@example.com",
      replyTo: "loja@example.com",
      subject: "Assunto",
      text: "Texto",
      html: "<p>Texto</p>",
    },
  });
  assert.equal(result.messageId, "email-resend-1");
  assert.equal(requests.at(-1).url, "https://api.resend.com/emails");
  assert.equal(requests.at(-1).options.method, "POST");
  assert.equal(
    requests.at(-1).options.headers.Authorization,
    "Bearer re_chave_que_nao_pode_aparecer",
  );
  assert.deepEqual(requests.at(-1).body, {
    from: "Loja via Comanda Fácil <nao-responda@mail.example.test>",
    to: ["real@example.com"],
    subject: "Assunto",
    html: "<p>Texto</p>",
    text: "Texto",
    reply_to: "loja@example.com",
  });

  const recovery = calls.find(([type]) => type === "resolve")?.[1];
  assert.equal(recovery.details.emailProvider, "resend");
  assert.equal(recovery.details.status, "delivery_recovered");
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
