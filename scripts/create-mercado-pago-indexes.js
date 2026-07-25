"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const {
  Assinatura,
  AssinaturaTentativa,
  Configuracao,
  OAuthState,
  PaymentEvent,
  Pedido,
} = require("../src/models/painelModels");

const dryRun = process.argv.includes("--dry-run");
const apply = process.argv.includes("--apply");

if (!dryRun && !apply) {
  console.error("Use --dry-run para inspecionar ou --apply para criar índices ausentes.");
  process.exitCode = 2;
  return;
}
if (apply && process.env.ALLOW_INDEX_MIGRATION !== "true") {
  console.error("Defina ALLOW_INDEX_MIGRATION=true explicitamente para usar --apply.");
  process.exitCode = 2;
  return;
}
if (!process.env.CONNECTIONSTRING) {
  console.error("CONNECTIONSTRING não configurada.");
  process.exitCode = 2;
  return;
}

const definitions = [
  {
    model: Assinatura,
    key: { estabelecimentoId: 1 },
    options: { unique: true, name: "assinatura_estabelecimento_unico" },
  },
  {
    model: Configuracao,
    key: { estabelecimentoId: 1 },
    options: { unique: true, name: "configuracao_estabelecimento_unico" },
  },
  {
    model: Pedido,
    key: { mercadoPagoPaymentId: 1 },
    options: {
      unique: true,
      partialFilterExpression: { mercadoPagoPaymentId: { $type: "string", $gt: "" } },
      name: "pedido_payment_id_unico",
    },
  },
  {
    model: Assinatura,
    key: { mercadoPagoPaymentId: 1 },
    options: {
      unique: true,
      partialFilterExpression: { mercadoPagoPaymentId: { $type: "string", $gt: "" } },
      name: "assinatura_payment_id_unico",
    },
  },
  {
    model: Assinatura,
    key: { mercadoPagoPreapprovalId: 1 },
    options: {
      unique: true,
      partialFilterExpression: { mercadoPagoPreapprovalId: { $type: "string", $gt: "" } },
      name: "assinatura_preapproval_id_unico",
    },
  },
  {
    model: PaymentEvent,
    key: { eventKey: 1 },
    options: { unique: true, name: "payment_event_key_unico" },
  },
  {
    model: AssinaturaTentativa,
    key: { attemptId: 1 },
    options: { unique: true, name: "assinatura_tentativa_attempt_unico" },
  },
  {
    model: AssinaturaTentativa,
    key: { estabelecimentoId: 1, metodo: 1 },
    options: {
      unique: true,
      partialFilterExpression: { ativa: true },
      name: "assinatura_tentativa_ativa_unica",
    },
  },
  {
    model: OAuthState,
    key: { stateHash: 1 },
    options: { unique: true, name: "oauth_state_hash_unico" },
  },
  {
    model: OAuthState,
    key: { expiresAt: 1 },
    options: { expireAfterSeconds: 0, name: "oauth_state_expiracao_ttl" },
  },
];

async function run() {
  await mongoose.connect(process.env.CONNECTIONSTRING, { autoIndex: false });
  try {
    for (const definition of definitions) {
      const collection = definition.model.collection;
      const existing = await collection.indexes();
      const found = existing.some(index => index.name === definition.options.name);
      console.log(`${collection.collectionName}.${definition.options.name}: ${found ? "existente" : "ausente"}`);
      const fields = Object.keys(definition.key);
      const field = fields[0];
      const match = definition.options.partialFilterExpression || {
        [field]: { $exists: true },
      };
      const duplicates = definition.options.unique
        ? await collection.aggregate([
          { $match: match },
          {
            $group: {
              _id: fields.length === 1
                ? `$${field}`
                : Object.fromEntries(fields.map(name => [name, `$${name}`])),
              quantidade: { $sum: 1 },
            },
          },
          { $match: { quantidade: { $gt: 1 } } },
          { $limit: 1 },
        ]).toArray()
        : [];
      if (duplicates.length) {
        console.error(
          `${collection.collectionName}.${definition.options.name}: há valores duplicados; índice não será criado.`,
        );
        if (!dryRun) throw new Error(`Duplicidades impedem ${definition.options.name}.`);
        continue;
      }
      if (!dryRun && !found) {
        await collection.createIndex(definition.key, definition.options);
        console.log(`${collection.collectionName}.${definition.options.name}: criado`);
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch(error => {
  console.error("Falha ao gerenciar índices:", error.message);
  process.exitCode = 1;
});
