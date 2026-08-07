"use strict";

const { logger: appLogger } = require("../utils/logger");
const { operationalAlerts } = require("./operationalAlertService");

const DEFAULT_STUCK_MS = 3 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

function integerValue(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function buildStuckPrintJobQuery({ now = new Date(), stuckMs = DEFAULT_STUCK_MS } = {}) {
  const staleBefore = new Date(now.getTime() - stuckMs);
  return {
    $or: [
      {
        status: "pendente",
        createdAt: { $lte: staleBefore },
        nextAttemptAt: { $lte: now },
      },
      {
        status: "aguardando_retry",
        updatedAt: { $lte: staleBefore },
        nextAttemptAt: { $lte: now },
      },
      {
        status: { $in: ["entregando", "recebido", "processando", "enviado"] },
        leaseExpiresAt: { $lte: staleBefore },
      },
      {
        status: "resultado_desconhecido",
        updatedAt: { $lte: staleBefore },
      },
    ],
  };
}

function createPrintQueueAlertMonitor({
  PrintJobModel,
  alertService = operationalAlerts,
  logger = appLogger,
  env = process.env,
  now = () => new Date(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const stuckMs = integerValue(
    env.ALERT_QUEUE_STUCK_MS,
    DEFAULT_STUCK_MS,
    60_000,
    60 * 60_000,
  );
  const intervalMs = integerValue(
    env.ALERT_QUEUE_CHECK_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    15_000,
    30 * 60_000,
  );
  const activeStoreKeys = new Set();
  let timer = null;

  function model() {
    if (PrintJobModel) return PrintJobModel;
    return require("../models/painelModels").PrintJob;
  }

  async function loadStuckJobs(currentDate) {
    return model()
      .find(buildStuckPrintJobQuery({ now: currentDate, stuckMs }))
      .select("estabelecimentoId jobId status createdAt updatedAt nextAttemptAt leaseExpiresAt")
      .sort({ createdAt: 1 })
      .limit(500)
      .lean();
  }

  async function check() {
    const currentDate = now();
    try {
      const jobs = await loadStuckJobs(currentDate);
      const grouped = new Map();
      for (const job of jobs) {
        const storeId = String(job.estabelecimentoId || "");
        if (!storeId) continue;
        const group = grouped.get(storeId) || {
          count: 0,
          statuses: {},
          oldest: currentDate,
          jobSuffixes: [],
        };
        group.count += 1;
        group.statuses[job.status] = Number(group.statuses[job.status] || 0) + 1;
        const referenceDate = new Date(job.createdAt || job.updatedAt || currentDate);
        if (referenceDate < group.oldest) group.oldest = referenceDate;
        if (group.jobSuffixes.length < 5) {
          group.jobSuffixes.push(String(job.jobId || "").slice(-8));
        }
        grouped.set(storeId, group);
      }

      const currentKeys = new Set();
      for (const [storeId, group] of grouped) {
        const key = `print_queue_stuck:${storeId}`;
        currentKeys.add(key);
        activeStoreKeys.add(key);
        alertService.trigger({
          event: "print_queue_stuck",
          key,
          severity: "critical",
          details: {
            estabelecimentoIdSuffix: storeId.slice(-8),
            stuckJobs: group.count,
            statuses: group.statuses,
            oldestAgeSeconds: Math.max(
              0,
              Math.round((currentDate.getTime() - group.oldest.getTime()) / 1000),
            ),
            jobIdSuffixes: group.jobSuffixes,
          },
        });
      }

      for (const key of [...activeStoreKeys]) {
        if (currentKeys.has(key)) continue;
        activeStoreKeys.delete(key);
        alertService.resolve({
          event: "print_queue_stuck",
          key,
          details: { status: "queue_recovered" },
        });
      }

      alertService.resolve({
        event: "print_queue_monitor_failed",
        key: "print_queue_monitor_failed",
        details: { status: "monitor_recovered" },
      });
      return { checked: true, stuckJobs: jobs.length, stores: grouped.size };
    } catch (error) {
      logger.error("print_queue_alert_monitor_failed", {
        errorName: String(error?.name || "Error").slice(0, 80),
        errorCode: String(error?.code || "").slice(0, 120) || null,
      });
      alertService.trigger({
        event: "print_queue_monitor_failed",
        key: "print_queue_monitor_failed",
        severity: "critical",
        details: {
          errorName: String(error?.name || "Error").slice(0, 80),
          errorCode: String(error?.code || "").slice(0, 120) || null,
        },
      });
      return { checked: false, stuckJobs: 0, stores: 0 };
    }
  }

  function start() {
    if (timer) return timer;
    void check();
    timer = setIntervalFn(() => void check(), intervalMs);
    timer.unref?.();
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return Object.freeze({ check, start, stop });
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_STUCK_MS,
  buildStuckPrintJobQuery,
  createPrintQueueAlertMonitor,
};
