"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const {
  Assinatura,
  AssinaturaTentativa,
  Configuracao,
  Funcionario,
  OAuthState,
  PaymentEvent,
  Pedido,
  PrintAgent,
} = require("../src/models/painelModels");
const { registroModel } = require("../src/models/registroModel");

const definitions = [
  {
    model: Assinatura,
    key: { estabelecimentoId: 1 },
    options: { unique: true, name: "assinatura_estabelecimento_unico" },
    expectedType: "objectId",
  },
  {
    model: Configuracao,
    key: { estabelecimentoId: 1 },
    options: { unique: true, name: "configuracao_estabelecimento_unico" },
    expectedType: "objectId",
  },
  {
    model: Pedido,
    key: { mercadoPagoPaymentId: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        mercadoPagoPaymentId: { $type: "string", $gt: "" },
      },
      name: "pedido_payment_id_unico",
    },
    expectedType: "string",
  },
  {
    model: Assinatura,
    key: { mercadoPagoPaymentId: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        mercadoPagoPaymentId: { $type: "string", $gt: "" },
      },
      name: "assinatura_payment_id_unico",
    },
    expectedType: "string",
  },
  {
    model: Assinatura,
    key: { mercadoPagoPreapprovalId: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        mercadoPagoPreapprovalId: { $type: "string", $gt: "" },
      },
      name: "assinatura_preapproval_id_unico",
    },
    expectedType: "string",
  },
  {
    model: PaymentEvent,
    key: { eventKey: 1 },
    options: { unique: true, name: "payment_event_key_unico" },
    expectedType: "string",
  },
  {
    model: AssinaturaTentativa,
    key: { attemptId: 1 },
    options: {
      unique: true,
      name: "assinatura_tentativa_attempt_unico",
    },
    expectedType: "string",
  },
  {
    model: AssinaturaTentativa,
    key: { estabelecimentoId: 1 },
    options: {
      unique: true,
      partialFilterExpression: { ativa: true },
      name: "assinatura_tentativa_ativa_global_unica",
    },
    expectedType: "objectId",
  },
  {
    model: Funcionario,
    key: { email: 1 },
    options: { unique: true, name: "funcionario_email_global_unico" },
    expectedType: "string",
  },
  {
    model: PrintAgent,
    key: { estabelecimentoId: 1 },
    options: {
      unique: true,
      name: "print_agent_estabelecimento_unico",
    },
    expectedType: "objectId",
  },
  {
    model: PrintAgent,
    key: { tokenHash: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        tokenHash: { $type: "string", $gt: "" },
      },
      name: "print_agent_token_hash_unico",
    },
    expectedType: "string",
  },
  {
    model: PrintAgent,
    key: { codigoVinculacao: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        codigoVinculacao: { $type: "string", $gt: "" },
      },
      name: "print_agent_codigo_ativo_unico",
    },
    expectedType: "string",
  },
  {
    model: OAuthState,
    key: { stateHash: 1 },
    options: { unique: true, name: "oauth_state_hash_unico" },
    expectedType: "string",
  },
  {
    model: OAuthState,
    key: { expiresAt: 1 },
    options: {
      expireAfterSeconds: 0,
      name: "oauth_state_expiracao_ttl",
    },
    expectedType: "date",
  },
];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonicalize(left))
    === JSON.stringify(canonicalize(right));
}

function normalizedOptions(index) {
  return {
    unique: Boolean(index.unique),
    sparse: Boolean(index.sparse),
    partialFilterExpression: index.partialFilterExpression || null,
    expireAfterSeconds:
      Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds")
        ? Number(index.expireAfterSeconds)
        : null,
    collation: index.collation || null,
  };
}

function equivalentIndex(existing, definition) {
  return sameValue(existing.key, definition.key)
    && sameValue(
      normalizedOptions(existing),
      normalizedOptions(definition.options),
    );
}

function sameIndexKey(existing, definition) {
  return sameValue(existing.key, definition.key);
}

function combineMatch(base, condition) {
  if (!base || !Object.keys(base).length) return condition;
  return { $and: [base, condition] };
}

async function inspectUniqueData(collection, definition) {
  if (!definition.options.unique) return [];
  const field = Object.keys(definition.key)[0];
  const base = definition.options.partialFilterExpression || {};
  const conflicts = [];
  const missing = await collection.countDocuments(
    combineMatch(base, { [field]: { $exists: false } }),
  );
  const nulls = await collection.countDocuments(
    combineMatch(base, { [field]: { $type: "null" } }),
  );
  const empty = await collection.countDocuments(
    combineMatch(base, { [field]: "" }),
  );
  const incompatible = definition.expectedType
    ? await collection.countDocuments(
      combineMatch(base, {
        [field]: {
          $exists: true,
          $ne: null,
          $not: { $type: definition.expectedType },
        },
      }),
    )
    : 0;

  if (missing > 1) conflicts.push({ type: "campo ausente", count: missing });
  if (nulls > 1) conflicts.push({ type: "valor null", count: nulls });
  if (missing + nulls > 1) {
    conflicts.push({
      type: "ausente/null combinados",
      count: missing + nulls,
    });
  }
  if (empty > 1) conflicts.push({ type: "string vazia", count: empty });
  if (incompatible) {
    conflicts.push({ type: "tipo incompatível", count: incompatible });
  }

  const validMatch = {
    [field]: {
      $exists: true,
      $ne: null,
      ...(definition.expectedType
        ? { $type: definition.expectedType }
        : {}),
      ...(definition.expectedType === "string" ? { $gt: "" } : {}),
    },
  };
  const duplicateGroups = await collection.aggregate([
    { $match: combineMatch(base, validMatch) },
    { $group: { _id: `$${field}`, quantidade: { $sum: 1 } } },
    { $match: { quantidade: { $gt: 1 } } },
    {
      $group: {
        _id: null,
        grupos: { $sum: 1 },
        documentos: { $sum: "$quantidade" },
      },
    },
  ]).toArray();
  if (duplicateGroups.length) {
    conflicts.push({
      type: "valores duplicados",
      count: duplicateGroups[0].documentos,
      groups: duplicateGroups[0].grupos,
    });
  }
  return conflicts;
}

