"use strict";

const path = require("node:path");
const mongoose = require("mongoose");

try {
  require("dotenv").config({ path: path.resolve(process.cwd(), ".env") });
} catch (_error) {
  // dotenv é opcional para ambientes que já injetam variáveis externamente.
}

const ONE_HOUR_MS = 60 * 60 * 1000;

function assertReadonlyEnabled(env = process.env) {
  if (String(env.ALLOW_READONLY_PERF_AUDIT || "").toLowerCase() !== "true") {
    const error = new Error(
      "Auditoria somente-leitura bloqueada. Execute com ALLOW_READONLY_PERF_AUDIT=true.",
    );
    error.code = "READONLY_PERF_AUDIT_NOT_ALLOWED";
    throw error;
  }
}

function safePositiveInt(value, fallback, min = 1, max = 24 * 365) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function suffix(value) {
  const text = String(value || "");
  return text ? text.slice(-8) : "-";
}

function walk(node, visitor, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  visitor(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visitor, seen);
    return;
  }
  for (const value of Object.values(node)) walk(value, visitor, seen);
}

function summarizeExplain(explain = {}) {
  const stages = new Set();
  const indexes = new Set();
  let stats = null;

  walk(explain, (node) => {
    if (typeof node.stage === "string") stages.add(node.stage);
    if (typeof node.indexName === "string") indexes.add(node.indexName);
    if (
      !stats &&
      Number.isFinite(node.totalDocsExamined) &&
      Number.isFinite(node.totalKeysExamined)
    ) {
      stats = node;
    }
  });

  const nReturned = Number(stats?.nReturned ?? explain?.executionStats?.nReturned ?? 0);
  const totalDocsExamined = Number(
    stats?.totalDocsExamined ?? explain?.executionStats?.totalDocsExamined ?? 0,
  );
  const totalKeysExamined = Number(
    stats?.totalKeysExamined ?? explain?.executionStats?.totalKeysExamined ?? 0,
  );
  const executionTimeMillis = Number(
    stats?.executionTimeMillis ?? explain?.executionStats?.executionTimeMillis ?? 0,
  );
  const stageList = [...stages];
  const indexList = [...indexes];

  let status = "OK";
  let reason = "plano indexado/baixo custo aparente";

  if (stageList.includes("COLLSCAN")) {
    status = "ATENCAO";
    reason = "COLLSCAN detectado";
  } else if (
    totalDocsExamined > 500 &&
    totalDocsExamined > Math.max(100, nReturned * 20)
  ) {
    status = "REVISAR";
    reason = "muitos documentos examinados para o retorno";
  } else if (executionTimeMillis >= 100) {
    status = "REVISAR";
    reason = "tempo de execução acima de 100 ms";
  }

  return {
    status,
    reason,
    stages: stageList,
    indexes: indexList,
    nReturned,
    totalDocsExamined,
    totalKeysExamined,
    executionTimeMillis,
  };
}

function printSummary(label, summary) {
  console.log(`\n[${summary.status}] ${label}`);
  console.log(`  motivo: ${summary.reason}`);
  console.log(`  stages: ${summary.stages.join(", ") || "-"}`);
  console.log(`  indexes: ${summary.indexes.join(", ") || "-"}`);
  console.log(`  retornados: ${summary.nReturned}`);
  console.log(`  docs examinados: ${summary.totalDocsExamined}`);
  console.log(`  chaves examinadas: ${summary.totalKeysExamined}`);
  console.log(`  tempo: ${summary.executionTimeMillis} ms`);
}

async function explainFind(collection, filter, { projection, sort, limit } = {}) {
  let cursor = collection.find(filter, projection ? { projection } : undefined);
  if (sort) cursor = cursor.sort(sort);
  if (limit) cursor = cursor.limit(limit);
  return cursor.explain("executionStats");
}

async function chooseTenant(pedidos, explicitId) {
  if (explicitId) {
    if (!mongoose.isValidObjectId(explicitId)) {
      const error = new Error("PERF_ESTABELECIMENTO_ID inválido.");
      error.code = "PERF_ESTABELECIMENTO_ID_INVALID";
      throw error;
    }
    return new mongoose.Types.ObjectId(explicitId);
  }

  const [candidate] = await pedidos.aggregate([
    { $match: { estabelecimentoId: { $ne: null } } },
    { $group: { _id: "$estabelecimentoId", quantidade: { $sum: 1 } } },
    { $sort: { quantidade: -1 } },
    { $limit: 1 },
  ]).toArray();

  if (!candidate?._id) {
    const error = new Error("Nenhum estabelecimento com pedidos foi encontrado para auditar.");
    error.code = "PERF_AUDIT_NO_TENANT";
    throw error;
  }

  return candidate._id;
}

