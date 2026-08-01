"use strict";

const crypto = require("crypto");
const { normalizePrinterLayoutConfig } = require("./printerLayoutConfig");
const {
  AGENT_STATUSES,
  PROTOCOL_VERSION,
  UUID_PATTERN,
  buildJobEnvelope,
  validateAgentStatus,
} = require("./printAgentProtocol");
const {
  isPrintProtocolV2EnabledFor,
} = require("../config/printProtocolRollout");
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
const {
  codigoFinal,
  gerarCodigoPublico,
} = require("./pedidoPublicCodeService");

const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const RETRY_DELAYS = [0, 5_000, 30_000, 120_000, 600_000];
const activeStores = new Set();
let transport = null;
let shuttingDown = false;

function setTransport(value) {
  transport = value;
}

function assertAcceptingWork() {
  if (!shuttingDown) return;
  const error = new Error("Serviço temporariamente indisponível.");
  error.code = "SHUTTING_DOWN";
  error.statusCode = 503;
  throw error;
}

function setShuttingDown(value) {
  shuttingDown = Boolean(value);
}

function text(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isPixOnlineOrder(pedido = {}) {
  return ["pix", "pix_online"].includes(
    String(pedido.formaPagamento || "").toLowerCase(),
  );
}

function isOrderEligibleForAutomaticPrint(pedido = {}) {
  if (!pedido || pedido.status === "cancelado" || pedido.excluido === true) {
    return false;
  }
  if (isPixOnlineOrder(pedido)) {
    return pedido.pagamentoStatus === "pago"
      && pedido.mercadoPagoStatus === "approved";
  }
  return true;
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

function calcularImpressoraId(impressora = {}) {
  return impressora.tipoConexao === "rede"
    ? `rede:${text(impressora.ip, 15)}:${Number(impressora.porta || 9100)}`
    : `usb:${text(impressora.deviceName, 200).toLowerCase()}`;
}

function calcularImpressoraChave(impressora = {}) {
  // Mantém a chave hash apenas para idempotência/índice no MongoDB.
  // O protocolo do agente NÃO aceita essa hash: ele exige o identificador
  // canônico usb:<deviceName> ou rede:<ip>:<porta>.
  return crypto.createHash("sha256")
    .update(calcularImpressoraId(impressora))
    .digest("hex");
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
  const sanitized = Object.fromEntries(allowed
    .filter(key => impressora[key] !== undefined)
    .map(key => [key, impressora[key]]));
  return normalizePrinterLayoutConfig(sanitized);
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
      numero: text(pedido.codigoPublico, 8),
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
  assertAcceptingWork();
  await validarPedidoDisponivel(pedido, { session: options.session });
  if (!isOrderEligibleForAutomaticPrint(pedido)) return [];
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
        motivo: isPixOnlineOrder(pedido) ? "payment_approved" : "order_created",
        paymentIdSuffix: isPixOnlineOrder(pedido)
          ? String(pedido.mercadoPagoPaymentId || "").slice(-8)
          : "",
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
  assertAcceptingWork();
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
    motivo: "manual",
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

async function criarPedidoComJobsAutomaticos(dados, tentativaCodigo = 0) {
  assertAcceptingWork();
  const tokenAcompanhamento = gerarTokenAcompanhamento();
  const codigoPublico = gerarCodigoPublico();
  const dadosComToken = {
    ...dados,
    codigoPublico,
    codigoPublicoFinal: codigoFinal(codigoPublico),
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
    const colisaoCodigo = Number(error?.code) === 11000
      && (error?.keyPattern?.codigoPublico
        || String(error?.message || "").includes("pedido_codigo_publico_tenant_unico"));
    if (colisaoCodigo && tentativaCodigo < 5) {
      return criarPedidoComJobsAutomaticos(dados, tentativaCodigo + 1);
    }
    const unsupported = /Transaction numbers|replica set|transactions are not supported/i
      .test(String(error?.message || ""));
    if (!unsupported) throw error;
    console.warn("MongoDB sem transações; usando criação idempotente com reconciliador.");
    let pedido;
    try {
      pedido = await Pedido.create(dadosComToken);
    } catch (fallbackError) {
      const colisaoFallback = Number(fallbackError?.code) === 11000
        && (fallbackError?.keyPattern?.codigoPublico
          || String(fallbackError?.message || "").includes("pedido_codigo_publico_tenant_unico"));
      if (colisaoFallback && tentativaCodigo < 5) {
        return criarPedidoComJobsAutomaticos(dados, tentativaCodigo + 1);
      }
      throw fallbackError;
    }
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
  if (shuttingDown) return null;
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
      ultimoLeaseId: leaseToken,
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
  let validated;
  try {
    validated = validateAgentStatus(status);
  } catch {
    return null;
  }
  const job = await PrintJob.findOne({
    jobId: validated.jobId,
    estabelecimentoId,
  });
  if (!job || ["concluido", "cancelado"].includes(job.status)) return job;
  if (
    job.lockedBy !== INSTANCE_ID
    || !job.leaseToken
    || job.leaseToken !== validated.leaseId
    || calcularImpressoraId(job.impressora) !== validated.impressoraId
  ) {
    console.warn(
      `ACK de impressão ignorado: jobId=${validated.jobId} lease=${validated.leaseId.slice(0, 8)} code=LEASE_OR_PRINTER_MISMATCH`,
    );
    return null;
  }
  const now = new Date();
  const update = { erro: text(validated.message, 1000) };
  if (["recebido", "validado", "aceito"].includes(validated.status)) {
    update.status = "recebido";
    if (!job.recebidoEm) update.recebidoEm = now;
  } else if (validated.status === "imprimindo") {
    update.status = "processando";
    if (!job.processandoEm) update.processandoEm = now;
    update.leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  } else if (validated.status === "enviado_impressora") {
    update.status = "enviado";
    if (!job.enviadoEm) update.enviadoEm = now;
    update.leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  } else if (validated.status === "concluido") {
    update.status = "concluido";
    if (!job.enviadoEm) update.enviadoEm = now;
    update.concluidoEm = now;
    update.lockedBy = "";
    update.leaseToken = "";
    update.leaseExpiresAt = null;
  } else if (validated.status === "falhou_antes_envio") {
    return programarRetry(job, validated.message || "Falha segura antes do envio.");
  } else if (validated.status === "resultado_desconhecido") {
    update.status = "resultado_desconhecido";
    update.leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  } else {
    return job;
  }
  return PrintJob.findOneAndUpdate(leaseFilter(job), { $set: update }, {
    returnDocument: "after",
  });
}

async function consultarResultadoDesconhecido(job, socket) {
  if (!transport || !socket) return job;
  const deliveryLeaseId = String(job.ultimoLeaseId || job.leaseToken || "");
  if (!UUID_PATTERN.test(deliveryLeaseId)) return job;
  let result;
  try {
    result = await transport.query(socket, job.jobId, deliveryLeaseId);
  } catch {
    return job;
  }
  if (result?.status === "nao_encontrado") {
    const safeJob = await PrintJob.findOneAndUpdate({
      _id: job._id,
      status: "resultado_desconhecido",
      ultimoLeaseId: deliveryLeaseId,
    }, {
      $set: {
        status: "aguardando_retry",
        erro: "O agente confirmou que não recebeu o trabalho.",
        nextAttemptAt: new Date(),
        lockedBy: "",
        leaseToken: "",
        leaseExpiresAt: null,
      },
    }, { returnDocument: "after" });
    if (safeJob) notifyStore(safeJob.estabelecimentoId);
    return safeJob || job;
  }
  try {
    result = validateAgentStatus(result);
    if (result.jobId !== job.jobId || result.leaseId !== deliveryLeaseId) {
      result = null;
    }
  } catch {
    result = null;
  }
  if (result?.status === "concluido") {
    return PrintJob.findOneAndUpdate({
      _id: job._id,
      status: { $nin: ["concluido", "cancelado"] },
      ultimoLeaseId: deliveryLeaseId,
    }, {
      $set: {
        status: "concluido",
        erro: "",
        enviadoEm: job.enviadoEm || new Date(),
        concluidoEm: new Date(),
        lockedBy: "",
        leaseToken: "",
        leaseExpiresAt: null,
      },
    }, { returnDocument: "after" });
  }
  if (["imprimindo", "recebido", "validado", "aceito", "enviado_impressora"]
    .includes(result?.status)) {
    const serverStatus = result.status === "imprimindo"
      ? "processando"
      : (result.status === "enviado_impressora" ? "enviado" : "recebido");
    return PrintJob.findOneAndUpdate({
      _id: job._id,
      status: { $nin: ["concluido", "cancelado"] },
      ultimoLeaseId: deliveryLeaseId,
    }, {
      $set: {
        status: serverStatus,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    }, { returnDocument: "after" });
  }
  if (result?.status === "falhou_antes_envio") {
    const retryable = await PrintJob.findOneAndUpdate({
      _id: job._id,
      status: { $nin: ["concluido", "cancelado"] },
      ultimoLeaseId: deliveryLeaseId,
    }, {
      $set: {
        status: "falhou",
        erro: text(result.message || "Falha confirmada pelo agente.", 1000),
        lockedBy: "",
        leaseToken: "",
        leaseExpiresAt: null,
      },
    }, { returnDocument: "after" });
    return retryable
      ? programarRetry(retryable, retryable.erro)
      : job;
  }
  // Ausência local, protocolo antigo ou resultado ambíguo nunca liberam retry.
  return PrintJob.findOneAndUpdate({
    _id: job._id,
    status: { $nin: ["concluido", "cancelado"] },
    ultimoLeaseId: deliveryLeaseId,
  }, {
    $set: {
      status: "resultado_desconhecido",
      erro: "Resultado exige conciliação manual.",
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
    },
  }, { returnDocument: "after" });
}

async function reconciliarResumoDoAgente(estabelecimentoId, summary = {}) {
  if (
    Number(summary.protocolVersion) !== PROTOCOL_VERSION
    || !Array.isArray(summary.jobs)
    || summary.jobs.length > 100
  ) {
    throw new Error("Resumo de reconciliação inválido.");
  }
  const decisions = [];
  for (const local of summary.jobs) {
    if (
      !UUID_PATTERN.test(String(local?.jobId || ""))
      || !UUID_PATTERN.test(String(local?.leaseId || ""))
      || !AGENT_STATUSES.has(String(local?.status || ""))
    ) continue;
    const job = await PrintJob.findOne({
      jobId: String(local.jobId),
      estabelecimentoId,
    });
    if (!job || job.status === "cancelado") {
      decisions.push({
        jobId: String(local.jobId),
        leaseId: String(local.leaseId),
        action: "cancelar",
      });
      continue;
    }
    if (calcularImpressoraId(job.impressora) !== String(local.impressoraId || "")) {
      decisions.push({
        jobId: job.jobId,
        leaseId: String(local.leaseId),
        action: "aguardar",
      });
      continue;
    }
    if (job.status === "concluido") {
      decisions.push({
        jobId: job.jobId,
        leaseId: String(local.leaseId),
        action: "concluido",
      });
      continue;
    }
    if (
      local.status === "falhou_antes_envio"
      && String(job.leaseToken) === String(local.leaseId)
    ) {
      await PrintJob.findOneAndUpdate({
        _id: job._id,
        estabelecimentoId,
        leaseToken: String(local.leaseId),
        status: {
          $in: ["entregando", "recebido", "processando", "resultado_desconhecido"],
        },
      }, {
        $set: {
          status: "aguardando_retry",
          erro: "Falha antes do envio confirmada pelo agente.",
          nextAttemptAt: new Date(),
          lockedBy: "",
          leaseToken: "",
          leaseExpiresAt: null,
        },
      });
      decisions.push({
        jobId: job.jobId,
        leaseId: String(local.leaseId),
        action: "liberar_para_retry",
      });
      continue;
    }
    decisions.push({
      jobId: job.jobId,
      leaseId: String(local.leaseId),
      action: local.status === "resultado_desconhecido"
        ? "manter_desconhecido"
        : "aguardar",
    });
  }
  return decisions;
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
  if (!isPrintProtocolV2EnabledFor(job.estabelecimentoId)) return null;
  const entregando = await prepararEntrega(job);
  if (!entregando) return null;
  try {
    const initial = await transport.deliver(socket, buildJobEnvelope({
      jobId: entregando.jobId,
      leaseId: entregando.leaseToken,
      impressoraId: calcularImpressoraId(entregando.impressora),
      attempt: entregando.tentativas,
      deadline: new Date(Date.now() + LEASE_MS).toISOString(),
      modo: entregando.tipo,
      estabelecimento: entregando.estabelecimento,
      pedido: entregando.pedido,
      impressoras: [entregando.impressora],
    }));
    await atualizarStatusDoAgente(entregando.estabelecimentoId, {
      jobId: entregando.jobId,
      leaseId: entregando.leaseToken,
      protocolVersion: PROTOCOL_VERSION,
      agentVersion: initial.agentVersion,
      impressoraId: calcularImpressoraId(entregando.impressora),
      timestamp: initial.timestamp || new Date().toISOString(),
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
  if (shuttingDown) return;
  if (!isPrintProtocolV2EnabledFor(estabelecimentoId)) return;
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
  if (shuttingDown) return;
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
  if (shuttingDown) return;
  const pedidos = await Pedido.find({
    createdAt: { $gte: since },
    excluido: { $ne: true },
  }).limit(500);
  for (const pedido of pedidos) await criarJobsAutomaticos(pedido);
}

function notifyStore(estabelecimentoId) {
  if (!shuttingDown && transport) transport.wake(String(estabelecimentoId));
}

async function retryJob(job) {
  assertAcceptingWork();
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

async function reconciliarJobManual(job, action) {
  assertAcceptingWork();
  if (job.status !== "resultado_desconhecido") {
    throw new Error("Somente resultado desconhecido pode ser conciliado.");
  }
  if (!["confirmar_concluido", "liberar_retry"].includes(action)) {
    throw new Error("Ação de conciliação inválida.");
  }
  const now = new Date();
  const update = action === "confirmar_concluido"
    ? {
        status: "concluido",
        erro: "Concluído por conciliação manual.",
        enviadoEm: job.enviadoEm || now,
        concluidoEm: now,
        lockedBy: "",
        leaseToken: "",
        leaseExpiresAt: null,
      }
    : {
        status: "aguardando_retry",
        erro: "Retry liberado por conciliação manual.",
        nextAttemptAt: now,
        lockedBy: "",
        leaseToken: "",
        leaseExpiresAt: null,
      };
  const result = await PrintJob.findOneAndUpdate({
    _id: job._id,
    estabelecimentoId: job.estabelecimentoId,
    status: "resultado_desconhecido",
  }, { $set: update }, { returnDocument: "after" });
  if (!result) throw new Error("O estado do trabalho mudou. Atualize e tente novamente.");
  if (action === "liberar_retry") notifyStore(job.estabelecimentoId);
  return result;
}

module.exports = {
  INSTANCE_ID,
  MAX_ATTEMPTS,
  calcularImpressoraChave,
  calcularImpressoraId,
  criarJobManual,
  criarJobsAutomaticos,
  criarPedidoComJobsAutomaticos,
  isOrderEligibleForAutomaticPrint,
  isPixOnlineOrder,
  drenarFilaDoEstabelecimento,
  montarSnapshotValidado,
  prepararEntrega,
  processarJob,
  programarRetry,
  recuperarLeasesExpirados,
  reconciliarPedidosSemJob,
  reivindicarProximoJob,
  retryJob,
  reconciliarJobManual,
  setShuttingDown,
  setTransport,
  validarPedidoDisponivel,
  atualizarStatusDoAgente,
  consultarResultadoDesconhecido,
  reconciliarResumoDoAgente,
  sanitizarImpressora,
};