function describeConflict(collectionName, definition, conflict) {
  const field = Object.keys(definition.key).join(",");
  const groups = conflict.groups
    ? ` em ${conflict.groups} grupo(s)`
    : "";
  return `${collectionName}.${field}: ${conflict.count} documento(s) com ${conflict.type}${groups}.`;
}

async function auditDefinitions({
  indexDefinitions = definitions,
  dryRun,
  apply,
  log = console,
}) {
  const plan = [];
  const blockers = [];

  for (const definition of indexDefinitions) {
    const collection = definition.model.collection;
    const collectionName = collection.collectionName;
    const indexes = await collection.indexes();
    const byName = indexes.find(
      index => index.name === definition.options.name,
    );
    if (byName) {
      if (equivalentIndex(byName, definition)) {
        log.log(`${collectionName}.${definition.options.name}: existente`);
        plan.push({ definition, collection, status: "existing", index: byName });
      } else {
        blockers.push(
          `${collectionName}.${definition.options.name}: o nome existe com opções incompatíveis.`,
        );
      }
      continue;
    }

    const sameKey = indexes.filter(index =>
      sameIndexKey(index, definition));
    const equivalent = sameKey.find(index =>
      equivalentIndex(index, definition));
    if (equivalent) {
      log.log(
        `${collectionName}.${definition.options.name}: existente como ${equivalent.name}`,
      );
      plan.push({
        definition,
        collection,
        status: "equivalent",
        index: equivalent,
      });
      continue;
    }
    if (sameKey.length) {
      blockers.push(
        `${collectionName}.${definition.options.name}: a mesma key existe com opções incompatíveis.`,
      );
      continue;
    }

    log.log(`${collectionName}.${definition.options.name}: ausente`);
    const dataConflicts = await inspectUniqueData(collection, definition);
    for (const conflict of dataConflicts) {
      blockers.push(describeConflict(
        collectionName,
        definition,
        conflict,
      ));
    }
    plan.push({ definition, collection, status: "missing" });
  }

  if (blockers.length) {
    blockers.forEach(message => log.error(message));
    throw new Error(
      "Conflitos impedem a aplicação segura; nenhum índice foi criado.",
    );
  }

  if (apply && !dryRun) {
    for (const item of plan.filter(entry => entry.status === "missing")) {
      await item.collection.createIndex(
        item.definition.key,
        item.definition.options,
      );
      log.log(
        `${item.collection.collectionName}.${item.definition.options.name}: criado`,
      );
    }
  }
  return plan;
}

async function inspectCrossCollectionIdentity({ apply, log = console }) {
  const conflicts = await Funcionario.collection.aggregate([
    { $match: { email: { $type: "string", $gt: "" } } },
    {
      $lookup: {
        from: registroModel.collection.collectionName,
        localField: "email",
        foreignField: "email",
        as: "proprietarios",
      },
    },
    { $match: { "proprietarios.0": { $exists: true } } },
    { $count: "quantidade" },
  ]).toArray();
  const count = conflicts[0]?.quantidade || 0;
  if (count) {
    log.error(
      `identidade.email: ${count} conflito(s) entre proprietário e funcionário; nenhum e-mail foi exposto.`,
    );
    if (apply) {
      throw new Error(
        "Conflitos de identidade precisam ser conciliados antes de aplicar os índices.",
      );
    }
  }
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (!dryRun && !apply) {
    throw new Error(
      "Use --dry-run para inspecionar ou --apply para criar índices ausentes.",
    );
  }
  if (apply && process.env.ALLOW_INDEX_MIGRATION !== "true") {
    throw new Error(
      "Defina ALLOW_INDEX_MIGRATION=true explicitamente para usar --apply.",
    );
  }
  if (!process.env.CONNECTIONSTRING) {
    throw new Error("CONNECTIONSTRING não configurada.");
  }

  await mongoose.connect(process.env.CONNECTIONSTRING, { autoIndex: false });
  try {
    await inspectCrossCollectionIdentity({ apply });
    await auditDefinitions({ dryRun, apply });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error("Falha ao gerenciar índices:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  auditDefinitions,
  canonicalize,
  definitions,
  equivalentIndex,
  inspectUniqueData,
  normalizedOptions,
  sameIndexKey,
};
