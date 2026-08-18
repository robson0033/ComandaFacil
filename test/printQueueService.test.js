"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  Pedido,
  PrintJob,
} = require("../src/models/painelModels");
const queue = require("../src/services/printQueueService");
const { PROTOCOL_VERSION } = require("../src/services/printAgentProtocol");

function agentStatus(overrides = {}) {
  return {
    jobId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    protocolVersion: PROTOCOL_VERSION,
    agentVersion: "1.2.0",
    status: "concluido",
    timestamp: new Date().toISOString(),
    impressoraId: "usb:mock",
    ...overrides,
  };
}

let originalPedidoFindOne;
let originalPedidoUpdateOne;
test.beforeEach(() => {
  originalPedidoFindOne = Pedido.findOne;
  originalPedidoUpdateOne = Pedido.updateOne;
  Pedido.findOne = filtro => ({
    async select() {
      return filtro.excluido?.$ne === true
        ? { _id: filtro._id, estabelecimentoId: filtro.estabelecimentoId }
        : null;
    },
  });
  // criarJobsAutomaticos() persiste no Pedido o marcador de que o evento
  // automático já foi processado. Este é um teste unitário do serviço; não
  // deve depender de uma conexão MongoDB real apenas para gravar esse marcador.
  Pedido.updateOne = async () => ({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
  });
});
test.afterEach(() => {
  Pedido.findOne = originalPedidoFindOne;
  Pedido.updateOne = originalPedidoUpdateOne;
});

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


test("payload enviado ao agente remove metadados internos da comanda", () => {
  const original = {
    id: "507f1f77bcf86cd799439011",
    numero: "COMANDA",
    origem: "Mesa 1",
    canal: "mesa",
    mesaNumero: 1,
    cliente: "Mesa 1 - 2 pedido(s)",
    itens: [{ nome: "Xburger", quantidade: 1, preco: 18, subtotal: 18, adicionais: [] }],
    total: 28,
    documentoTipo: "comanda_mesa",
    comandaMesaId: "507f1f77bcf86cd799439013",
    comandaChave: "a".repeat(64),
    comandaQuantidadePedidos: 2,
    comandaPedidoIds: ["pedido-1", "pedido-2"],
  };

  const enviado = queue.sanitizarPedidoParaAgente(original);
  assert.equal(enviado.numero, "COMANDA");
  assert.equal(enviado.canal, "mesa");
  assert.equal(enviado.total, 28);
  assert.equal(enviado.documentoTipo, undefined);
  assert.equal(enviado.comandaMesaId, undefined);
  assert.equal(enviado.comandaChave, undefined);
  assert.equal(enviado.comandaQuantidadePedidos, undefined);
  assert.equal(enviado.comandaPedidoIds, undefined);

  // O snapshot persistido precisa continuar intacto para deduplicação/reimpressão.
  assert.equal(original.documentoTipo, "comanda_mesa");
  assert.equal(original.comandaPedidoIds.length, 2);
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
  const jobs = await queue.criarJobsAutomaticos(order({
    pagamentoStatus: "pago",
    mercadoPagoStatus: "approved",
  }), {
    configuracao: config(printers),
    dono: { cpfCnpj: "" },
  });
  assert.equal(jobs.length, 2);
  assert.equal(created.every(job => job.tipo === "automatica"), true);
  assert.notEqual(created[0].impressoraChave, created[1].impressoraChave);
});