async function main() {
  assertReadonlyEnabled();

  const uri = String(process.env.CONNECTIONSTRING || "").trim();
  if (!uri) {
    const error = new Error("CONNECTIONSTRING ausente.");
    error.code = "PERF_AUDIT_CONNECTIONSTRING_MISSING";
    throw error;
  }

  const hours = safePositiveInt(process.env.PERF_AUDIT_HOURS, 24);
  const now = new Date();
  const from = new Date(now.getTime() - hours * ONE_HOUR_MS);

  mongoose.set("autoIndex", false);
  await mongoose.connect(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10000,
  });

  try {
    const db = mongoose.connection.db;
    const pedidos = db.collection("pedidos");
    const mesas = db.collection("mesas");

    const tenantId = await chooseTenant(
      pedidos,
      String(process.env.PERF_ESTABELECIMENTO_ID || "").trim(),
    );

    const totalPedidosTenant = await pedidos.countDocuments({ estabelecimentoId: tenantId });
    const totalMesasTenant = await mesas.countDocuments({ estabelecimentoId: tenantId });

    console.log("\nAuditoria READ-ONLY de desempenho do Dashboard");
    console.log("Nenhum insert/update/delete/index é executado por este script.");
    console.log(`tenant suffix: ${suffix(tenantId)}`);
    console.log(`janela analisada: últimas ${hours}h`);
    console.log(`pedidos da loja: ${totalPedidosTenant}`);
    console.log(`mesas da loja: ${totalMesasTenant}`);

    const activeBase = {
      estabelecimentoId: tenantId,
      excluido: { $ne: true },
      status: { $ne: "cancelado" },
    };

    const checks = [
      {
        label: "Dashboard - lista recente do período",
        collection: pedidos,
        filter: {
          ...activeBase,
          createdAt: { $gte: from, $lte: now },
        },
        options: {
          projection: {
            _id: 1,
            cliente: 1,
            canal: 1,
            total: 1,
            status: 1,
            pagamentos: 1,
            formaPagamento: 1,
            pagamentoStatus: 1,
            createdAt: 1,
            mesaId: 1,
          },
          sort: { createdAt: -1 },
          limit: 100,
        },
      },
      {
        label: "Dashboard - pedidos do período",
        collection: pedidos,
        filter: {
          ...activeBase,
          createdAt: { $gte: from, $lte: now },
        },
        options: { projection: { _id: 1 } },
      },
      {
        label: "Dashboard - pagamentos pagos do período",
        collection: pedidos,
        filter: {
          ...activeBase,
          pagamentoStatus: "pago",
          pagoEm: { $gte: from, $lte: now },
        },
        options: {
          projection: { _id: 1, total: 1, pagamentos: 1, formaPagamento: 1 },
        },
      },
      {
        label: "Mesas - todas da loja",
        collection: mesas,
        filter: { estabelecimentoId: tenantId },
        options: { projection: { _id: 1 } },
      },
      {
        label: "Mesas - ocupadas/aguardando pagamento",
        collection: mesas,
        filter: {
          estabelecimentoId: tenantId,
          status: { $in: ["ocupada", "aguardando_pagamento"] },
        },
        options: { projection: { _id: 1 } },
      },
      {
        label: "Pedidos - contas de mesa abertas",
        collection: pedidos,
        filter: {
          estabelecimentoId: tenantId,
          canal: "mesa",
          mesaId: { $ne: null },
          excluido: { $ne: true },
          pagamentoStatus: "pendente",
          status: { $ne: "cancelado" },
        },
        options: {
          projection: { _id: 1, mesaId: 1, total: 1, pagamentoStatus: 1, status: 1 },
          sort: { createdAt: 1 },
          limit: 1000,
        },
      },
    ];

    let attention = 0;
    let review = 0;

    for (const check of checks) {
      const explain = await explainFind(
        check.collection,
        check.filter,
        check.options,
      );
      const summary = summarizeExplain(explain);
      if (summary.status === "ATENCAO") attention += 1;
      if (summary.status === "REVISAR") review += 1;
      printSummary(check.label, summary);
    }

    const pedidoIndexes = await pedidos.listIndexes().toArray();
    const mesaIndexes = await mesas.listIndexes().toArray();

    console.log("\nÍndices detectados (somente nomes/chaves):");
    for (const index of pedidoIndexes) {
      console.log(`  pedidos.${index.name}: ${JSON.stringify(index.key)}`);
    }
    for (const index of mesaIndexes) {
      console.log(`  mesas.${index.name}: ${JSON.stringify(index.key)}`);
    }

    console.log("\nRESUMO");
    console.log(`ATENCAO=${attention}`);
    console.log(`REVISAR=${review}`);
    console.log(`OK=${checks.length - attention - review}`);
    console.log("READ_ONLY=true");
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = {
  assertReadonlyEnabled,
  safePositiveInt,
  summarizeExplain,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[PERF_AUDIT_ERROR] ${error.code || "ERROR"}: ${error.message}`);
    process.exitCode = 1;
  });
}
