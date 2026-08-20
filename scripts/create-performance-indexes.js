"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const {
  Categoria,
  Estoque,
  Produto,
  Mesa,
  Funcionario,
  Pedido,
  WhatsAppConversa,
} = require("../src/models/painelModels");

const definitions = Object.freeze([
  {
    model: Categoria,
    key: { estabelecimentoId: 1, tipo: 1, nome: 1 },
    options: { name: "categoria_tenant_tipo_nome" },
    purpose: "Categorias de estoque/catálogo no carregamento do painel",
  },
  {
    model: Estoque,
    key: { estabelecimentoId: 1, ativo: 1, nome: 1 },
    options: { name: "estoque_tenant_ativo_nome" },
    purpose: "Lista de estoque por loja e nome",
  },
  {
    model: Produto,
    key: { estabelecimentoId: 1, nome: 1 },
    options: { name: "produto_tenant_nome" },
    purpose: "Produtos do catálogo administrativo por loja e nome",
  },
  {
    model: Mesa,
    key: { estabelecimentoId: 1, numero: 1 },
    options: { name: "mesa_tenant_numero" },
    purpose: "Mesas por loja ordenadas pelo número",
  },
  {
    model: Funcionario,
    key: { estabelecimentoId: 1, nome: 1 },
    options: { name: "funcionario_tenant_nome" },
    purpose: "Funcionários por loja ordenados pelo nome",
  },
  {
    model: Pedido,
    key: { estabelecimentoId: 1, excluido: 1, excluidoEm: -1 },
    options: { name: "pedido_tenant_arquivado_data" },
    purpose: "Pedidos arquivados por loja",
  },
  {
    model: Pedido,
    key: { estabelecimentoId: 1, canal: 1, pagamentoStatus: 1, createdAt: 1 },
    options: { name: "pedido_tenant_canal_pagamento_data" },
    purpose: "Conta aberta e pedidos de mesa pendentes",
  },
  {
    model: Pedido,
    key: { estabelecimentoId: 1, updatedAt: 1 },
    options: { name: "pedido_tenant_updated" },
    purpose: "Polling/realtime de pedidos alterados por loja",
  },
  {
    model: WhatsAppConversa,
    key: { estabelecimentoId: 1, updatedAt: -1 },
    options: { name: "whatsapp_conversa_tenant_updated" },
    purpose: "Conversas recentes do WhatsApp por loja",
  },
]);

function normalizeKey(key = {}) {
  return Object.entries(key).map(([field, direction]) => [field, Number(direction)]);
}

function sameKey(left = {}, right = {}) {
  const a = normalizeKey(left);
  const b = normalizeKey(right);
  return a.length === b.length && a.every((entry, index) =>
    entry[0] === b[index][0] && entry[1] === b[index][1]);
}

function equivalentIndex(index, definition) {
  return sameKey(index?.key || {}, definition.key);
}

async function inspectIndexes() {
  const plan = [];
  const byCollection = new Map();

  for (const definition of definitions) {
    const collection = definition.model.collection;
    const collectionName = collection.collectionName;
    let indexes = byCollection.get(collectionName);

    if (!indexes) {
      try {
        indexes = await collection.indexes();
      } catch (error) {
        if (error?.codeName === "NamespaceNotFound" || Number(error?.code) === 26) {
          indexes = [];
        } else {
          throw error;
        }
      }
      byCollection.set(collectionName, indexes);
    }

    const exactName = indexes.find(index => index.name === definition.options.name);
    const equivalent = indexes.find(index => equivalentIndex(index, definition));

    plan.push({
      definition,
      collection,
      collectionName,
      status: equivalent ? "present" : (exactName ? "name_conflict" : "missing"),
      existingName: equivalent?.name || exactName?.name || null,
    });
  }

  return plan;
}

function printPlan(plan) {
  console.log("\nÍndices de desempenho do painel\n");
  for (const item of plan) {
    const { definition } = item;
    console.log(
      `[${item.status.toUpperCase()}] ${item.collectionName}.${definition.options.name}`,
    );
    console.log(`  chave: ${JSON.stringify(definition.key)}`);
    console.log(`  uso: ${definition.purpose}`);
    if (item.existingName && item.existingName !== definition.options.name) {
      console.log(`  índice equivalente/conflitante existente: ${item.existingName}`);
    }
  }
  const missing = plan.filter(item => item.status === "missing").length;
  const conflicts = plan.filter(item => item.status === "name_conflict").length;
  console.log(`\nMISSING=${missing}`);
  console.log(`CONFLICTS=${conflicts}`);
  console.log(`SAFE_TO_APPLY=${conflicts === 0}`);
}

async function applyIndexes(plan) {
  if (process.env.ALLOW_INDEX_MIGRATION !== "true") {
    const error = new Error(
      "Aplicação bloqueada. Defina ALLOW_INDEX_MIGRATION=true para criar os índices.",
    );
    error.code = "INDEX_MIGRATION_NOT_ALLOWED";
    throw error;
  }

  const conflicts = plan.filter(item => item.status === "name_conflict");
  if (conflicts.length) {
    const error = new Error(
      "Existem conflitos de nome de índice. Nenhum índice foi criado.",
    );
    error.code = "INDEX_NAME_CONFLICT";
    throw error;
  }

  let created = 0;
  for (const item of plan) {
    if (item.status !== "missing") continue;
    await item.collection.createIndex(
      item.definition.key,
      item.definition.options,
    );
    created += 1;
    console.log(`CREATED ${item.collectionName}.${item.definition.options.name}`);
  }
  console.log(`CREATED_TOTAL=${created}`);
  return created;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run") || !apply;

  if (!process.env.CONNECTIONSTRING) {
    throw Object.assign(new Error("CONNECTIONSTRING não configurada."), {
      code: "CONNECTIONSTRING_MISSING",
    });
  }

  await mongoose.connect(process.env.CONNECTIONSTRING, { autoIndex: false });
  try {
    const plan = await inspectIndexes();
    printPlan(plan);
    if (dryRun && !apply) return;
    await applyIndexes(plan);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`${error.code || "PERFORMANCE_INDEX_ERROR"}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  definitions,
  equivalentIndex,
  inspectIndexes,
  applyIndexes,
};
