"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const {
  Assinatura,
  AssinaturaTentativa,
  AuditoriaEvento,
  Configuracao,
  Funcionario,
  OAuthState,
  PaymentEvent,
  Pedido,
  OrderPaymentAttempt,
  PrintAgent,
} = require("../src/models/painelModels");
const { registroModel } = require("../src/models/registroModel");

const definitions = [
  {
    model: OrderPaymentAttempt,
    key: { publicReference: 1 },
    options: { unique: true, name: "order_attempt_public_reference_unique" },
    expectedType: "string",
  },
  {
    model: OrderPaymentAttempt,
    key: { externalReference: 1 },
    options: { unique: true, name: "order_attempt_external_reference_unique" },
    expectedType: "string",
  },
  {
    model: OrderPaymentAttempt,
    key: { paymentId: 1 },
    options: {
      unique: true,
      partialFilterExpression: { paymentId: { $type: "string", $gt: "" } },
      name: "order_attempt_payment_id_unique",
    },
    expectedType: "string",
  },
  {
    model: OrderPaymentAttempt,
    key: { idempotencyKey: 1 },
    options: { unique: true, name: "order_attempt_idempotency_unique" },
    expectedType: "string",
  },
  {
    model: OrderPaymentAttempt,
    key: { estabelecimentoId: 1, pedidoId: 1, createdAt: -1 },
    options: { name: "order_attempt_tenant_order" },
    expectedType: "objectId",
  },
  {
    model: OrderPaymentAttempt,
    key: { estabelecimentoId: 1, status: 1 },
    options: { name: "order_attempt_tenant_status" },
    expectedType: "objectId",
  },
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
    key: { estabelecimentoId: 1, excluido: 1, createdAt: -1 },
    options: { name: "pedido_estabelecimento_excluido_data" },
    expectedType: "objectId",
  },
  {
    model: AuditoriaEvento,
    key: { operationKey: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        operationKey: { $type: "string" },
      },
      name: "auditoria_operation_key_unico",
    },
    expectedType: "string",
  },
  {
    model: AuditoriaEvento,
    key: { estabelecimentoId: 1, registradoEm: -1 },
    options: { name: "auditoria_estabelecimento_data" },
    expectedType: "objectId",
  },
  {
    model: Pedido,
    key: { acompanhamentoTokenHash: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        acompanhamentoTokenHash: { $type: "string" },
      },
      name: "pedido_acompanhamento_token_hash_unico",
    },
    expectedType: "string",
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

const purposes = {
  order_attempt_public_reference_unique: "identidade pública única da tentativa de pagamento do pedido",
  order_attempt_external_reference_unique: "correlação única enviada ao provedor",
  order_attempt_payment_id_unique: "impedir reutilização do pagamento confirmado pelo provedor",
  order_attempt_idempotency_unique: "deduplicar a criação lógica da tentativa",
  order_attempt_tenant_order: "consultar histórico da tentativa por loja e pedido",
  order_attempt_tenant_status: "consultar tentativas por loja e estado",
  assinatura_estabelecimento_unico: "manter uma assinatura canônica por loja",
  configuracao_estabelecimento_unico: "manter uma configuração canônica por loja",
  pedido_estabelecimento_excluido_data: "listar pedidos da loja por exclusão e data",
  auditoria_operation_key_unico: "deduplicar uma operação auditada",
  auditoria_estabelecimento_data: "consultar auditoria da loja em ordem temporal",
  pedido_acompanhamento_token_hash_unico: "impedir compartilhamento de token de acompanhamento",
  pedido_payment_id_unico: "impedir o mesmo pagamento em pedidos diferentes",
  assinatura_payment_id_unico: "impedir o mesmo Pix em assinaturas diferentes",
  assinatura_preapproval_id_unico: "impedir a mesma recorrência em assinaturas diferentes",
  payment_event_key_unico: "processar cada evento de pagamento uma única vez",
  assinatura_tentativa_attempt_unico: "identificar unicamente a tentativa de assinatura",
  assinatura_tentativa_ativa_global_unica: "permitir no máximo uma tentativa ativa por loja",
  funcionario_email_global_unico: "manter identidade de login de funcionário globalmente única",
  print_agent_estabelecimento_unico: "manter um agente de impressão por loja",
  print_agent_token_hash_unico: "impedir reutilização do token do agente",
  print_agent_codigo_ativo_unico: "impedir reutilização do código de vínculo ativo",
  oauth_state_hash_unico: "garantir state OAuth de uso único",
  oauth_state_expiracao_ttl: "remover state OAuth depois da data de expiração",
};

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

