"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const models = require("../src/models/painelModels");
const {
  arquivarPedido,
} = require("../src/services/pedidoArquivamentoService");
const { registrarAuditoria } = require("../src/services/auditoriaService");
const { definitions } = require("../scripts/create-mercado-pago-indexes");

const LOJA = "64b000000000000000000001";
const OUTRA_LOJA = "64b000000000000000000002";
const PEDIDO = "64b000000000000000000003";
const USUARIO = "64b000000000000000000004";

function pedido(overrides = {}) {
  return {
    _id: PEDIDO,
    estabelecimentoId: LOJA,
    status: "novo",
    pagamentoStatus: "pendente",
    estoqueProcessamento: "nao_iniciado",
    estoqueBaixado: false,
    estoqueRestaurado: false,
    estoqueSnapshotCriado: false,
    estoqueLockId: "",
    estoqueLockExpiraEm: null,
    historicoFinanceiro: [],
    estoqueConsumos: [],
    mercadoPagoPaymentId: "",
    pagoEm: null,
    excluido: false,
    mesaId: null,
    ...overrides,
  };
}

function args(overrides = {}) {
  return {
    pedidoId: PEDIDO,
    estabelecimentoId: LOJA,
    usuario: { id: USUARIO, tipo: "proprietario" },
    motivo: "Pedido duplicado",
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

function instalarAmbiente(t, {
  inicial = pedido(),
  jobsIniciais = [],
  falharJobs = false,
  falharAuditoria = false,
  semTransacao = false,
} = {}) {
  const originais = {
    startSession: mongoose.startSession,
    pedidoFindOne: models.Pedido.findOne,
    pedidoFindOneAndUpdate: models.Pedido.findOneAndUpdate,
    jobFind: models.PrintJob.find,
    jobUpdateMany: models.PrintJob.updateMany,
    auditFindOneAndUpdate: models.AuditoriaEvento.findOneAndUpdate,
    auditFindOne: models.AuditoriaEvento.findOne,
  };
  const estado = {
    pedido: clone(inicial),
    jobs: clone(jobsIniciais),
    auditorias: new Map(),
  };
  let filaTransacao = Promise.resolve();

  mongoose.startSession = async () => ({
    async withTransaction(callback) {
      if (semTransacao) {
        throw new Error("Transaction numbers are only allowed on a replica set member");
      }
      const anterior = filaTransacao;
      let liberar;
      filaTransacao = new Promise(resolve => { liberar = resolve; });
      await anterior;
      const snapshot = {
        pedido: clone(estado.pedido),
        jobs: clone(estado.jobs),
        auditorias: new Map(estado.auditorias),
      };
      try {
        await callback();
      } catch (error) {
        estado.pedido = snapshot.pedido;
        estado.jobs = snapshot.jobs;
        estado.auditorias = snapshot.auditorias;
        throw error;
      } finally {
        liberar();
      }
    },
    async endSession() {},
  });
  models.Pedido.findOne = async filtro => {
    if (String(filtro.estabelecimentoId) !== String(estado.pedido.estabelecimentoId)) {
      return null;
    }
    if (filtro.excluido === true) return estado.pedido.excluido ? estado.pedido : null;
    if (filtro.excluido?.$ne === true) return estado.pedido.excluido ? null : estado.pedido;
    return estado.pedido;
  };
  models.Pedido.findOneAndUpdate = async (filtro, update) => {
    if (
      String(filtro.estabelecimentoId) !== String(estado.pedido.estabelecimentoId)
      || estado.pedido.excluido
    ) return null;
    Object.assign(estado.pedido, update.$set);
    return estado.pedido;
  };
  models.PrintJob.find = async filtro => estado.jobs.filter(job =>
    String(job.estabelecimentoId) === String(filtro.estabelecimentoId)
    && String(job.pedidoId) === String(filtro.pedidoId));
  models.PrintJob.updateMany = async (filtro, update) => {
    if (falharJobs) throw new Error("Falha simulada no cancelamento");
    let modifiedCount = 0;
    for (const job of estado.jobs) {
      if (!filtro.status.$in.includes(job.status)) continue;
      Object.assign(job, update.$set);
      modifiedCount += 1;
    }
    return { modifiedCount };
  };
  models.AuditoriaEvento.findOneAndUpdate = async (filtro, update) => {
    if (falharAuditoria) throw new Error("Falha simulada na auditoria");
    if (!estado.auditorias.has(filtro.operationKey)) {
      estado.auditorias.set(filtro.operationKey, clone(update.$setOnInsert));
    }
    return estado.auditorias.get(filtro.operationKey);
  };
  models.AuditoriaEvento.findOne = async filtro =>
    estado.auditorias.get(filtro.operationKey) || null;

  t.after(() => {
    mongoose.startSession = originais.startSession;
    models.Pedido.findOne = originais.pedidoFindOne;
    models.Pedido.findOneAndUpdate = originais.pedidoFindOneAndUpdate;
    models.PrintJob.find = originais.jobFind;
    models.PrintJob.updateMany = originais.jobUpdateMany;
    models.AuditoriaEvento.findOneAndUpdate = originais.auditFindOneAndUpdate;
    models.AuditoriaEvento.findOne = originais.auditFindOne;
  });
  return estado;
}

test("arquivamento transacional preserva pagamento, data e históricos", async t => {
  const pagoEm = new Date("2026-01-02T12:00:00Z");
  const historico = [{ operationKey: "pagamento:1", status: "approved" }];
  const consumos = [{ operationKey: "baixa:1", estado: "restaurado" }];
  const estado = instalarAmbiente(t, {
    inicial: pedido({
      status: "cancelado",
      pagamentoStatus: "cancelado",
      mercadoPagoPaymentId: "mp-123",
      pagoEm,
      historicoFinanceiro: historico,
      estoqueConsumos: consumos,
    }),
  });
  const result = await arquivarPedido(args());
  assert.equal(result.status, "arquivado");
  assert.equal(estado.pedido.mercadoPagoPaymentId, "mp-123");
  assert.deepEqual(estado.pedido.pagoEm, pagoEm);
  assert.deepEqual(estado.pedido.historicoFinanceiro, historico);
  assert.deepEqual(estado.pedido.estoqueConsumos, consumos);
  assert.equal(estado.auditorias.size, 1);
});

test("falha no cancelamento dos jobs aborta pedido, jobs e auditoria", async t => {
  const estado = instalarAmbiente(t, {
    jobsIniciais: [{
      _id: "job-1",
      estabelecimentoId: LOJA,
      pedidoId: PEDIDO,
      status: "pendente",
      leaseToken: "",
      lockedBy: "",
      leaseExpiresAt: null,
    }],
    falharJobs: true,
  });
  await assert.rejects(arquivarPedido(args()), /Falha simulada/);
  assert.equal(estado.pedido.excluido, false);
  assert.equal(estado.jobs[0].status, "pendente");
  assert.equal(estado.auditorias.size, 0);
});

test("falha da auditoria aborta arquivamento e cancelamento de jobs", async t => {
  const estado = instalarAmbiente(t, {
    jobsIniciais: [{
      _id: "job-1",
      estabelecimentoId: LOJA,
      pedidoId: PEDIDO,
      status: "falhou",
      leaseToken: "",
      lockedBy: "",
      leaseExpiresAt: null,
    }],
    falharAuditoria: true,
  });
  await assert.rejects(arquivarPedido(args()), /Falha simulada/);
  assert.equal(estado.pedido.excluido, false);
  assert.equal(estado.jobs[0].status, "falhou");
  assert.equal(estado.auditorias.size, 0);
});

test("restauração acontece dentro da transação e falha aborta tudo", async t => {
  const estado = instalarAmbiente(t, {
    inicial: pedido({
      estoqueBaixado: true,
      estoqueRestaurado: false,
      estoqueSnapshotCriado: true,
      estoqueProcessamento: "concluido",
      estoqueConsumos: [{ operationKey: "baixa:1", estado: "baixado" }],
    }),
  });
  let recebeuSession = false;
  const result = await arquivarPedido(args({
    restaurar: async (id, { session }) => {
      recebeuSession = Boolean(session);
      estado.pedido.estoqueBaixado = false;
      estado.pedido.estoqueRestaurado = true;
      estado.pedido.estoqueProcessamento = "restaurado";
      estado.pedido.estoqueConsumos[0].estado = "restaurado";
      return { success: true, status: "restaurado" };
    },
  }));
  assert.equal(result.status, "arquivado");
  assert.equal(recebeuSession, true);

  const falha = instalarAmbiente(t, {
    inicial: pedido({
      estoqueBaixado: true,
      estoqueSnapshotCriado: true,
      estoqueProcessamento: "concluido",
      estoqueConsumos: [{ operationKey: "baixa:2", estado: "baixado" }],
    }),
  });
  await assert.rejects(
    arquivarPedido(args({
      restaurar: async () => {
        falha.pedido.estoqueConsumos[0].estado = "restaurado";
        return { success: false, status: "reconciliacao_necessaria" };
      },
    })),
    error => error.code === "RECONCILIACAO_NECESSARIA",
  );
  assert.equal(falha.pedido.excluido, false);
  assert.equal(falha.pedido.estoqueConsumos[0].estado, "baixado");
});

test("duas solicitações simultâneas criam uma auditoria e uma retorna ja_excluido", async t => {
  const estado = instalarAmbiente(t);
  const resultados = await Promise.all([
    arquivarPedido(args()),
    arquivarPedido(args()),
  ]);
  assert.deepEqual(
    resultados.map(item => item.status).sort(),
    ["arquivado", "ja_excluido"],
  );
  assert.equal(estado.auditorias.size, 1);
});

test("ambiente sem transação falha fechado", async t => {
  const estado = instalarAmbiente(t, { semTransacao: true });
  await assert.rejects(
    arquivarPedido(args()),
    error => error.code === "TRANSACAO_INDISPONIVEL" && error.statusCode === 503,
  );
  assert.equal(estado.pedido.excluido, false);
});

test("agente online com lease ativo bloqueia arquivamento", async t => {
  for (const status of [
    "pendente",
    "entregando",
    "recebido",
    "processando",
    "enviado",
    "resultado_desconhecido",
  ]) {
    const estado = instalarAmbiente(t, {
      jobsIniciais: [{
        _id: `job-${status}`,
        estabelecimentoId: LOJA,
        pedidoId: PEDIDO,
        status,
        leaseToken: "lease",
        lockedBy: "worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }],
    });
    await assert.rejects(
      arquivarPedido(args({ agenteConectado: true })),
      error => error.code === "IMPRESSAO_EM_PROCESSAMENTO"
        && error.statusCode === 409,
    );
    assert.equal(estado.pedido.excluido, false);
  }
});

test("agente offline permite arquivar e cancela jobs presos", async t => {
  const estado = instalarAmbiente(t, {
    jobsIniciais: [
      {
        _id: "job-processando",
        estabelecimentoId: LOJA,
        pedidoId: PEDIDO,
        status: "processando",
        leaseToken: "lease",
        lockedBy: "worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
      {
        _id: "job-desconhecido",
        estabelecimentoId: LOJA,
        pedidoId: PEDIDO,
        status: "resultado_desconhecido",
        leaseToken: "lease-2",
        lockedBy: "worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    ],
  });

  const result = await arquivarPedido(args({ agenteConectado: false }));

  assert.equal(result.status, "arquivado");
  assert.equal(estado.pedido.excluido, true);
  assert.deepEqual(estado.jobs.map(job => job.status), ["cancelado", "cancelado"]);
});

test("pedido pago, reconciliação, motivo inválido e outra loja são bloqueados", async t => {
  instalarAmbiente(t, { inicial: pedido({ pagamentoStatus: "pago" }) });
  await assert.rejects(arquivarPedido(args()), error => error.code === "PAGAMENTO_ATIVO");

  instalarAmbiente(t, {
    inicial: pedido({ estoqueProcessamento: "reconciliacao_necessaria" }),
  });
  await assert.rejects(
    arquivarPedido(args()),
    error => error.code === "ESTOQUE_EM_PROCESSAMENTO",
  );

  await assert.rejects(
    arquivarPedido(args({ motivo: " " })),
    error => error.code === "MOTIVO_OBRIGATORIO",
  );

  instalarAmbiente(t, { inicial: pedido({ estabelecimentoId: OUTRA_LOJA }) });
  await assert.rejects(
    arquivarPedido(args()),
    error => error.code === "PEDIDO_NAO_ENCONTRADO",
  );
});

test("E11000 da operationKey retorna evento existente", async t => {
  const originais = {
    update: models.AuditoriaEvento.findOneAndUpdate,
    find: models.AuditoriaEvento.findOne,
  };
  const existente = { operationKey: "pedido:1" };
  models.AuditoriaEvento.findOneAndUpdate = async () => {
    const error = new Error("auditoria_operation_key_unico");
    error.code = 11000;
    error.keyPattern = { operationKey: 1 };
    throw error;
  };
  models.AuditoriaEvento.findOne = async () => existente;
  t.after(() => {
    models.AuditoriaEvento.findOneAndUpdate = originais.update;
    models.AuditoriaEvento.findOne = originais.find;
  });
  const result = await registrarAuditoria({
    estabelecimentoId: LOJA,
    entidade: "pedido",
    entidadeId: PEDIDO,
    acao: "pedido_arquivado",
    operationKey: "pedido:1",
  });
  assert.equal(result, existente);
});

test("E11000 de outro índice continua sendo erro", async t => {
  const original = models.AuditoriaEvento.findOneAndUpdate;
  models.AuditoriaEvento.findOneAndUpdate = async () => {
    const error = new Error("outro_indice");
    error.code = 11000;
    error.keyPattern = { outroCampo: 1 };
    throw error;
  };
  t.after(() => { models.AuditoriaEvento.findOneAndUpdate = original; });
  await assert.rejects(
    registrarAuditoria({
      estabelecimentoId: LOJA,
      entidade: "pedido",
      entidadeId: PEDIDO,
      acao: "pedido_arquivado",
      operationKey: "pedido:1",
    }),
    /outro_indice/,
  );
});

test("índices controlados usam campos reais", () => {
  const porNome = new Map(definitions.map(item => [item.options.name, item]));
  assert.deepEqual(
    porNome.get("pedido_estabelecimento_excluido_data").key,
    { estabelecimentoId: 1, excluido: 1, createdAt: -1 },
  );
  assert.equal(porNome.get("auditoria_operation_key_unico").options.unique, true);
  assert.deepEqual(
    porNome.get("auditoria_estabelecimento_data").key,
    { estabelecimentoId: 1, registradoEm: -1 },
  );
});
