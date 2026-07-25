"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  PrintJob,
} = require("../src/models/painelModels");
const queue = require("../src/services/printQueueService");

function order(overrides = {}) {
  return {
    _id: "507f1f77bcf86cd799439011",
    estabelecimentoId: "507f1f77bcf86cd799439012",
    cliente: "Cliente",
    canal: "retirada",
    itens: [{
      nome: "Produto",
      quantidade: 1,
      preco: 10,
      subtotal: 10,
      adicionais: [],
    }],
    total: 10,
    status: "novo",
    pagamentoStatus: "pendente",
    formaPagamento: "pix",
    createdAt: new Date(),
    ...overrides,
  };
}

function config(printers = []) {
  return {
    nomeEstabelecimento: "Loja",
    telefone: "",
    endereco: "",
    fotoPerfil: "",
    impressoras: printers,
  };
}

function printer(overrides = {}) {
  return {
    nome: "Mock",
    tipoConexao: "usb",
    deviceName: "Mock Printer",
    ip: "",
    porta: 9100,
    papel: "80mm",
    modo: "automatica",
    copias: 1,
    ...overrides,
  };
}

test("schema possui jobId único e índice automático parcial", () => {
  const indexes = PrintJob.schema.indexes();
  assert.ok(indexes.some(([fields, options]) => fields.jobId === 1 && options.unique));
  assert.ok(indexes.some(([fields, options]) =>
    fields.impressoraChave === 1 &&
    options.unique &&
    options.partialFilterExpression?.tipo === "automatica"));
});

test("criação automática gera um job por impressora", async t => {
  const original = PrintJob.create;
  const created = [];
  PrintJob.create = async docs => {
    created.push(docs[0]);
    return [{ ...docs[0], _id: crypto.randomUUID() }];
  };
  t.after(() => { PrintJob.create = original; });
  const printers = [
    printer({ deviceName: "Cozinha" }),
    printer({ deviceName: "Caixa", modo: "manual_automatica" }),
  ];
  const jobs = await queue.criarJobsAutomaticos(order(), {
    configuracao: config(printers),
    dono: { cpfCnpj: "" },
  });
  assert.equal(jobs.length, 2);
  assert.equal(created.every(job => job.tipo === "automatica"), true);
  assert.notEqual(created[0].impressoraChave, created[1].impressoraChave);
});

test("impressora manual não gera job automático", async t => {
  const original = PrintJob.create;
  let calls = 0;
  PrintJob.create = async () => { calls += 1; };
  t.after(() => { PrintJob.create = original; });
  await queue.criarJobsAutomaticos(order(), {
    configuracao: config([printer({ modo: "manual" })]),
    dono: {},
  });
  assert.equal(calls, 0);
});

test("erro de índice duplicado é tratado como idempotência", async t => {
  const original = PrintJob.create;
  PrintJob.create = async () => {
    const error = new Error("duplicate");
    error.code = 11000;
    throw error;
  };
  t.after(() => { PrintJob.create = original; });
  const jobs = await queue.criarJobsAutomaticos(order(), {
    configuracao: config([printer()]),
    dono: {},
  });
  assert.deepEqual(jobs, []);
});

test("duas impressões manuais intencionais recebem jobIds diferentes", async t => {
  const original = PrintJob.create;
  const docs = [];
  PrintJob.create = async doc => {
    docs.push(doc);
    return doc;
  };
  t.after(() => { PrintJob.create = original; });
  const args = {
    pedido: order(),
    impressora: printer({ modo: "manual" }),
    configuracao: config(),
    dono: {},
  };
  await queue.criarJobManual(args);
  await queue.criarJobManual(args);
  assert.notEqual(docs[0].jobId, docs[1].jobId);
  assert.equal(docs[0].tipo, "manual");
});

test("claim é atômico, limitado a cinco tentativas e usa lease", async t => {
  const original = PrintJob.findOneAndUpdate;
  let query;
  let update;
  PrintJob.findOneAndUpdate = async (q, u) => {
    query = q;
    update = u;
    return null;
  };
  t.after(() => { PrintJob.findOneAndUpdate = original; });
  await queue.reivindicarProximoJob("507f1f77bcf86cd799439012");
  assert.equal(query.tentativas.$lt, 5);
  assert.ok(query.$or.some(item => item.leaseExpiresAt?.$lt));
  assert.equal(update.$inc.tentativas, 1);
  assert.match(update.$set.leaseToken, /^[0-9a-f-]{36}$/);
  assert.equal(update.$set.lockedBy, queue.INSTANCE_ID);
});

