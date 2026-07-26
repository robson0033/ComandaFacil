"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  auditDefinitions,
  definitions,
  equivalentIndex,
  inspectUniqueData,
} = require("../scripts/create-mercado-pago-indexes");

function definition({
  name = "indice_desejado",
  key = { campo: 1 },
  options = {},
  expectedType = "string",
  collection,
} = {}) {
  return {
    model: { collection },
    key,
    options: { name, ...options },
    expectedType,
  };
}

function fakeCollection({
  name = "colecao",
  indexes = [],
  missing = 0,
  nulls = 0,
  empty = 0,
  incompatible = 0,
  duplicateDocuments = 0,
  duplicateGroups = 0,
} = {}) {
  const created = [];
  return {
    collectionName: name,
    created,
    async indexes() { return indexes; },
    async countDocuments(query) {
      const serialized = JSON.stringify(query);
      if (serialized.includes('"$exists":false')) return missing;
      if (serialized.includes('"$type":"null"')) return nulls;
      if (serialized.includes('"campo":""')) return empty;
      if (serialized.includes('"$not"')) return incompatible;
      return 0;
    },
    aggregate() {
      return {
        async toArray() {
          return duplicateDocuments
            ? [{
              _id: null,
              documentos: duplicateDocuments,
              grupos: duplicateGroups || 1,
            }]
            : [];
        },
      };
    },
    async createIndex(key, options) {
      created.push({ key, options });
      return options.name;
    },
  };
}

function silentLog() {
  return { log() {}, error() {} };
}

test("índice controlado inclui hash único do token de acompanhamento", () => {
  const indice = definitions.find(item =>
    item.options.name === "pedido_acompanhamento_token_hash_unico");
  assert.ok(indice);
  assert.deepEqual(indice.key, { acompanhamentoTokenHash: 1 });
  assert.equal(indice.options.unique, true);
  assert.deepEqual(indice.options.partialFilterExpression, {
    acompanhamentoTokenHash: { $type: "string" },
  });
  assert.equal(equivalentIndex({
    name: "hash_legado_1",
    key: { acompanhamentoTokenHash: 1 },
    unique: true,
    partialFilterExpression: {
      acompanhamentoTokenHash: { $type: "string" },
    },
  }, indice), true);
});

test("índice com o mesmo nome e opções é reconhecido", async () => {
  const collection = fakeCollection({
    indexes: [{
      name: "indice_desejado",
      key: { campo: 1 },
      unique: true,
    }],
  });
  const plan = await auditDefinitions({
    indexDefinitions: [definition({
      collection,
      options: { unique: true },
    })],
    dryRun: true,
    apply: false,
    log: silentLog(),
  });
  assert.equal(plan[0].status, "existing");
});

test("índice equivalente com nome diferente é reconhecido e informado", async () => {
  const messages = [];
  const collection = fakeCollection({
    name: "paymentevents",
    indexes: [{
      name: "eventKey_1",
      key: { eventKey: 1 },
      unique: true,
    }],
  });
  const plan = await auditDefinitions({
    indexDefinitions: [definition({
      name: "payment_event_key_unico",
      key: { eventKey: 1 },
      collection,
      options: { unique: true },
    })],
    dryRun: true,
    apply: false,
    log: { log: message => messages.push(message), error() {} },
  });
  assert.equal(plan[0].status, "equivalent");
  assert.deepEqual(messages, [
    "paymentevents.payment_event_key_unico: existente como eventKey_1",
  ]);
});

test("mesma key com unique incompatível bloqueia antes de criar", async () => {
  const collection = fakeCollection({
    indexes: [{ name: "comum", key: { campo: 1 } }],
  });
  await assert.rejects(
    auditDefinitions({
      indexDefinitions: [definition({
        collection,
        options: { unique: true },
      })],
      apply: true,
      dryRun: false,
      log: silentLog(),
    }),
    /nenhum índice foi criado/,
  );
  assert.equal(collection.created.length, 0);
});

test("mesma key com partialFilterExpression incompatível bloqueia", async () => {
  const errors = [];
  const collection = fakeCollection({
    indexes: [{
      name: "antigo",
      key: { estabelecimentoId: 1 },
      unique: true,
      partialFilterExpression: { ativa: false },
    }],
  });
  await assert.rejects(auditDefinitions({
    indexDefinitions: [definition({
      key: { estabelecimentoId: 1 },
      collection,
      expectedType: "objectId",
      options: {
        unique: true,
        partialFilterExpression: { ativa: true },
      },
    })],
    apply: true,
    dryRun: false,
    log: { log() {}, error: message => errors.push(message) },
  }), /nenhum índice foi criado/);
  assert.equal(
    errors.some(message => message.includes("opções incompatíveis")),
    true,
  );
});

