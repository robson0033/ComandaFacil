"use strict";

const MANUAL_PRINT_COOLDOWN_MS = 30_000;

const BLOCKING_PRINT_STATUSES = Object.freeze([
  "pendente",
  "entregando",
  "aguardando_retry",
  "recebido",
  "processando",
  "enviado",
  "concluido",
  "resultado_desconhecido",
]);

function toTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function evaluateManualPrintRequest({
  jobs = [],
  confirmReprint = false,
  now = Date.now(),
  cooldownMs = MANUAL_PRINT_COOLDOWN_MS,
} = {}) {
  const blockingJobs = jobs
    .filter(job => BLOCKING_PRINT_STATUSES.includes(String(job?.status || "")))
    .sort((left, right) => toTimestamp(right?.createdAt) - toTimestamp(left?.createdAt));

  if (blockingJobs.length > 0 && confirmReprint !== true) {
    return {
      action: "confirm_reprint",
      latestJob: blockingJobs[0],
      blockingJobs,
    };
  }

  const threshold = Number(now) - Math.max(0, Number(cooldownMs) || 0);
  const recentManualJob = blockingJobs.find(job =>
    String(job?.tipo || "") === "manual"
    && toTimestamp(job?.createdAt) >= threshold,
  );

  if (confirmReprint === true && recentManualJob) {
    const elapsedMs = Math.max(0, Number(now) - toTimestamp(recentManualJob.createdAt));
    return {
      action: "too_recent",
      latestJob: recentManualJob,
      retryAfterSeconds: Math.max(1, Math.ceil((cooldownMs - elapsedMs) / 1000)),
      blockingJobs,
    };
  }

  return {
    action: "allow",
    latestJob: blockingJobs[0] || null,
    blockingJobs,
  };
}

module.exports = {
  BLOCKING_PRINT_STATUSES,
  MANUAL_PRINT_COOLDOWN_MS,
  evaluateManualPrintRequest,
};
