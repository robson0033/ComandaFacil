"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  MANUAL_PRINT_COOLDOWN_MS,
  evaluateManualPrintRequest,
} = require("../src/services/manualPrintGuard");

function job(overrides = {}) {
  return {
    jobId: "job-1",
    tipo: "automatica",
    status: "concluido",
    createdAt: new Date("2026-08-03T18:18:57.000Z"),
    ...overrides,
  };
}

test("qualquer impressão anterior exige confirmação explícita de reimpressão", () => {
  const result = evaluateManualPrintRequest({ jobs: [job()] });
  assert.equal(result.action, "confirm_reprint");
  assert.equal(result.latestJob.jobId, "job-1");
});

test("confirmação explícita libera reimpressão quando não há manual recente", () => {
  const result = evaluateManualPrintRequest({
    jobs: [job()],
    confirmReprint: true,
    now: new Date("2026-08-03T18:20:00.000Z").getTime(),
  });
  assert.equal(result.action, "allow");
});

test("job manual recente bloqueia nova via mesmo após confirmação", () => {
  const now = new Date("2026-08-03T18:20:00.000Z").getTime();
  const result = evaluateManualPrintRequest({
    jobs: [job({
      tipo: "manual",
      createdAt: new Date(now - 5_000),
    })],
    confirmReprint: true,
    now,
  });
  assert.equal(result.action, "too_recent");
  assert.equal(result.retryAfterSeconds, 25);
  assert.equal(MANUAL_PRINT_COOLDOWN_MS, 30_000);
});

test("jobs falhos ou cancelados não transformam a primeira impressão em reimpressão", () => {
  const result = evaluateManualPrintRequest({
    jobs: [
      job({ status: "falhou" }),
      job({ status: "cancelado", jobId: "job-2" }),
    ],
  });
  assert.equal(result.action, "allow");
});

test("painel preserva bloqueio do botão e pede confirmação antes de reimprimir", () => {
  const view = fs.readFileSync(
    path.join(__dirname, "../src/views/admin-real.ejs"),
    "utf8",
  );
  assert.match(view, /button\.dataset\.printBusy === 'true'/);
  assert.match(view, /PRINT_REPRINT_CONFIRMATION_REQUIRED/);
  assert.match(view, /Confirme somente se deseja realmente imprimir outra via/);
  assert.match(view, /button\.disabled = !online \|\| printBusy/);
});

test("backend consulta histórico e protege requisições simultâneas", () => {
  const controller = fs.readFileSync(
    path.join(__dirname, "../src/controllers/adminRealController.js"),
    "utf8",
  );
  assert.match(controller, /manualPrintRequestsInFlight/);
  assert.match(controller, /PRINT_REQUEST_IN_PROGRESS/);
  assert.match(controller, /PRINT_REPRINT_CONFIRMATION_REQUIRED/);
  assert.match(controller, /PRINT_REPRINT_TOO_SOON/);
  assert.match(controller, /PrintJob\.find\(\{/);
});