function formatIndexCommand(collectionName, definition) {
  return `db.${collectionName}.createIndex(${JSON.stringify(definition.key)}, ${JSON.stringify(definition.options)})`;
}

function describeDefinition(collectionName, definition) {
  const options = normalizedOptions(definition.options);
  return {
    collection: collectionName,
    name: definition.options.name,
    fields: definition.key,
    options,
    unique: options.unique,
    sparse: options.sparse,
    partialFilterExpression: options.partialFilterExpression,
    ttl: options.expireAfterSeconds,
    purpose: purposes[definition.options.name] || "índice controlado pela aplicação",
    inspection: definition.options.unique
      ? "agrupar pelos campos do índice após aplicar o partialFilterExpression e contar grupos com quantidade > 1"
      : options.expireAfterSeconds !== null
        ? "contar expiresAt ausente, null e com tipo BSON diferente de date"
        : "comparar nome, key e opções com o catálogo de índices",
  };
}

function eligibilityFilter(definition) {
  return definition.options.partialFilterExpression || {};
}

function isPartial(definition) {
  return Boolean(definition.options.partialFilterExpression);
}

async function inspectUniqueData(collection, definition) {
  if (!definition.options.unique) return [];
  const field = Object.keys(definition.key)[0];
  const base = eligibilityFilter(definition);
  const conflicts = [];
  const missing = await collection.countDocuments(
    { [field]: { $exists: false } },
  );
  const nulls = await collection.countDocuments(
    { [field]: { $type: "null" } },
  );
  const empty = await collection.countDocuments(
    { [field]: "" },
  );
  const incompatible = definition.expectedType
    ? await collection.countDocuments(
      {
        [field]: {
          $exists: true,
          $ne: null,
          $not: { $type: definition.expectedType },
        },
      },
    )
    : 0;

  if (!isPartial(definition) && missing > 1) {
    conflicts.push({ type: "campo ausente", count: missing });
  }
  if (!isPartial(definition) && nulls > 1) {
    conflicts.push({ type: "valor null", count: nulls });
  }
  if (!isPartial(definition) && missing + nulls > 1) {
    conflicts.push({
      type: "ausente/null combinados",
      count: missing + nulls,
    });
  }
  if (!isPartial(definition) && empty > 1) {
    conflicts.push({ type: "string vazia", count: empty });
  }
  if (!isPartial(definition) && incompatible) {
    conflicts.push({ type: "tipo incompatível", count: incompatible });
  }

  const validMatch = {
    [field]: {
      $exists: true,
      $ne: null,
      ...(definition.expectedType
        ? { $type: definition.expectedType }
        : {}),
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
  conflicts.diagnostics = {
    missing,
    nulls,
    empty,
    incompatible,
    partialFilterExpression: definition.options.partialFilterExpression || null,
    excludedByPartialFilter: isPartial(definition),
    duplicateDocuments: duplicateGroups[0]?.documentos || 0,
    duplicateGroups: duplicateGroups[0]?.grupos || 0,
  };
  return conflicts;
}

async function inspectTtlData(collection, definition) {
  const field = Object.keys(definition.key)[0];
  const missing = await collection.countDocuments({ [field]: { $exists: false } });
  const nulls = await collection.countDocuments({ [field]: { $type: "null" } });
  const incompatible = await collection.countDocuments({
    [field]: { $exists: true, $ne: null, $not: { $type: "date" } },
  });
  return {
    diagnostics: { missing, nulls, empty: 0, incompatible },
    conflicts: incompatible
      ? [{ type: "TTL com tipo diferente de Date", count: incompatible }]
      : [],
  };
}

function applyPriority(definition) {
  if (Object.prototype.hasOwnProperty.call(
    definition.options,
    "expireAfterSeconds",
  )) return 3;
  if (definition.options.unique) return 2;
  return 1;
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
  validateAfterApply = false,
  verbose = false,
  log = console,
}) {
  const plan = [];
  const blockers = [];

  for (const definition of indexDefinitions) {
    const collection = definition.model.collection;
    const collectionName = collection.collectionName;
    if (verbose) {
      log.log(`definição: ${JSON.stringify(describeDefinition(
        collectionName,
        definition,
      ))}`);
    }
    const indexes = await collection.indexes();
    const byName = indexes.find(
      index => index.name === definition.options.name,
    );
    if (byName) {
      if (equivalentIndex(byName, definition)) {
        log.log(`${collectionName}.${definition.options.name}: existente`);
        plan.push({ definition, collection, status: "existing", index: byName });
      } else {
        const message = `${collectionName}.${definition.options.name}: o nome existe com definição divergente; decisão manual obrigatória.`;
        blockers.push(message);
        plan.push({ definition, collection, status: "divergent", index: byName });
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
      const message = `${collectionName}.${definition.options.name}: a mesma key existe com opções incompatíveis; decisão manual obrigatória.`;
      blockers.push(message);
      plan.push({ definition, collection, status: "divergent", indexes: sameKey });
      continue;
    }

    log.log(`${collectionName}.${definition.options.name}: ausente`);
    log.log(`comando: ${formatIndexCommand(collectionName, definition)}`);
    let dataConflicts = [];
    let diagnostics = null;
    if (definition.options.unique) {
      dataConflicts = await inspectUniqueData(collection, definition);
      diagnostics = dataConflicts.diagnostics;
    } else if (Object.prototype.hasOwnProperty.call(
      definition.options,
      "expireAfterSeconds",
    )) {
      const ttlInspection = await inspectTtlData(collection, definition);
      dataConflicts = ttlInspection.conflicts;
      diagnostics = ttlInspection.diagnostics;
    }
    if (diagnostics) {
      log.log(
        `${collectionName}.${definition.options.name}: ausentes=${diagnostics.missing}, null=${diagnostics.nulls}, vazios=${diagnostics.empty}, incompatíveis=${diagnostics.incompatible}, duplicidades=${diagnostics.duplicateDocuments || 0} documento(s) em ${diagnostics.duplicateGroups || 0} grupo(s)`,
      );
    }
    for (const conflict of dataConflicts) {
      blockers.push(describeConflict(
        collectionName,
        definition,
        conflict,
      ));
    }
    plan.push({ definition, collection, status: "missing", diagnostics });
  }

  if (blockers.length) {
    blockers.forEach(message => log.error(message));
    if (apply && !dryRun) {
      throw new Error(
        "Conflitos impedem a aplicação segura; nenhum índice foi criado.",
      );
    }
  }

  if (apply && !dryRun && !blockers.length) {
    const missing = plan
      .filter(entry => entry.status === "missing")
      .sort((left, right) =>
        applyPriority(left.definition) - applyPriority(right.definition));
    for (const item of missing) {
      try {
        await item.collection.createIndex(
          item.definition.key,
          item.definition.options,
        );
        log.log(
          `${item.collection.collectionName}.${item.definition.options.name}: criado`,
        );
      } catch (error) {
        throw new Error(
          `${item.collection.collectionName}.${item.definition.options.name}: falha ao criar; execução interrompida: ${error.message}`,
        );
      }
    }
    if (validateAfterApply) {
      for (const item of plan) {
        const indexes = await item.collection.indexes();
        if (!indexes.some(index => equivalentIndex(index, item.definition))) {
          throw new Error(
            `${item.collection.collectionName}.${item.definition.options.name}: validação final divergente.`,
          );
        }
      }
    }
  }
  plan.blockers = blockers;
  plan.safeToApply = blockers.length === 0;
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
  return count;
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (dryRun && apply) {
    throw new Error("Use somente um modo: --dry-run ou --apply.");
  }
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
    const identityConflicts = await inspectCrossCollectionIdentity({ apply });
    const plan = await auditDefinitions({
      dryRun,
      apply,
      validateAfterApply: apply,
      verbose: true,
    });
    const safeToApply = plan.safeToApply && identityConflicts === 0;
    console.log(`SAFE_TO_APPLY=${safeToApply ? "true" : "false"}`);
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
  describeDefinition,
  equivalentIndex,
  formatIndexCommand,
  inspectUniqueData,
  inspectTtlData,
  normalizedOptions,
  sameIndexKey,
};