test("TTL equivalente com nome diferente exige expireAfterSeconds zero", () => {
  assert.equal(equivalentIndex(
    {
      name: "expiresAt_1",
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
    },
    {
      key: { expiresAt: 1 },
      options: {
        name: "oauth_state_expiracao_ttl",
        expireAfterSeconds: 0,
      },
    },
  ), true);
});

test("índice comum na mesma key não equivale ao TTL", () => {
  assert.equal(equivalentIndex(
    { name: "expiresAt_1", key: { expiresAt: 1 } },
    {
      key: { expiresAt: 1 },
      options: {
        name: "oauth_state_expiracao_ttl",
        expireAfterSeconds: 0,
      },
    },
  ), false);
});

test("documentos com valores duplicados são detectados sem expor valores", async () => {
  const conflicts = await inspectUniqueData(
    fakeCollection({ duplicateDocuments: 4, duplicateGroups: 2 }),
    definition({
      collection: null,
      options: { unique: true },
    }),
  );
  assert.deepEqual(
    conflicts.find(item => item.type === "valores duplicados"),
    { type: "valores duplicados", count: 4, groups: 2 },
  );
});

test("dois documentos sem campo são incompatíveis", async () => {
  const conflicts = await inspectUniqueData(
    fakeCollection({ missing: 2 }),
    definition({ collection: null, options: { unique: true } }),
  );
  assert.equal(conflicts.some(item => item.type === "campo ausente"), true);
});

test("dois documentos null são incompatíveis", async () => {
  const conflicts = await inspectUniqueData(
    fakeCollection({ nulls: 2 }),
    definition({ collection: null, options: { unique: true } }),
  );
  assert.equal(conflicts.some(item => item.type === "valor null"), true);
});

test("dois documentos com string vazia são incompatíveis", async () => {
  const conflicts = await inspectUniqueData(
    fakeCollection({ empty: 2 }),
    definition({ collection: null, options: { unique: true } }),
  );
  assert.equal(conflicts.some(item => item.type === "string vazia"), true);
});

test("tipo BSON incompatível é detectado", async () => {
  const conflicts = await inspectUniqueData(
    fakeCollection({ incompatible: 1 }),
    definition({ collection: null, options: { unique: true } }),
  );
  assert.deepEqual(
    conflicts.find(item => item.type === "tipo incompatível"),
    { type: "tipo incompatível", count: 1 },
  );
});

test("--dry-run nunca cria índices", async () => {
  const collection = fakeCollection();
  await auditDefinitions({
    indexDefinitions: [definition({
      collection,
      options: { unique: true },
    })],
    dryRun: true,
    apply: false,
    log: silentLog(),
  });
  assert.equal(collection.created.length, 0);
});

test("--apply ignora índice equivalente", async () => {
  const collection = fakeCollection({
    indexes: [{
      name: "nome_antigo",
      key: { campo: 1 },
      unique: true,
    }],
  });
  await auditDefinitions({
    indexDefinitions: [definition({
      collection,
      options: { unique: true },
    })],
    dryRun: false,
    apply: true,
    log: silentLog(),
  });
  assert.equal(collection.created.length, 0);
});

test("--apply cria somente índices realmente ausentes após o preflight", async () => {
  const equivalent = fakeCollection({
    name: "existente",
    indexes: [{
      name: "nome_antigo",
      key: { campo: 1 },
      unique: true,
    }],
  });
  const missing = fakeCollection({ name: "ausente" });
  await auditDefinitions({
    indexDefinitions: [
      definition({
        name: "novo_nome",
        collection: equivalent,
        options: { unique: true },
      }),
      definition({
        name: "realmente_ausente",
        key: { outroCampo: 1 },
        collection: missing,
        options: { unique: true },
      }),
    ],
    dryRun: false,
    apply: true,
    log: silentLog(),
  });
  assert.equal(equivalent.created.length, 0);
  assert.equal(missing.created.length, 1);
  assert.equal(missing.created[0].options.name, "realmente_ausente");
});
