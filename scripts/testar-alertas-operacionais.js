"use strict";

require("dotenv").config({ quiet: true });

const crypto = require("crypto");
const {
  createOperationalAlertService,
} = require("../src/services/operationalAlertService");

async function main() {
  if (process.env.ALLOW_OPERATIONAL_ALERT_TEST !== "true") {
    console.error("ERRO=CONFIRMACAO_DE_HOMOLOGACAO_AUSENTE");
    process.exitCode = 1;
    return;
  }
  if (!String(process.env.ALERT_WEBHOOK_URL || "").trim()) {
    console.error("ERRO=ALERT_WEBHOOK_URL_NAO_CONFIGURADA");
    process.exitCode = 1;
    return;
  }

  const alerts = createOperationalAlertService();
  if (!alerts.isConfigured()) {
    console.error("ERRO=CANAL_DE_ALERTA_INVALIDO");
    process.exitCode = 1;
    return;
  }

  const runId = crypto.randomUUID().slice(0, 8);
  const samples = [
    ["http_5xx_threshold", "error", { statusCode: 500, count: 5, testRun: runId }],
    ["readiness_unavailable", "critical", { status: "not_ready", testRun: runId }],
    ["mercado_pago_webhook_failed", "critical", { stage: "test", testRun: runId }],
    ["print_queue_stuck", "critical", { stuckJobs: 2, testRun: runId }],
    ["email_delivery_failed", "critical", { emailType: "test", testRun: runId }],
  ];

  for (const [event, severity, details] of samples) {
    alerts.trigger({
      event,
      key: `homologation:${runId}:${event}`,
      severity,
      details,
    });
  }
  alerts.resolve({
    event: "readiness_unavailable",
    key: `homologation:${runId}:readiness_unavailable`,
    details: { status: "ready", testRun: runId },
  });
  alerts.resolve({
    event: "print_queue_stuck",
    key: `homologation:${runId}:print_queue_stuck`,
    details: { status: "queue_recovered", testRun: runId },
  });

  const results = await alerts.flush();
  const failures = results.filter(result => !result?.ok);
  console.log(`TEST_RUN=${runId}`);
  console.log(`ALERTAS_ESPERADOS=${samples.length + 2}`);
  console.log(`ALERTAS_ENTREGUES=${results.filter(result => result?.ok).length}`);
  console.log(`FALHAS_DE_ENTREGA=${failures.length}`);
  console.log(`SEGREDOS_EXIBIDOS=NAO`);
  console.log(`CANAL_ALERTA_OK=${failures.length === 0 ? "SIM" : "NAO"}`);
  if (failures.length) process.exitCode = 2;
}

main().catch(error => {
  console.error(`ERRO=${String(error?.message || error).slice(0, 300)}`);
  process.exitCode = 3;
});
