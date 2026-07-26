"use strict";

const crypto = require("crypto");
const os = require("os");
const {
  Configuracao,
  Mesa,
  Pedido,
  PrintJob,
} = require("../models/painelModels");
const { registroModel } = require("../models/registroModel");
const {
  gerarTokenAcompanhamento,
} = require("./pedidoPublicoTokenService");

const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const RETRY_DELAYS = [0, 5_000, 30_000, 120_000, 600_000];
const activeStores = new Set();
let transport = null;

function setTransport(value) {
  transport = value;
}

function text(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function erroPedidoIndisponivel() {
  const error = new Error("Pedido indisponível para impressão.");
  error.code = "PEDIDO_INDISPONIVEL";
  error.statusCode = 409;
  return error;
}

async function validarPedidoDisponivel(pedido, { session = null } = {}) {
  if (!pedido?._id || !pedido?.estabelecimentoId) {
    throw erroPedidoIndisponivel();
  }
  const existente = await Pedido.findOne(
    {
      _id: pedido._id,
      estabelecimentoId: pedido.estabelecimentoId,
      excluido: { $ne: true },
    },
    null,
    session ? { session } : {},
  ).select("_id estabelecimentoId");
  if (!existente) throw erroPedidoIndisponivel();
  return existente;
}

function calcularImpressoraChave(impressora = {}) {
  const identity = impressora.tipoConexao === "rede"
    ? `rede|${text(impressora.ip, 15)}|${Number(impressora.porta || 9100)}`
    : `usb|${text(impressora.deviceName, 200).toLowerCase()}`;
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function sanitizarImpressora(impressora = {}) {
  const allowed = [
    "nome", "tipoConexao", "deviceName", "ip", "porta", "papel", "modo",
    "copias", "fontePx", "espacamentoLinhaPx", "espacamentoLetrasPx",
    "margemSuperiorMm", "margemInferiorMm", "margemEsquerdaMm",
    "margemDireitaMm", "alturaMaximaMm", "imprimirLogo", "imprimirValores",
    "imprimirEndereco", "imprimirCpfCnpj", "imprimirObservacoes",
    "corteAutomatico",
  ];
  return Object.fromEntries(allowed
    .filter(key => impressora[key] !== undefined)
    .map(key => [key, impressora[key]]));
}

async function montarSnapshotValidado({
  pedido,
  configuracao,
  dono,
  impressora,
}) {
  let mesaNumero = pedido.mesaId?.numero || null;
  if (!mesaNumero && pedido.mesaId) {
    const mesa = await Mesa.findById(pedido.mesaId).select("numero").lean();
    mesaNumero = mesa?.numero || null;
  }
  const origem = pedido.canal === "delivery"
    ? "Delivery"
    : pedido.canal === "mesa"
      ? `Mesa ${mesaNumero || ""}`.trim()
      : "Retirada";
  return {
    impressora: sanitizarImpressora(impressora),
    estabelecimento: {
      nome: text(configuracao?.nomeEstabelecimento || "ComandaFacil", 160),
      telefone: text(configuracao?.telefone, 40),
      endereco: text(configuracao?.endereco, 300),
      cpfCnpj: text(dono?.cpfCnpj, 30),
      logoUrl: text(configuracao?.fotoPerfil, 2_000),
    },
    pedido: {
      id: String(pedido._id),
      numero: String(pedido._id).slice(-6).toUpperCase(),
      origem,
      canal: text(pedido.canal || "retirada", 30),
      mesaNumero,
      cliente: text(pedido.cliente || "Cliente não informado", 160),
      telefone: text(pedido.telefoneCliente, 40),
      endereco: text(pedido.enderecoEntrega, 500),
      observacao: text(pedido.observacao, 1_000),
      total: number(pedido.total),
      status: text(pedido.status || "novo", 30),
      pagamentoStatus: text(pedido.pagamentoStatus || "pendente", 30),
      formaPagamento: text(pedido.formaPagamento || "nao_informado", 30),
      pagamentoInformadoEm: pedido.pagamentoInformadoEm
        ? new Date(pedido.pagamentoInformadoEm).toISOString()
        : "",
      pagoEm: pedido.pagoEm ? new Date(pedido.pagoEm).toISOString() : "",
      precisaTroco: Boolean(pedido.precisaTroco),
      trocoPara: pedido.trocoPara == null ? null : number(pedido.trocoPara),
      valorTroco: pedido.valorTroco == null ? null : number(pedido.valorTroco),
      createdAt: new Date(pedido.createdAt || Date.now()).toISOString(),
      itens: (pedido.itens || []).slice(0, 100).map(item => ({
        nome: text(item.nome || "Produto", 160),
        quantidade: Math.max(1, Math.min(99, Number(item.quantidade) || 1)),
        preco: number(item.preco),
        subtotal: number(item.subtotal),
        observacao: text(item.observacao, 500),
        adicionais: (item.adicionais || []).slice(0, 30).map(adicional => ({
          nome: text(adicional.nome || "Adicional", 120),
          preco: number(adicional.preco),
        })),
      })),
    },
  };
}

async function contextoDoPedido(pedido, options = {}) {
  const [configuracao, dono] = await Promise.all([
    options.configuracao || Configuracao.findOne({
      estabelecimentoId: pedido.estabelecimentoId,
    }).lean(),
    options.dono || registroModel.findById(pedido.estabelecimentoId)
      .select("cpfCnpj").lean(),
  ]);
  return { configuracao, dono };
}

async function criarJobsAutomaticos(pedido, options = {}) {
  await validarPedidoDisponivel(pedido, { session: options.session });
  const { configuracao, dono } = await contextoDoPedido(pedido, options);
  const impressoras = (configuracao?.impressoras || []).filter(item =>
    ["automatica", "manual_automatica"].includes(item.modo));
  const jobs = [];
  for (const impressora of impressoras) {
    const snapshot = await montarSnapshotValidado({
      pedido,
      configuracao,
      dono,
      impressora,
    });
    try {
      const [job] = await PrintJob.create([{
        jobId: crypto.randomUUID(),
        estabelecimentoId: pedido.estabelecimentoId,
        pedidoId: pedido._id,
        tipo: "automatica",
        impressoraChave: calcularImpressoraChave(impressora),
        ...snapshot,
        status: "pendente",
        nextAttemptAt: new Date(),
      }], options.session ? { session: options.session } : undefined);
      jobs.push(job);
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  notifyStore(pedido.estabelecimentoId);
  return jobs;
}

async function criarJobManual({
  pedido,
  impressora,
  configuracao,
  dono,
  session = null,
}) {
  await validarPedidoDisponivel(pedido, { session });
  const context = await contextoDoPedido(pedido, { configuracao, dono });
  const snapshot = await montarSnapshotValidado({
    pedido,
    configuracao: context.configuracao,
    dono: context.dono,
    impressora,
  });
  const documento = {
    jobId: crypto.randomUUID(),
    estabelecimentoId: pedido.estabelecimentoId,
    pedidoId: pedido._id,
    tipo: "manual",
    impressoraChave: calcularImpressoraChave(impressora),
    ...snapshot,
    status: "pendente",
    nextAttemptAt: new Date(),
  };
  const job = session
    ? (await PrintJob.create([documento], { session }))[0]
    : await PrintJob.create(documento);
  notifyStore(pedido.estabelecimentoId);
  return job;
}

async function criarPedidoComJobsAutomaticos(dados) {
  const tokenAcompanhamento = gerarTokenAcompanhamento();
  const dadosComToken = {
    ...dados,
    acompanhamentoTokenHash: tokenAcompanhamento.hash,
    acompanhamentoTokenCriadoEm: tokenAcompanhamento.criadoEm,
    acompanhamentoTokenExpiraEm: tokenAcompanhamento.expiraEm,
  };
  const session = await Pedido.startSession();
  try {
    let pedido;
    await session.withTransaction(async () => {
      [pedido] = await Pedido.create([dadosComToken], { session });
      await criarJobsAutomaticos(pedido, { session });
    });
    Object.defineProperty(pedido, "acompanhamentoToken", {
      value: tokenAcompanhamento.token,
      enumerable: false,
    });
    return pedido;
  } catch (error) {
    const unsupported = /Transaction numbers|replica set|transactions are not supported/i
      .test(String(error?.message || ""));
    if (!unsupported) throw error;
    console.warn("MongoDB sem transações; usando criação idempotente com reconciliador.");
    const pedido = await Pedido.create(dadosComToken);
    await criarJobsAutomaticos(pedido);
    Object.defineProperty(pedido, "acompanhamentoToken", {
      value: tokenAcompanhamento.token,
      enumerable: false,
    });
    return pedido;
  } finally {
    await session.endSession();
  }
}

async function reivindicarProximoJob(estabelecimentoId) {
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  return PrintJob.findOneAndUpdate({
    estabelecimentoId,
    status: { $in: ["pendente", "aguardando_retry"] },
    nextAttemptAt: { $lte: now },
    tentativas: { $lt: MAX_ATTEMPTS },
    $or: [
      { leaseExpiresAt: null },
      { leaseExpiresAt: { $lt: now } },
    ],
  }, {
    $set: {
      lockedBy: INSTANCE_ID,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      lastAttemptAt: now,
      status: "pendente",
    },
    $inc: { tentativas: 1 },
  }, {
    sort: { createdAt: 1 },
    returnDocument: "after",
  });
}

function leaseFilter(job) {
  return {
    _id: job._id,
    lockedBy: INSTANCE_ID,
    leaseToken: job.leaseToken,
  };
}

async function programarRetry(job, error, { permanente = false } = {}) {
  const attempts = Number(job.tentativas || 0);
  const filter = job.lockedBy === INSTANCE_ID && job.leaseToken
    ? leaseFilter(job)
    : {
        _id: job._id,
        status: {
          $in: ["recebido", "processando", "resultado_desconhecido", "falhou"],
        },
      };
  if (permanente || attempts >= MAX_ATTEMPTS) {
    return PrintJob.findOneAndUpdate(filter, {
      $set: {
        status: "falhou",
        erro: text(error?.message || error, 1000),
        lockedBy: "",
        leaseToken: "",
        leaseExpiresAt: null,
      },
    }, { returnDocument: "after" });
  }
  const base = RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length - 1)];
  const jitter = Math.floor(base * (Math.random() * 0.2));
  return PrintJob.findOneAndUpdate(filter, {
    $set: {
      status: "aguardando_retry",
      erro: text(error?.message || error, 1000),
      nextAttemptAt: new Date(Date.now() + base + jitter),
      lockedBy: "",
      leaseToken: "",
      leaseExpiresAt: null,
    },
  }, { returnDocument: "after" });
}

async function atualizarStatusDoAgente(estabelecimentoId, status = {}) {
  if (!status.jobId || !status.leaseId) return null;
  const job = await PrintJob.findOne({
    jobId: status.jobId,
    estabelecimentoId,
  });
  if (!job || ["concluido", "cancelado"].includes(job.status)) return job;
  if (
    job.lockedBy !== INSTANCE_ID
    || !job.leaseToken
    || job.leaseToken !== status.leaseId
  ) return null;
  const now = new Date();
  const update = { erro: text(status.message, 1000) };
  if (status.status === "recebido") {
    update.status = "recebido";
    if (!job.recebidoEm) update.recebidoEm = now;
  } else if (status.status === "processando") {
    update.status = "processando";
    if (!job.processandoEm) update.processandoEm = now;
    update.leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  } else if (status.status === "enviado") {
    update.status = "concluido";
    if (!job.enviadoEm) update.enviadoEm = now;
    update.concluidoEm = now;
    update.lockedBy = "";
    update.leaseToken = "";
    update.leaseExpiresAt = null;
  } else if (status.status === "falhou") {
    return programarRetry(job, status.message || "Falha informada pelo agente.");
  } else {
    return job;
  }
  return PrintJob.findOneAndUpdate(leaseFilter(job), { $set: update }, {
    returnDocument: "after",
  });
}

async function consultarResultadoDesconhecido(job, socket) {
  if (!transport || !socket) return job;
  if (job.lockedBy !== INSTANCE_ID || !job.leaseToken) {
    job = await PrintJob.findOneAndUpdate({
      _id: job._id,
      status: "resultado_desconhecido",
      $or: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { $lt: new Date() } },
        { lockedBy: "" },
      ],
    }, {
      $set: {
        lockedBy: INSTANCE_ID,
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    }, { returnDocument: "after" });
    if (!job) return null;
  }
  let result;
  try {
    result = await transport.query(socket, job.jobId, job.leaseToken);
  } catch {
    return job;
  }
  if (result?.status === "enviado") {
    return atualizarStatusDoAgente(job.estabelecimentoId, result);
  }
  if (result?.status === "processando" || result?.status === "recebido") {
    return PrintJob.findOneAndUpdate(leaseFilter(job), {
      $set: {
        status: result.status,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    }, { returnDocument: "after" });
  }
  if (result?.status === "falhou") {
    return programarRetry(job, result.message || "Falha confirmada pelo agente.");
  }
  return PrintJob.findOneAndUpdate(leaseFilter(job), {
    $set: {
      status: "pendente",
      nextAttemptAt: new Date(),
      lockedBy: "",
      leaseToken: "",
      leaseExpiresAt: null,
    },
  }, { returnDocument: "after" });
}

async function prepararEntrega(job) {
  const pedidoAtivo = await Pedido.exists({
    _id: job.pedidoId,
    estabelecimentoId: job.estabelecimentoId,
    excluido: { $ne: true },
  });
  if (!pedidoAtivo) {
    await PrintJob.findOneAndUpdate(leaseFilter(job), {
      $set: {
        status: "cancelado",
        erro: "Pedido arquivado; impressão cancelada.",
        lockedBy: "",
        leaseToken: "",
        leaseExpiresAt: null,
      },
    });
    return null;
  }
  return PrintJob.findOneAndUpdate(
    {
      ...leaseFilter(job),
      status: "pendente",
      leaseExpiresAt: { $gt: new Date() },
    },
    {
      $set: {
        status: "entregando",
        erro: "",
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    },
    { returnDocument: "after" },
  );
}

async function processarJob(job, socket) {
  const entregando = await prepararEntrega(job);
  if (!entregando) return null;
  try {
    const initial = await transport.deliver(socket, {
      jobId: entregando.jobId,
      leaseId: entregando.leaseToken,
      modo: entregando.tipo,
      estabelecimento: entregando.estabelecimento,
      pedido: entregando.pedido,
      impressoras: [entregando.impressora],
    });
    await atualizarStatusDoAgente(entregando.estabelecimentoId, {
      jobId: entregando.jobId,
      leaseId: entregando.leaseToken,
      status: initial.status || "recebido",
      ...initial,
    });
  } catch (error) {
    await PrintJob.findOneAndUpdate(leaseFilter(entregando), {
      $set: {
        status: "resultado_desconhecido",
        erro: text(error.message, 1000),
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    });
    const current = await PrintJob.findOne(leaseFilter(entregando));
    if (!current) return null;
    await consultarResultadoDesconhecido(current, socket);
  }
  return entregando;
}

async function drenarFilaDoEstabelecimento(estabelecimentoId, socket) {
  const key = String(estabelecimentoId);
  if (activeStores.has(key) || !socket?.connected || !transport) return;
  activeStores.add(key);
  try {
    const unknown = await PrintJob.find({
      estabelecimentoId,
      status: "resultado_desconhecido",
    }).sort({ createdAt: 1 }).limit(20);
    for (const job of unknown) {
      if (!socket.connected) return;
      await consultarResultadoDesconhecido(job, socket);
    }
    while (socket.connected) {
      const job = await reivindicarProximoJob(estabelecimentoId);
      if (!job) break;
      await processarJob(job, socket);
      const current = await PrintJob.findById(job._id).select("status").lean();
      if (current?.status === "recebido" || current?.status === "processando") break;
    }
  } finally {
    activeStores.delete(key);
  }
}

async function recuperarLeasesExpirados() {
  const now = new Date();
  await PrintJob.updateMany({
    status: {
      $in: ["entregando", "recebido", "processando", "resultado_desconhecido"],
    },
    leaseExpiresAt: { $lt: now },
  }, {
    $set: {
      status: "resultado_desconhecido",
      lockedBy: "",
      leaseToken: "",
    },
  });
}

async function reconciliarPedidosSemJob({ since = new Date(Date.now() - 24 * 60 * 60 * 1000) } = {}) {
  const pedidos = await Pedido.find({
    createdAt: { $gte: since },
    excluido: { $ne: true },
  }).limit(500);
  for (const pedido of pedidos) await criarJobsAutomaticos(pedido);
}

function notifyStore(estabelecimentoId) {
  if (transport) transport.wake(String(estabelecimentoId));
}

async function retryJob(job) {
  if (!["falhou", "resultado_desconhecido"].includes(job.status)) {
    throw new Error("Este trabalho não pode ser reenviado.");
  }
  if (job.status === "resultado_desconhecido") {
    throw new Error("O resultado desconhecido precisa ser reconciliado com o agente.");
  }
  const pedidoAtivo = await Pedido.exists({
    _id: job.pedidoId,
    estabelecimentoId: job.estabelecimentoId,
    excluido: { $ne: true },
  });
  if (!pedidoAtivo) {
    throw new Error("Pedido arquivado não pode ser reenviado para impressão.");
  }
  job.status = "pendente";
  job.nextAttemptAt = new Date();
  job.erro = "";
  job.lockedBy = "";
  job.leaseToken = "";
  job.leaseExpiresAt = null;
  job.tentativas = 0;
  await job.save();
  notifyStore(job.estabelecimentoId);
  return job;
}

module.exports = {
  INSTANCE_ID,
  MAX_ATTEMPTS,
  calcularImpressoraChave,
  criarJobManual,
  criarJobsAutomaticos,
  criarPedidoComJobsAutomaticos,
  drenarFilaDoEstabelecimento,
  montarSnapshotValidado,
  prepararEntrega,
  processarJob,
  programarRetry,
  recuperarLeasesExpirados,
  reconciliarPedidosSemJob,
  reivindicarProximoJob,
  retryJob,
  setTransport,
  validarPedidoDisponivel,
  atualizarStatusDoAgente,
  consultarResultadoDesconhecido,
};