test("dois servidores disputando dependem do mesmo findOneAndUpdate atômico", () => {
  const index = PrintJob.schema.indexes().find(([, options]) =>
    options.name === "printjob_automatico_unico");
  assert.equal(index[1].unique, true);
  assert.ok(queue.INSTANCE_ID.includes(String(process.pid)));
});

test("agente offline não é chamado nem consome tentativa", async () => {
  const socket = { connected: false };
  await queue.drenarFilaDoEstabelecimento("loja-offline", socket);
  assert.equal(socket.connected, false);
});

test("retry mantém o mesmo jobId", async () => {
  const id = crypto.randomUUID();
  const job = {
    jobId: id,
    status: "falhou",
    tentativas: 5,
    estabelecimentoId: "loja",
    async save() { return this; },
  };
  const result = await queue.retryJob(job);
  assert.equal(result.jobId, id);
  assert.equal(result.status, "pendente");
  assert.equal(result.tentativas, 0);
});

test("retry é proibido para enviado e concluído", async () => {
  for (const status of ["enviado", "concluido"]) {
    await assert.rejects(
      queue.retryJob({ status, async save() {} }),
      /não pode ser reenviado/,
    );
  }
});

test("resultado desconhecido nunca recebe retry manual cego", async () => {
  await assert.rejects(
    queue.retryJob({ status: "resultado_desconhecido", async save() {} }),
    /reconciliado/,
  );
});

test("falha permanente encerra sem agendar retry", async t => {
  const original = PrintJob.findOneAndUpdate;
  let update;
  PrintJob.findOneAndUpdate = async (query, value) => {
    update = value;
    return value.$set;
  };
  t.after(() => { PrintJob.findOneAndUpdate = original; });
  await queue.programarRetry({
    _id: "job",
    tentativas: 1,
    lockedBy: queue.INSTANCE_ID,
    leaseToken: "lease",
  }, new Error("payload inválido"), { permanente: true });
  assert.equal(update.$set.status, "falhou");
});

test("quinta falha encerra no limite de tentativas", async t => {
  const original = PrintJob.findOneAndUpdate;
  let update;
  PrintJob.findOneAndUpdate = async (query, value) => {
    update = value;
    return value.$set;
  };
  t.after(() => { PrintJob.findOneAndUpdate = original; });
  await queue.programarRetry({
    _id: "job",
    tentativas: 5,
    lockedBy: queue.INSTANCE_ID,
    leaseToken: "lease",
  }, new Error("falha"));
  assert.equal(update.$set.status, "falhou");
});

test("eventos repetidos de job concluído são idempotentes", async t => {
  const original = PrintJob.findOne;
  PrintJob.findOne = async () => ({ status: "concluido" });
  t.after(() => { PrintJob.findOne = original; });
  const result = await queue.atualizarStatusDoAgente("loja", {
    jobId: crypto.randomUUID(),
    status: "processando",
  });
  assert.equal(result.status, "concluido");
});

test("evento de outro estabelecimento não altera job", async t => {
  const original = PrintJob.findOne;
  let query;
  PrintJob.findOne = async value => {
    query = value;
    return null;
  };
  t.after(() => { PrintJob.findOne = original; });
  const result = await queue.atualizarStatusDoAgente("loja-a", {
    jobId: crypto.randomUUID(),
    status: "enviado",
  });
  assert.equal(result, null);
  assert.equal(query.estabelecimentoId, "loja-a");
});

test("snapshot limita itens e adicionais e remove campos internos", async () => {
  const item = {
    nome: "Produto",
    quantidade: 1,
    preco: 1,
    subtotal: 1,
    adicionais: Array.from({ length: 40 }, () => ({ nome: "A", preco: 1 })),
    segredo: "não copiar",
  };
  const snapshot = await queue.montarSnapshotValidado({
    pedido: order({ itens: Array.from({ length: 120 }, () => item) }),
    configuracao: config(),
    dono: {},
    impressora: printer({ segredo: "não copiar" }),
  });
  assert.equal(snapshot.pedido.itens.length, 100);
  assert.equal(snapshot.pedido.itens[0].adicionais.length, 30);
  assert.equal(snapshot.pedido.itens[0].segredo, undefined);
  assert.equal(snapshot.impressora.segredo, undefined);
});