test("roteamento de impressora respeita Delivery, Mesa, Retirada, combinação e Todas", () => {
  const todas = printer({ origemPedidos: "todas" });
  const delivery = printer({ origemPedidos: "delivery" });
  const mesa = printer({ origemPedidos: "mesa" });
  const retirada = printer({ origemPedidos: "retirada" });
  const deliveryRetirada = printer({ origemPedidos: "delivery_retirada" });
  const legado = printer({ origemPedidos: undefined });

  assert.equal(queue.impressoraAceitaPedido(todas, order({ canal: "delivery" })), true);
  assert.equal(queue.impressoraAceitaPedido(todas, order({ canal: "mesa" })), true);
  assert.equal(queue.impressoraAceitaPedido(todas, order({ canal: "retirada" })), true);
  assert.equal(queue.impressoraAceitaPedido(delivery, order({ canal: "delivery" })), true);
  assert.equal(queue.impressoraAceitaPedido(delivery, order({ canal: "mesa" })), false);
  assert.equal(queue.impressoraAceitaPedido(delivery, order({ canal: "retirada" })), false);
  assert.equal(queue.impressoraAceitaPedido(mesa, order({ canal: "mesa" })), true);
  assert.equal(queue.impressoraAceitaPedido(mesa, order({ canal: "delivery" })), false);
  assert.equal(queue.impressoraAceitaPedido(mesa, order({ canal: "retirada" })), false);
  assert.equal(queue.impressoraAceitaPedido(retirada, order({ canal: "retirada" })), true);
  assert.equal(queue.impressoraAceitaPedido(retirada, order({ canal: "balcao" })), true);
  assert.equal(queue.impressoraAceitaPedido(retirada, order({ canal: "delivery" })), false);
  assert.equal(queue.impressoraAceitaPedido(retirada, order({ canal: "mesa" })), false);
  assert.equal(queue.impressoraAceitaPedido(deliveryRetirada, order({ canal: "delivery" })), true);
  assert.equal(queue.impressoraAceitaPedido(deliveryRetirada, order({ canal: "retirada" })), true);
  assert.equal(queue.impressoraAceitaPedido(deliveryRetirada, order({ canal: "balcao" })), true);
  assert.equal(queue.impressoraAceitaPedido(deliveryRetirada, order({ canal: "mesa" })), false);
  assert.equal(queue.impressoraAceitaPedido(legado, order({ canal: "retirada" })), true);
});

test("criação automática envia apenas às impressoras compatíveis com a origem", async t => {
  const original = PrintJob.create;
  const created = [];
  PrintJob.create = async docs => {
    created.push(docs[0]);
    return [{ ...docs[0], _id: crypto.randomUUID() }];
  };
  t.after(() => { PrintJob.create = original; });

  const printers = [
    printer({ deviceName: "Delivery", origemPedidos: "delivery" }),
    printer({ deviceName: "Mesas", origemPedidos: "mesa" }),
    printer({ deviceName: "Geral", origemPedidos: "todas" }),
  ];

  const jobs = await queue.criarJobsAutomaticos(order({
    canal: "delivery",
    formaPagamento: "dinheiro",
  }), {
    configuracao: config(printers),
    dono: {},
  });

  assert.equal(jobs.length, 2);
  assert.deepEqual(
    created.map(job => job.impressora.deviceName).sort(),
    ["Delivery", "Geral"],
  );
});

test("retirada automática vai para Retirada, Delivery + Retirada e Todas", async t => {
  const original = PrintJob.create;
  const created = [];
  PrintJob.create = async docs => {
    created.push(docs[0]);
    return [{ ...docs[0], _id: crypto.randomUUID() }];
  };
  t.after(() => { PrintJob.create = original; });

  const printers = [
    printer({ deviceName: "Delivery", origemPedidos: "delivery" }),
    printer({ deviceName: "Mesas", origemPedidos: "mesa" }),
    printer({ deviceName: "Retirada", origemPedidos: "retirada" }),
    printer({ deviceName: "DeliveryRetirada", origemPedidos: "delivery_retirada" }),
    printer({ deviceName: "Geral", origemPedidos: "todas" }),
  ];

  const jobs = await queue.criarJobsAutomaticos(order({
    canal: "retirada",
    formaPagamento: "dinheiro",
  }), {
    configuracao: config(printers),
    dono: {},
  });

  assert.equal(jobs.length, 3);
  assert.deepEqual(
    created.map(job => job.impressora.deviceName).sort(),
    ["DeliveryRetirada", "Geral", "Retirada"],
  );
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
  const jobs = await queue.criarJobsAutomaticos(order({
    pagamentoStatus: "pago",
    mercadoPagoStatus: "approved",
  }), {
    configuracao: config([printer()]),
    dono: {},
  });
  assert.deepEqual(jobs, []);
});