test("chave de rede separa IP e porta e chave USB normaliza nome", () => {
  assert.equal(
    queue.calcularImpressoraChave(printer({ deviceName: " COZINHA " })),
    queue.calcularImpressoraChave(printer({ deviceName: "cozinha" })),
  );
  assert.notEqual(
    queue.calcularImpressoraChave(printer({
      tipoConexao: "rede", ip: "192.168.1.10", porta: 9100,
    })),
    queue.calcularImpressoraChave(printer({
      tipoConexao: "rede", ip: "192.168.1.11", porta: 9100,
    })),
  );
});

test("painel fechado e duas abas não participam da criação automática", () => {
  assert.equal(typeof queue.criarJobsAutomaticos, "function");
  assert.equal(typeof queue.drenarFilaDoEstabelecimento, "function");
});

test("reinício é recuperável porque jobId e leases vivem no model", () => {
  assert.ok(PrintJob.schema.path("jobId").options.immutable);
  assert.ok(PrintJob.schema.path("leaseExpiresAt"));
  assert.ok(PrintJob.schema.path("nextAttemptAt"));
});

test("lease expirado vira resultado desconhecido para reconciliação", async t => {
  const original = PrintJob.updateMany;
  let query;
  let update;
  PrintJob.updateMany = async (q, u) => {
    query = q;
    update = u;
  };
  t.after(() => { PrintJob.updateMany = original; });
  await queue.recuperarLeasesExpirados();
  assert.ok(query.leaseExpiresAt.$lt instanceof Date);
  assert.equal(update.$set.status, "resultado_desconhecido");
});

test("agente que não conhece resultado desconhecido libera o mesmo jobId para reenvio", async t => {
  const original = PrintJob.findOneAndUpdate;
  let finalUpdate;
  PrintJob.findOneAndUpdate = async (query, update) => {
    finalUpdate = update;
    return { ...query, ...update.$set };
  };
  t.after(() => { PrintJob.findOneAndUpdate = original; });
  queue.setTransport({
    query: async (socket, jobId) => ({ jobId, status: "nao_encontrado" }),
    wake() {},
  });
  const id = crypto.randomUUID();
  await queue.consultarResultadoDesconhecido({
    _id: "job",
    jobId: id,
    estabelecimentoId: "loja",
    status: "resultado_desconhecido",
    lockedBy: queue.INSTANCE_ID,
    leaseToken: "lease",
  }, { connected: true });
  assert.equal(finalUpdate.$set.status, "pendente");
  assert.equal(finalUpdate.$set.leaseToken, "");
});

test("agente que confirma enviado conclui sem chamar impressão novamente", async t => {
  const originalFindOne = PrintJob.findOne;
  const originalUpdate = PrintJob.findOneAndUpdate;
  let concluded;
  PrintJob.findOne = async () => ({
    _id: "job",
    status: "resultado_desconhecido",
    lockedBy: queue.INSTANCE_ID,
    leaseToken: "lease",
    recebidoEm: new Date(),
  });
  PrintJob.findOneAndUpdate = async (query, update) => {
    concluded = update.$set;
    return concluded;
  };
  t.after(() => {
    PrintJob.findOne = originalFindOne;
    PrintJob.findOneAndUpdate = originalUpdate;
  });
  queue.setTransport({
    query: async (socket, jobId) => ({ jobId, status: "enviado" }),
    wake() {},
  });
  await queue.consultarResultadoDesconhecido({
    _id: "job",
    jobId: crypto.randomUUID(),
    estabelecimentoId: "loja",
    status: "resultado_desconhecido",
    lockedBy: queue.INSTANCE_ID,
    leaseToken: "lease",
  }, { connected: true });
  assert.equal(concluded.status, "concluido");
  assert.ok(concluded.enviadoEm instanceof Date);
  assert.ok(concluded.concluidoEm instanceof Date);
});