test("Pix pendente ou não aprovado nunca cria job automático", async t => {
  const original = PrintJob.create;
  let calls = 0;
  PrintJob.create = async () => { calls += 1; };
  t.after(() => { PrintJob.create = original; });
  const options = { configuracao: config([printer()]), dono: {} };
  for (const mercadoPagoStatus of [
    "pending", "in_process", "rejected", "expired", "cancelled", "refunded",
  ]) {
    await queue.criarJobsAutomaticos(order({ mercadoPagoStatus }), options);
  }
  assert.equal(calls, 0);
});

test("Pix aprovado cria snapshot pago com motivo financeiro", async t => {
  const original = PrintJob.create;
  let created;
  PrintJob.create = async docs => {
    [created] = docs;
    return [created];
  };
  t.after(() => { PrintJob.create = original; });
  await queue.criarJobsAutomaticos(order({
    pagamentoStatus: "pago",
    mercadoPagoStatus: "approved",
    formaPagamento: "pix_online",
    mercadoPagoPaymentId: "123456789",
    pagoEm: new Date(),
  }), { configuracao: config([printer()]), dono: {} });
  assert.equal(created.motivo, "payment_approved");
  assert.equal(created.paymentIdSuffix, "23456789");
  assert.equal(created.pedido.pagamentoStatus, "pago");
  assert.equal(created.pedido.formaPagamento, "pix_online");
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
  assert.ok(query.$and.some(group =>
    group.$or?.some(item => item.leaseExpiresAt?.$lt)));
  assert.ok(query.$and.some(group =>
    group.$or?.some(item => Object.prototype.hasOwnProperty.call(item, "nextAttemptAt"))));
  assert.equal(update.$inc.tentativas, 1);
  assert.match(update.$set.leaseToken, /^[0-9a-f-]{36}$/);
  assert.equal(update.$set.lockedBy, queue.INSTANCE_ID);
});


test("job legado sem nextAttemptAt continua reivindicável", async t => {
  const original = PrintJob.findOneAndUpdate;
  let query;
  PrintJob.findOneAndUpdate = async q => {
    query = q;
    return null;
  };
  t.after(() => { PrintJob.findOneAndUpdate = original; });

  await queue.reivindicarProximoJob("507f1f77bcf86cd799439012");
  const nextAttemptGroup = query.$and.find(group =>
    group.$or?.some(item => Object.prototype.hasOwnProperty.call(item, "nextAttemptAt")));
  assert.ok(nextAttemptGroup);
  assert.ok(nextAttemptGroup.$or.some(item => item.nextAttemptAt === null));
});

test("job esgotado deixa de ficar pendente para sempre", async t => {
  const original = PrintJob.updateMany;
  let query;
  let update;
  PrintJob.updateMany = async (q, u) => {
    query = q;
    update = u;
    return { modifiedCount: 1 };
  };
  t.after(() => { PrintJob.updateMany = original; });

  await queue.finalizarJobsEsgotados({ now: new Date("2026-08-11T18:45:56.796Z") });
  assert.equal(query.tentativas.$gte, queue.MAX_ATTEMPTS);
  assert.equal(update.$set.status, "falhou");
  assert.match(update.$set.erro, /Limite de tentativas/);
  assert.equal(update.$set.leaseToken, "");
});

test("reconciliação reconhece impressora atual por tipo, chave e origem", () => {
  const delivery = printer({
    deviceName: "Cozinha",
    modo: "automatica",
    origemPedidos: "delivery",
  });
  const chave = queue.calcularImpressoraChave(delivery);
  assert.equal(queue.impressoraPodeAtenderJob(delivery, {
    tipo: "automatica",
    impressoraChave: chave,
    pedido: { canal: "delivery" },
  }), true);
  assert.equal(queue.impressoraPodeAtenderJob(delivery, {
    tipo: "automatica",
    impressoraChave: chave,
    pedido: { canal: "mesa" },
  }), false);
  assert.equal(queue.impressoraPodeAtenderJob({ ...delivery, modo: "desativada" }, {
    tipo: "automatica",
    impressoraChave: chave,
    pedido: { canal: "delivery" },
  }), false);
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

test("retry mantém o mesmo jobId", async t => {
  const originalExists = Pedido.exists;
  Pedido.exists = async () => ({ _id: "pedido-ativo" });
  t.after(() => { Pedido.exists = originalExists; });
  const id = crypto.randomUUID();
  const job = {
    jobId: id,
    pedidoId: "507f1f77bcf86cd799439011",
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

test("pedido arquivado não pode receber retry de impressão", async t => {
  const originalExists = Pedido.exists;
  Pedido.exists = async () => null;
  t.after(() => { Pedido.exists = originalExists; });
  await assert.rejects(
    queue.retryJob({
      status: "falhou",
      pedidoId: "507f1f77bcf86cd799439011",
      estabelecimentoId: "507f1f77bcf86cd799439012",
      async save() {},
    }),
    /arquivado não pode ser reenviado/,
  );
});

test("pedido arquivado não cria PrintJob mesmo com objeto sem excluido", async t => {
  Pedido.findOne = () => ({ async select() { return null; } });
  let criou = false;
  const originalCreate = PrintJob.create;
  PrintJob.create = async () => { criou = true; };
  t.after(() => { PrintJob.create = originalCreate; });
  await assert.rejects(
    queue.criarJobsAutomaticos(order(), {
      configuracao: config([printer()]),
      dono: {},
    }),
    error => error.code === "PEDIDO_INDISPONIVEL",
  );
  assert.equal(criou, false);
});

test("job vira entregando com o mesmo lease antes de transport.deliver", async t => {
  const originalExists = Pedido.exists;
  const originalUpdate = PrintJob.findOneAndUpdate;
  const originalFind = PrintJob.findOne;
  Pedido.exists = async () => ({ _id: "pedido" });
  const job = {
    _id: "job",
    jobId: crypto.randomUUID(),
    pedidoId: "507f1f77bcf86cd799439011",
    estabelecimentoId: "507f1f77bcf86cd799439012",
    tipo: "automatica",
    impressora: printer(),
    estabelecimento: {},
    pedido: {},
    status: "pendente",
    lockedBy: queue.INSTANCE_ID,
    leaseToken: crypto.randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
  let primeiraAtualizacao;
  PrintJob.findOneAndUpdate = async (filtro, update) => {
    primeiraAtualizacao ||= { filtro, update };
    return { ...job, ...update.$set };
  };
  PrintJob.findOne = async () => ({ ...job, status: "entregando" });
  const entregas = [];
  queue.setTransport({
    async deliver(socket, payload) {
      entregas.push(payload);
      return {
        jobId: payload.jobId,
        leaseId: payload.leaseId,
        status: "recebido",
      };
    },
  });
  t.after(() => {
    Pedido.exists = originalExists;
    PrintJob.findOneAndUpdate = originalUpdate;
    PrintJob.findOne = originalFind;
    queue.setTransport(null);
  });
  await queue.processarJob(job, { connected: true });
  assert.equal(primeiraAtualizacao.update.$set.status, "entregando");
  assert.equal(primeiraAtualizacao.filtro.leaseToken, job.leaseToken);
  assert.equal(entregas.length, 1);
  assert.equal(entregas[0].leaseId, job.leaseToken);
});

test("arquivamento concorrente antes de deliver impede a entrega", async t => {
  const originalExists = Pedido.exists;
  const originalUpdate = PrintJob.findOneAndUpdate;
  Pedido.exists = async () => ({ _id: "pedido" });
  PrintJob.findOneAndUpdate = async () => null;
  let entregou = false;
  queue.setTransport({
    async deliver() {
      entregou = true;
      return {};
    },
  });
  t.after(() => {
    Pedido.exists = originalExists;
    PrintJob.findOneAndUpdate = originalUpdate;
    queue.setTransport(null);
  });
  await queue.processarJob({
    _id: "job",
    jobId: crypto.randomUUID(),
    pedidoId: "507f1f77bcf86cd799439011",
    estabelecimentoId: "507f1f77bcf86cd799439012",
    status: "pendente",
    lockedBy: queue.INSTANCE_ID,
    leaseToken: crypto.randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
  }, { connected: true });
  assert.equal(entregou, false);
});

test("worker antigo não conclui job de lease novo", async t => {
  const originalFind = PrintJob.findOne;
  const originalUpdate = PrintJob.findOneAndUpdate;
  let atualizou = false;
  const newLease = crypto.randomUUID();
  PrintJob.findOne = async () => ({
    status: "entregando",
    lockedBy: queue.INSTANCE_ID,
    leaseToken: newLease,
    impressoraChave: "usb:mock",
  });
  PrintJob.findOneAndUpdate = async () => {
    atualizou = true;
  };
  t.after(() => {
    PrintJob.findOne = originalFind;
    PrintJob.findOneAndUpdate = originalUpdate;
  });
  const result = await queue.atualizarStatusDoAgente("loja", agentStatus({
    leaseId: crypto.randomUUID(),
  }));
  assert.equal(result, null);
  assert.equal(atualizou, false);
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
  const result = await queue.atualizarStatusDoAgente("loja", agentStatus({
    status: "imprimindo",
  }));
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
  const result = await queue.atualizarStatusDoAgente("loja-a", agentStatus());
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
  assert.ok(query.status.$in.includes("enviado"));
  assert.equal(update.$set.status, "resultado_desconhecido");
});

test("agente que confirma não ter recebido libera retry seguro sem reenvio cego", async t => {
  const original = PrintJob.findOneAndUpdate;
  let finalUpdate;
  PrintJob.findOneAndUpdate = async (query, update) => {
    finalUpdate = update;
    return { ...query, ...update.$set };
  };
  t.after(() => { PrintJob.findOneAndUpdate = original; });
  queue.setTransport({
    query: async (socket, jobId, leaseId) => ({
      jobId,
      leaseId,
      status: "nao_encontrado",
    }),
    wake() {},
  });
  const id = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  await queue.consultarResultadoDesconhecido({
    _id: "job",
    jobId: id,
    estabelecimentoId: "loja",
    status: "resultado_desconhecido",
    lockedBy: queue.INSTANCE_ID,
    leaseToken: leaseId,
    ultimoLeaseId: leaseId,
  }, { connected: true });
  assert.equal(finalUpdate.$set.status, "aguardando_retry");
  assert.match(finalUpdate.$set.erro, /não recebeu/);
});

test("agente que confirma enviado conclui sem chamar impressão novamente", async t => {
  const originalFindOne = PrintJob.findOne;
  const originalUpdate = PrintJob.findOneAndUpdate;
  let concluded;
  const leaseId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  PrintJob.findOne = async () => ({
    _id: "job",
    status: "resultado_desconhecido",
    lockedBy: queue.INSTANCE_ID,
    leaseToken: leaseId,
    impressoraChave: "usb:mock",
    impressora: { tipoConexao: "usb", deviceName: "mock" },
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
    query: async (socket, jobId, leaseId) => ({
      jobId,
      leaseId,
      protocolVersion: PROTOCOL_VERSION,
      agentVersion: "1.2.0",
      status: "concluido",
      timestamp: new Date().toISOString(),
      impressoraId: "usb:mock",
    }),
    wake() {},
  });
  await queue.consultarResultadoDesconhecido({
    _id: "job",
    jobId,
    estabelecimentoId: "loja",
    status: "resultado_desconhecido",
    lockedBy: queue.INSTANCE_ID,
    leaseToken: leaseId,
    impressoraChave: "usb:mock",
  }, { connected: true });
  assert.equal(concluded.status, "concluido");
  assert.ok(concluded.enviadoEm instanceof Date);
  assert.ok(concluded.concluidoEm instanceof Date);
});

test("resultado desconhecido é preservado e falha confirmada pelo agente não recebe retry automático", async t => {
  const originalFindOne = PrintJob.findOne;
  const originalUpdate = PrintJob.findOneAndUpdate;
  const leaseId = crypto.randomUUID();
  let update;
  PrintJob.findOne = async () => ({
    _id: "job",
    status: "processando",
    lockedBy: queue.INSTANCE_ID,
    leaseToken: leaseId,
    impressoraChave: "usb:mock",
    impressora: { tipoConexao: "usb", deviceName: "mock" },
    tentativas: 1,
  });
  PrintJob.findOneAndUpdate = async (filter, value) => {
    update = value.$set;
    return update;
  };
  t.after(() => {
    PrintJob.findOne = originalFindOne;
    PrintJob.findOneAndUpdate = originalUpdate;
  });
  await queue.atualizarStatusDoAgente("loja", agentStatus({
    leaseId,
    status: "resultado_desconhecido",
  }));
  assert.equal(update.status, "resultado_desconhecido");

  await queue.atualizarStatusDoAgente("loja", agentStatus({
    leaseId,
    status: "falhou_antes_envio",
  }));
  assert.equal(update.status, "falhou");
  assert.equal(update.nextAttemptAt, null);
  assert.equal(update.lockedBy, "");
  assert.equal(update.leaseToken, "");
  assert.equal(update.leaseExpiresAt, null);
  assert.match(update.erro, /Retry automático bloqueado/i);
});

test("reconciliação é isolada pela loja e idempotente", async t => {
  const originalFindOne = PrintJob.findOne;
  const originalUpdate = PrintJob.findOneAndUpdate;
  const leaseId = crypto.randomUUID();
  let query;
  let updates = 0;
  PrintJob.findOne = async value => {
    query = value;
    return {
      _id: "job",
      jobId: value.jobId,
      estabelecimentoId: value.estabelecimentoId,
      status: "resultado_desconhecido",
      leaseToken: leaseId,
      impressoraChave: "usb:mock",
      impressora: { tipoConexao: "usb", deviceName: "mock" },
    };
  };
  PrintJob.findOneAndUpdate = async () => {
    updates += 1;
    return {};
  };
  t.after(() => {
    PrintJob.findOne = originalFindOne;
    PrintJob.findOneAndUpdate = originalUpdate;
  });
  const summary = {
    protocolVersion: PROTOCOL_VERSION,
    jobs: [{
      jobId: crypto.randomUUID(),
      leaseId,
      status: "resultado_desconhecido",
      impressoraId: "usb:mock",
    }],
  };
  const first = await queue.reconciliarResumoDoAgente("loja-a", summary);
  const second = await queue.reconciliarResumoDoAgente("loja-a", summary);
  assert.equal(query.estabelecimentoId, "loja-a");
  assert.equal(first[0].action, "manter_desconhecido");
  assert.deepEqual(second, first);
  assert.equal(updates, 0);
});

test("conciliação manual mantém jobId e exige estado desconhecido", async t => {
  const original = PrintJob.findOneAndUpdate;
  let filter;
  let update;
  PrintJob.findOneAndUpdate = async (value, change) => {
    filter = value;
    update = change.$set;
    return { jobId: "job", ...update };
  };
  t.after(() => { PrintJob.findOneAndUpdate = original; });
  const job = {
    _id: "id",
    jobId: "job",
    estabelecimentoId: "loja",
    status: "resultado_desconhecido",
  };
  await queue.reconciliarJobManual(job, "confirmar_concluido");
  assert.equal(filter.estabelecimentoId, "loja");
  assert.equal(filter.status, "resultado_desconhecido");
  assert.equal(update.status, "concluido");
  await assert.rejects(
    queue.reconciliarJobManual({ ...job, status: "falhou" }, "liberar_retry"),
    /Somente resultado desconhecido/,
  );
});
