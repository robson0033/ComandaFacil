"use strict";

const crypto = require("crypto");
const { logger: appLogger } = require("../utils/logger");
const {
  Configuracao,
  Mesa,
  MesaPaymentAttempt,
  Pedido,
  PlatformFeeTermsAcceptance,
  PrintJob,
} = require("../models/painelModels");
const { baixarEstoqueDoPedido } = require("./estoqueService");
const printQueueService = require("./printQueueService");
const {
  ORDER_PIX_EXPIRATION_MS,
  providerPixExpirationDate,
} = require("./pedidoPixExpirationService");
const {
  buildPlatformFeeSnapshot,
  centsToDecimal,
  getCurrentPlatformFeeConfig,
} = require("./platformFeeService");
const { validatePaymentIdentity } = require("./mercadoPagoService");
const { extractMercadoPagoProviderDetails } = require("../middleware/mercadoPagoSecurity");
const { operationalAlerts } = require("./operationalAlertService");
const {
  distribuirPagamentosPorPedidos,
  montarPlanoPagamentoMesa,
} = require("./mesaPagamentoService");

const MP_API = "https://api.mercadopago.com";
const REQUEST_TIMEOUT_MS = 12_000;
const MESA_PIX_ACTIVE_STATUSES = Object.freeze([
  "creating",
  "pending",
  "in_process",
  "reconciliation_required",
]);
const MESA_PIX_TERMINAL_UNPAID = new Set([
  "cancelled",
  "canceled",
  "rejected",
  "expired",
]);

function paymentCreationMayBeUncertain(error) {
  if (!error) return true;
  if (!error.responseReceived) return true;
  const status = Number(error.status || error.httpStatus || 0);
  return Number.isFinite(status) && status >= 500;
}

function idSuffix(value) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(-8) : null;
}

function chaveCriptografia() {
  const segredo = process.env.TOKEN_ENCRYPTION_KEY;
  if (!segredo) throw new Error("TOKEN_ENCRYPTION_KEY não foi configurada.");
  return crypto.createHash("sha256").update(segredo).digest();
}

function descriptografar(valor) {
  if (!valor) return "";
  const parts = String(valor).split(".");
  if (parts.length !== 3) throw new Error("Token armazenado inválido.");
  const [iv, tag, encrypted] = parts.map(value => Buffer.from(value, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", chaveCriptografia(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

async function mp(path, options = {}, accessToken) {
  if (!accessToken) {
    const error = new Error("Credencial Mercado Pago do estabelecimento não configurada.");
    error.code = "MESA_PIX_MP_TOKEN_MISSING";
    error.httpStatus = 409;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(`${MP_API}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); } catch { data = { message: raw.slice(0, 300) }; }
    }
    if (!response.ok) {
      const provider = extractMercadoPagoProviderDetails(data);
      const error = new Error(provider.providerMessage || `Mercado Pago respondeu HTTP ${response.status}.`);
      error.name = "MercadoPagoHttpError";
      error.status = response.status;
      error.httpStatus = response.status;
      error.code = provider.providerCode || "MERCADO_PAGO_HTTP_ERROR";
      error.providerResponse = provider;
      error.responseReceived = true;
      error.endpointPath = path;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error("O Mercado Pago demorou para responder.");
      timeout.code = "MESA_PIX_MP_TIMEOUT";
      timeout.httpStatus = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function configuracaoComToken(estabelecimentoId) {
  const cfg = await Configuracao.findOne({ estabelecimentoId })
    .select("+mercadoPago.accessTokenCriptografado +mercadoPago.refreshTokenCriptografado");
  if (!cfg?.mercadoPago?.conectado || !cfg.mercadoPago.accessTokenCriptografado) {
    const error = new Error("Conecte a conta Mercado Pago do estabelecimento antes de cobrar por Pix.");
    error.code = "MESA_PIX_MP_NOT_CONNECTED";
    error.httpStatus = 409;
    throw error;
  }
  if (!String(cfg.mercadoPago.userId || "").trim()) {
    const error = new Error("Conta Mercado Pago conectada sem identificação.");
    error.code = "MESA_PIX_MP_ACCOUNT_INVALID";
    error.httpStatus = 409;
    throw error;
  }
  return { cfg, accessToken: descriptografar(cfg.mercadoPago.accessTokenCriptografado) };
}

function marketplaceWebhookUrl(req) {
  const base = String(process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const url = new URL(`${base}/webhook/mercado-pago`);
  url.searchParams.set("source_news", "webhooks");
  return url.toString();
}

function technicalPayerEmail() {
  const candidates = [
    process.env.MERCADO_PAGO_PIX_PAYER_EMAIL,
    process.env.SMTP_FROM,
    process.env.SMTP_USER,
  ];
  for (const candidate of candidates) {
    const match = String(candidate || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return match[0].toLowerCase();
  }
  const error = new Error("E-mail técnico do Pix não configurado.");
  error.code = "PIX_PAYER_EMAIL_NOT_CONFIGURED";
  error.httpStatus = 409;
  throw error;
}

function sameAccount(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  return Boolean(a && b && a === b);
}

async function buscarPagamentoPorReferencia(attempt, accessToken) {
  const query = new URLSearchParams({
    external_reference: String(attempt.externalReference || ""),
    limit: "10",
  });
  const result = await mp(`/v1/payments/search?${query.toString()}`, {}, accessToken);
  const payments = Array.isArray(result?.results) ? result.results : [];
  for (const payment of payments) {
    try {
      paymentIdentity(attempt, payment);
      return payment;
    } catch {
      // Ignora resultados que não correspondem exatamente à identidade financeira da tentativa.
    }
  }
  return null;
}

function capturarDadosPix(attempt, payment) {
  const transaction = payment?.point_of_interaction?.transaction_data || {};
  if (transaction.qr_code) attempt.pixCopiaCola = String(transaction.qr_code || "");
  if (transaction.qr_code_base64) attempt.pixQrCodeBase64 = String(transaction.qr_code_base64 || "");
}

async function garantirImpressaoPixMesa(attempt) {
  if (!attempt?.pixCopiaCola || !attempt?.ativa) return null;
  const existing = await PrintJob.findOne({
    mesaPaymentAttemptId: attempt._id,
    status: { $nin: ["cancelado"] },
  }).sort({ createdAt: -1 });
  if (existing) return existing;

  const mesa = await Mesa.findOne({
    _id: attempt.mesaId,
    estabelecimentoId: attempt.estabelecimentoId,
  });
  if (!mesa) return null;
  const pedidos = await Pedido.find({
    _id: { $in: attempt.pedidoIds },
    estabelecimentoId: attempt.estabelecimentoId,
    mesaId: attempt.mesaId,
    canal: "mesa",
    excluido: { $ne: true },
  }).sort({ createdAt: 1 });
  if (!pedidos.length) return null;
  const cfg = await Configuracao.findOne({ estabelecimentoId: attempt.estabelecimentoId });
  if (!cfg) return null;
  try {
    const job = await printQueueService.criarJobPixMesa({ attempt, mesa, pedidos, configuracao: cfg });
    attempt.printError = "";
    await attempt.save();
    return job;
  } catch (error) {
    attempt.printError = String(error?.message || "Não foi possível enviar o QR Code para impressão.").slice(0, 500);
    await attempt.save().catch(() => {});
    return null;
  }
}

async function feeSnapshotForTable(estabelecimentoId, sellerUserId, amount) {
  const config = getCurrentPlatformFeeConfig();
  if (config.enabled) {
    const platformId = String(process.env.MERCADO_PAGO_PLATFORM_USER_ID || "").trim();
    if (sameAccount(sellerUserId, platformId)) {
      const error = new Error("A conta Mercado Pago da loja deve ser diferente da conta integradora para usar a taxa de marketplace.");
      error.code = "MP_MARKETPLACE_SELLER_SAME_AS_PLATFORM";
      error.httpStatus = 409;
      throw error;
    }
    const acceptance = await PlatformFeeTermsAcceptance.findOne({
      estabelecimentoId,
      termsVersion: config.termsVersion,
      platformFeePercent: config.percentage,
      termsHash: config.termsHash,
      source: "mercado_pago_oauth",
      status: "active",
      revokedAt: null,
    }).sort({ acceptedAt: -1 });
    if (!acceptance) {
      const error = new Error("Aceite os termos dos pagamentos online antes de continuar.");
      error.code = "PLATFORM_FEE_TERMS_REQUIRED";
      error.httpStatus = 409;
      throw error;
    }
  }
  return { config, snapshot: buildPlatformFeeSnapshot(amount) };
}

function externalReference(attemptId) {
  return `mesa_payment_attempt:${attemptId}`;
}

function parseExternalReference(value) {
  const match = /^mesa_payment_attempt:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(String(value || ""));
  return match ? match[1] : "";
}

function idsIguais(left = [], right = []) {
  const a = left.map(String).sort();
  const b = right.map(String).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function pedidosPendentesDaMesa(estabelecimentoId, mesaId) {
  return Pedido.find({
    estabelecimentoId,
    mesaId,
    canal: "mesa",
    excluido: { $ne: true },
    pagamentoStatus: "pendente",
    status: { $nin: ["cancelado", "finalizado"] },
  }).sort({ createdAt: 1 });
}

function totalPedidos(pedidos) {
  return pedidos.reduce((total, pedido) => total + Math.max(0, Math.round(Number(pedido.total || 0) * 100)), 0);
}

function normalizarMetodoPlanoMesa(value) {
  const method = String(value || "").trim().toLowerCase();
  return method === "pix" ? "pix_online" : method;
}

function prepararPlanoPixMesa(body, totalCentavos) {
  const input = body && typeof body === "object" ? body : {};
  const formaPagamento = String(input.formaPagamento || "pix").trim().toLowerCase() || "pix";
  const plano = montarPlanoPagamentoMesa(
    { ...input, formaPagamento },
    totalCentavos,
  );
  const pagamentos = plano.pagamentos.map(item => ({
    formaPagamento: normalizarMetodoPlanoMesa(item.formaPagamento),
    valorCentavos: Number(item.valorCentavos),
  }));
  const pixCentavos = pagamentos.reduce(
    (total, item) => item.formaPagamento === "pix_online"
      ? total + Number(item.valorCentavos || 0)
      : total,
    0,
  );
  if (!Number.isSafeInteger(pixCentavos) || pixCentavos <= 0) {
    const error = new Error("O pagamento selecionado não possui uma parte em Pix.");
    error.code = "MESA_PIX_NOT_PLANNED";
    error.httpStatus = 422;
    throw error;
  }
  return {
    paymentMode: plano.formaPagamento === "combinado" ? "combinado" : "pix",
    pagamentos,
    pixCentavos,
    totalCentavos,
  };
}

function planoPersistidoDaTentativa(attempt) {
  const pagamentos = Array.isArray(attempt?.paymentPlan)
    ? attempt.paymentPlan.map(item => ({
      formaPagamento: normalizarMetodoPlanoMesa(item?.formaPagamento),
      valorCentavos: Number(item?.valorCentavos || 0),
    })).filter(item => item.valorCentavos > 0)
    : [];
  if (pagamentos.length) return pagamentos;
  return [{
    formaPagamento: "pix_online",
    valorCentavos: Math.max(0, Math.round(Number(attempt?.expectedAmount || 0) * 100)),
  }];
}

function totalEsperadoTentativaCentavos(attempt) {
  const explicit = Number(attempt?.expectedTableAmount);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit * 100);
  return planoPersistidoDaTentativa(attempt).reduce(
    (total, item) => total + Number(item.valorCentavos || 0),
    0,
  );
}

function planosIguais(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((item, index) =>
    normalizarMetodoPlanoMesa(item?.formaPagamento) === normalizarMetodoPlanoMesa(right[index]?.formaPagamento)
    && Number(item?.valorCentavos || 0) === Number(right[index]?.valorCentavos || 0));
}

function exigirEstoqueConcluido(resultado) {
  if (resultado?.success && ["concluido", "ja_concluido"].includes(String(resultado.status || ""))) {
    return;
  }
  const error = new Error(
    resultado?.status === "lock_ocupado"
      ? "O estoque deste pedido está sendo processado. Tente novamente."
      : "Não foi possível concluir a baixa de estoque da conta da mesa.",
  );
  error.code = resultado?.errorCode || "MESA_PIX_ESTOQUE_NAO_CONCLUIDO";
  error.httpStatus = 409;
  throw error;
}

async function mesaStatusDepoisDeCancelar(attempt) {
  const restante = await Pedido.exists({
    estabelecimentoId: attempt.estabelecimentoId,
    mesaId: attempt.mesaId,
    canal: "mesa",
    excluido: { $ne: true },
    pagamentoStatus: "pendente",
    status: { $nin: ["cancelado", "finalizado"] },
  });
  await Mesa.updateOne(
    { _id: attempt.mesaId, estabelecimentoId: attempt.estabelecimentoId },
    { $set: { status: restante ? "ocupada" : "livre" } },
  );
}

function paymentIdentity(attempt, payment) {
  validatePaymentIdentity(payment, {
    paymentId: payment.id,
    amount: Number(attempt.expectedAmount),
    externalReference: attempt.externalReference,
    collectorId: attempt.expectedCollectorId,
  });
}

function feeEvidence(payment, attempt) {
  const expected = centsToDecimal(Number(attempt.platformFeeCents || 0));
  if (!expected) return true;
  if (Number(payment?.application_fee) === expected) return true;
  return Array.isArray(payment?.fee_details) && payment.fee_details.some(detail =>
    ["application_fee", "marketplace_fee"].includes(String(detail?.type || detail?.fee_payer || ""))
      && Number(detail?.amount) === expected);
}

async function marcarConciliacao(attempt, payment, reason) {
  attempt.status = "reconciliation_required";
  attempt.ativa = true;
  attempt.reconciliationStatus = "reconciliation_required";
  attempt.reconciliationReason = String(reason || "unknown").slice(0, 200);
  attempt.lastCheckedAt = new Date();
  await attempt.save();
  operationalAlerts.trigger({
    event: "mesa_pix_reconciliation_required",
    key: `mesa_pix_reconciliation_required:${String(attempt._id)}`,
    severity: "critical",
    details: {
      estabelecimentoIdSuffix: idSuffix(attempt.estabelecimentoId),
      mesaIdSuffix: idSuffix(attempt.mesaId),
      paymentIdSuffix: idSuffix(payment?.id || attempt.paymentId),
      paymentStatus: String(payment?.status || attempt.status).slice(0, 40) || null,
      reason: String(reason || "unknown").slice(0, 120),
    },
  });
}

async function finalizarMesaAprovada(attempt, payment, { source = "status" } = {}) {
  paymentIdentity(attempt, payment);
  const remoteStatus = String(payment.status || "").toLowerCase();
  if (remoteStatus !== "approved") return { approved: false };

  if (!attempt.ativa || ["cancelled", "canceled", "expired"].includes(String(attempt.status || "").toLowerCase())) {
    await marcarConciliacao(attempt, payment, "approved_after_confirmed_cancellation");
    return { approved: true, reconciliationRequired: true, mesaLiberada: false };
  }

  const pedidos = await Pedido.find({
    _id: { $in: attempt.pedidoIds },
    estabelecimentoId: attempt.estabelecimentoId,
    mesaId: attempt.mesaId,
    canal: "mesa",
    excluido: { $ne: true },
  }).sort({ createdAt: 1 });
  const aindaPendentes = pedidos.filter(pedido =>
    String(pedido.pagamentoStatus || "") === "pendente"
    && !["cancelado", "finalizado"].includes(String(pedido.status || "")));
  const currentIds = aindaPendentes.map(pedido => String(pedido._id));
  const snapshotIds = (attempt.pedidoIds || []).map(String);
  const amountNowCentavos = totalPedidos(aindaPendentes);
  const expectedTableCentavos = totalEsperadoTentativaCentavos(attempt);
  if (!idsIguais(currentIds, snapshotIds) || amountNowCentavos !== expectedTableCentavos) {
    await marcarConciliacao(attempt, payment, "table_orders_changed_after_pix_creation");
    return { approved: true, reconciliationRequired: true, mesaLiberada: false };
  }

  let distribuicoes;
  try {
    distribuicoes = distribuirPagamentosPorPedidos(
      aindaPendentes,
      planoPersistidoDaTentativa(attempt),
    );
  } catch (error) {
    await marcarConciliacao(attempt, payment, `payment_plan_invalid:${String(error?.code || "unknown")}`);
    return { approved: true, reconciliationRequired: true, mesaLiberada: false };
  }

  // Primeiro conclui a baixa de estoque de TODOS os pedidos. Assim uma falha
  // intermediária nunca deixa apenas parte da comanda marcada como paga.
  try {
    for (const pedido of aindaPendentes) {
      exigirEstoqueConcluido(await baixarEstoqueDoPedido(pedido._id));
    }
  } catch (error) {
    await marcarConciliacao(attempt, payment, `stock_processing_failed:${String(error?.code || "unknown")}`);
    return { approved: true, reconciliationRequired: true, mesaLiberada: false };
  }

  const pagamentoCombinado = String(attempt.paymentMode || "pix") === "combinado";
  for (const distribuicao of distribuicoes) {
    const pedido = distribuicao.pedido;
    const possuiPix = distribuicao.pagamentos.some(item =>
      normalizarMetodoPlanoMesa(item?.formaPagamento) === "pix_online");
    pedido.pagamentoStatus = "pago";
    pedido.formaPagamento = distribuicao.formaPagamento;
    pedido.pagamentos = distribuicao.pagamentos;
    pedido.pagoEm = pedido.pagoEm || new Date();
    pedido.status = "finalizado";
    pedido.pagamentoInformadoEm = pedido.pagamentoInformadoEm || new Date();
    if (!Array.isArray(pedido.historicoFinanceiro)) pedido.historicoFinanceiro = [];
    const operationKey = `mesa_pix:${String(attempt.attemptId)}:${String(pedido._id)}`;
    if (!pedido.historicoFinanceiro.some(item => String(item?.operationKey || "") === operationKey)) {
      pedido.historicoFinanceiro.push({
        paymentId: possuiPix ? String(payment.id || "") : "",
        status: "pago",
        tipo: pagamentoCombinado ? "pagamento_mesa_pix_combinado" : "pagamento_mesa_pix",
        statusAnterior: "pendente",
        statusNovo: "pago",
        formaPagamento: pedido.formaPagamento,
        pagamentos: pedido.pagamentos,
        valor: Number(pedido.total || 0),
        motivo: pagamentoCombinado
          ? `Pagamento combinado da mesa confirmado após aprovação da parte Pix via ${source}.`
          : `Pagamento Pix da mesa confirmado via ${source}.`,
        operationKey,
        registradoEm: new Date(),
      });
    }
    await pedido.save();
  }

  await Mesa.updateOne(
    { _id: attempt.mesaId, estabelecimentoId: attempt.estabelecimentoId },
    { $set: { status: "livre" } },
  );
  attempt.status = "approved";
  attempt.ativa = false;
  attempt.processedAt = new Date();
  attempt.lastCheckedAt = new Date();
  attempt.reconciliationStatus = "processed";
  if (Number(attempt.platformFeeCents || 0) > 0) {
    attempt.platformFeeStatus = feeEvidence(payment, attempt) ? "applied" : "reconciliation_required";
    attempt.platformFeeNetCents = attempt.platformFeeStatus === "applied"
      ? Number(attempt.platformFeeCents || 0)
      : 0;
  }
  await attempt.save();
  return { approved: true, mesaLiberada: true };
}

async function aplicarStatusRemoto(attempt, payment, context = {}) {
  paymentIdentity(attempt, payment);
  const status = String(payment.status || "").toLowerCase();
  attempt.paymentId = String(payment.id || attempt.paymentId || "");
  capturarDadosPix(attempt, payment);
  attempt.lastCheckedAt = new Date();
  if (status === "approved") return finalizarMesaAprovada(attempt, payment, context);
  if (MESA_PIX_TERMINAL_UNPAID.has(status)) {
    attempt.status = status === "canceled" ? "cancelled" : status;
    attempt.ativa = false;
    attempt.processedAt = new Date();
    attempt.reconciliationStatus = "processed";
    await attempt.save();
    await PrintJob.updateMany(
      { mesaPaymentAttemptId: attempt._id, status: { $in: ["pendente", "aguardando_retry"] } },
      { $set: { status: "cancelado", erro: "Pagamento Pix da mesa encerrado antes da impressão." } },
    );
    await mesaStatusDepoisDeCancelar(attempt);
    return { approved: false, terminal: true, status: attempt.status };
  }
  attempt.status = ["pending", "in_process"].includes(status) ? status : "pending";
  await attempt.save();
  if (attempt.pixCopiaCola) await garantirImpressaoPixMesa(attempt);
  return { approved: false, terminal: false, status: attempt.status };
}

async function gerarPixMesa({ req, estabelecimentoId, mesaId, usuarioId, paymentBody = {} }) {
  const mesa = await Mesa.findOne({ _id: mesaId, estabelecimentoId });
  if (!mesa) {
    const error = new Error("Mesa não encontrada.");
    error.code = "MESA_NAO_ENCONTRADA";
    error.httpStatus = 404;
    throw error;
  }
  const pedidos = await pedidosPendentesDaMesa(estabelecimentoId, mesa._id);
  if (!pedidos.length) {
    const error = new Error("Esta mesa não possui pedidos pendentes para pagamento.");
    error.code = "MESA_PIX_SEM_PEDIDOS";
    error.httpStatus = 409;
    throw error;
  }
  const totalCentavos = totalPedidos(pedidos);
  if (!Number.isSafeInteger(totalCentavos) || totalCentavos <= 0) {
    const error = new Error("O total da conta da mesa é inválido.");
    error.code = "MESA_PIX_TOTAL_INVALIDO";
    error.httpStatus = 422;
    throw error;
  }
  const plano = prepararPlanoPixMesa(paymentBody, totalCentavos);
  const amount = plano.pixCentavos / 100;
  const totalConta = totalCentavos / 100;
  const pedidoIds = pedidos.map(pedido => pedido._id);
  const existing = await MesaPaymentAttempt.findOne({
    estabelecimentoId,
    mesaId: mesa._id,
    ativa: true,
  }).sort({ createdAt: -1 });
  if (existing) {
    const existingPlan = planoPersistidoDaTentativa(existing);
    if (!idsIguais(existing.pedidoIds || [], pedidoIds)
      || totalEsperadoTentativaCentavos(existing) !== totalCentavos
      || Math.round(Number(existing.expectedAmount || 0) * 100) !== plano.pixCentavos
      || !planosIguais(existingPlan, plano.pagamentos)) {
      const error = new Error("A conta ou a divisão do pagamento mudou enquanto existe um Pix ativo. Cancele ou concilie o Pix atual antes de continuar.");
      error.code = "MESA_PIX_CONTA_ALTERADA";
      error.httpStatus = 409;
      throw error;
    }
    return existing;
  }

  const { cfg, accessToken } = await configuracaoComToken(estabelecimentoId);
  const sellerUserId = String(cfg.mercadoPago.userId || "");
  const { config: feeConfig, snapshot } = await feeSnapshotForTable(estabelecimentoId, sellerUserId, amount);
  const attemptId = crypto.randomUUID();
  let attempt;
  try {
    attempt = await MesaPaymentAttempt.create({
      attemptId,
      externalReference: externalReference(attemptId),
      estabelecimentoId,
      mesaId: mesa._id,
      pedidoIds,
      expectedCollectorId: sellerUserId,
      expectedAmount: amount,
      expectedTableAmount: totalConta,
      paymentMode: plano.paymentMode,
      paymentPlan: plano.pagamentos,
      currency: "BRL",
      status: "creating",
      ativa: true,
      idempotencyKey: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + ORDER_PIX_EXPIRATION_MS),
      createdBy: usuarioId || null,
      ...snapshot,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    attempt = await MesaPaymentAttempt.findOne({ estabelecimentoId, mesaId: mesa._id, ativa: true });
    if (!attempt) throw error;
    return attempt;
  }

  mesa.status = "aguardando_pagamento";
  await mesa.save();

  try {
    const payment = await mp("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": attempt.idempotencyKey },
      body: JSON.stringify({
        transaction_amount: amount,
        ...(feeConfig.enabled && Number(attempt.platformFeeCents || 0) > 0
          ? { application_fee: centsToDecimal(attempt.platformFeeCents) }
          : {}),
        description: `${plano.paymentMode === "combinado" ? "Pix parcial" : "Conta"} Mesa ${mesa.numero} - ${String(cfg.nomeEstabelecimento || "ComandaFacil").slice(0, 80)}`,
        payment_method_id: "pix",
        external_reference: attempt.externalReference,
        notification_url: marketplaceWebhookUrl(req),
        date_of_expiration: providerPixExpirationDate().toISOString(),
        payer: { email: technicalPayerEmail(), first_name: `Mesa ${mesa.numero}` },
      }),
    }, accessToken);
    if (!payment?.id) throw new Error("O Mercado Pago retornou um pagamento Pix inválido.");
    paymentIdentity(attempt, payment);
    // Persiste o paymentId ANTES de depender do QR. Se o provedor criou o
    // pagamento mas omitiu/atrasou o QR, a tentativa continua rastreável e
    // outra forma de pagamento permanece bloqueada.
    attempt.paymentId = String(payment.id);
    attempt.status = String(payment.status || "pending");
    capturarDadosPix(attempt, payment);
    attempt.lastCheckedAt = new Date();
    await attempt.save();
    if (!attempt.pixCopiaCola) {
      attempt.printError = "O Mercado Pago criou o pagamento, mas o QR Code ainda não está disponível.";
      await attempt.save();
      const error = new Error("O Pix foi criado, mas o QR Code ainda não está disponível. Aguarde a consulta automática ou cancele o Pix com segurança.");
      error.code = "MESA_PIX_QR_MISSING";
      error.httpStatus = 502;
      error.pixActive = true;
      throw error;
    }

    try {
      await printQueueService.criarJobPixMesa({
        attempt,
        mesa,
        pedidos,
        configuracao: cfg,
      });
      attempt.printError = "";
    } catch (printError) {
      attempt.printError = String(printError?.message || "Não foi possível enviar o QR Code para impressão.").slice(0, 500);
      appLogger.warn("mesa_pix_print_job_not_created", {
        estabelecimentoIdSuffix: idSuffix(estabelecimentoId),
        mesaIdSuffix: idSuffix(mesa._id),
        paymentIdSuffix: idSuffix(payment.id),
        code: String(printError?.code || "MESA_PIX_PRINT_FAILED").slice(0, 80),
      });
    }
    await attempt.save();
    return attempt;
  } catch (error) {
    if (attempt.paymentId) {
      // Já existe pagamento remoto conhecido: nunca reabre a mesa por erro de QR/impressão.
      error.pixActive = true;
      throw error;
    }
    if (paymentCreationMayBeUncertain(error)) {
      await marcarConciliacao(attempt, null, "payment_creation_uncertain").catch(() => {});
      attempt.printError = "Não foi possível confirmar se o Mercado Pago criou o Pix. Outra forma de pagamento está bloqueada até a conciliação.";
      await attempt.save().catch(() => {});
      const uncertain = new Error("Não foi possível confirmar se o Pix foi criado. Aguarde a verificação automática; não escolha outra forma de pagamento agora.");
      uncertain.code = "MESA_PIX_CREATION_UNCERTAIN";
      uncertain.httpStatus = 409;
      uncertain.reconciliationRequired = true;
      uncertain.pixActive = true;
      throw uncertain;
    }
    attempt.status = "failed";
    attempt.ativa = false;
    attempt.processedAt = new Date();
    await attempt.save().catch(() => {});
    await mesaStatusDepoisDeCancelar(attempt).catch(() => {});
    throw error;
  }
}

async function consultarTentativa({ estabelecimentoId, mesaId, consultarRemoto = true }) {
  const attempt = await MesaPaymentAttempt.findOne({ estabelecimentoId, mesaId })
    .sort({ createdAt: -1 });
  if (!attempt) return null;

  if (consultarRemoto && attempt.ativa) {
    const stale = !attempt.lastCheckedAt || Date.now() - new Date(attempt.lastCheckedAt).getTime() >= 1500;
    if (stale) {
      try {
        const { accessToken } = await configuracaoComToken(estabelecimentoId);
        let payment = null;
        if (!attempt.paymentId) {
          payment = await buscarPagamentoPorReferencia(attempt, accessToken);
          attempt.lastCheckedAt = new Date();
          await attempt.save();
        } else {
          payment = await mp(`/v1/payments/${encodeURIComponent(attempt.paymentId)}`, {}, accessToken);
        }
        if (payment) await aplicarStatusRemoto(attempt, payment, { source: "polling" });
      } catch (error) {
        appLogger.warn("mesa_pix_status_lookup_failed", {
          estabelecimentoIdSuffix: idSuffix(estabelecimentoId),
          mesaIdSuffix: idSuffix(mesaId),
          paymentIdSuffix: idSuffix(attempt.paymentId),
          code: String(error?.code || "MESA_PIX_STATUS_FAILED").slice(0, 80),
        });
      }
    }
  }

  if (attempt.ativa && attempt.expiresAt && Date.now() >= new Date(attempt.expiresAt).getTime()) {
    await cancelarPixMesa({ estabelecimentoId, mesaId, usuarioId: null, motivo: "expiration" });
  }

  const fresh = await MesaPaymentAttempt.findById(attempt._id);
  const printJob = await PrintJob.findOne({ mesaPaymentAttemptId: attempt._id }).sort({ createdAt: -1 }).lean();
  const mesa = await Mesa.findOne({ _id: mesaId, estabelecimentoId }).select("status").lean();
  return { attempt: fresh, printJob, mesa };
}

async function cancelarPixMesa({ estabelecimentoId, mesaId, usuarioId, motivo = "manual" }) {
  const attempt = await MesaPaymentAttempt.findOne({ estabelecimentoId, mesaId, ativa: true })
    .sort({ createdAt: -1 });
  if (!attempt) {
    return { cancelled: true, alreadyClosed: true };
  }
  attempt.cancelRequestedAt = new Date();
  attempt.cancelledBy = usuarioId || null;
  await attempt.save();

  if (!attempt.paymentId) {
    if (String(attempt.reconciliationStatus || "") === "reconciliation_required"
      || String(attempt.status || "") === "reconciliation_required") {
      return { cancelled: false, reconciliationRequired: true };
    }
    attempt.status = motivo === "expiration" ? "expired" : "cancelled";
    attempt.ativa = false;
    attempt.cancelledAt = new Date();
    attempt.processedAt = new Date();
    attempt.reconciliationStatus = "processed";
    await attempt.save();
    await mesaStatusDepoisDeCancelar(attempt);
    return { cancelled: true, status: attempt.status };
  }

  const { accessToken } = await configuracaoComToken(estabelecimentoId);
  let remote;
  try {
    remote = await mp(`/v1/payments/${encodeURIComponent(attempt.paymentId)}`, {}, accessToken);
    paymentIdentity(attempt, remote);
    if (String(remote.status || "").toLowerCase() === "approved") {
      const result = await finalizarMesaAprovada(attempt, remote, { source: "cancel_precheck" });
      return { cancelled: false, approved: true, ...result };
    }
    if (MESA_PIX_TERMINAL_UNPAID.has(String(remote.status || "").toLowerCase())) {
      await aplicarStatusRemoto(attempt, remote, { source: "cancel_precheck" });
      return { cancelled: true, status: attempt.status };
    }
  } catch (error) {
    appLogger.warn("mesa_pix_cancel_precheck_failed", {
      paymentIdSuffix: idSuffix(attempt.paymentId),
      code: String(error?.code || "MESA_PIX_CANCEL_PRECHECK_FAILED").slice(0, 80),
    });
  }

  try {
    remote = await mp(`/v1/payments/${encodeURIComponent(attempt.paymentId)}`, {
      method: "PUT",
      body: JSON.stringify({ status: "cancelled" }),
    }, accessToken);
  } catch (error) {
    try {
      remote = await mp(`/v1/payments/${encodeURIComponent(attempt.paymentId)}`, {}, accessToken);
    } catch {
      remote = null;
    }
  }

  if (remote) {
    paymentIdentity(attempt, remote);
    const status = String(remote.status || "").toLowerCase();
    if (status === "approved") {
      const result = await finalizarMesaAprovada(attempt, remote, { source: "cancel_race" });
      return { cancelled: false, approved: true, ...result };
    }
    if (MESA_PIX_TERMINAL_UNPAID.has(status)) {
      await aplicarStatusRemoto(attempt, remote, { source: "cancel_confirmed" });
      attempt.cancelledAt = new Date();
      attempt.remoteCancellationStatus = status;
      await attempt.save();
      return { cancelled: true, status: attempt.status };
    }
  }

  await marcarConciliacao(attempt, remote, "cancellation_not_confirmed");
  return { cancelled: false, reconciliationRequired: true };
}

async function loadWebhookPayment(resourceId) {
  const attempt = await MesaPaymentAttempt.findOne({ paymentId: String(resourceId || "") });
  if (!attempt) return null;
  const { accessToken } = await configuracaoComToken(attempt.estabelecimentoId);
  const resource = await mp(`/v1/payments/${encodeURIComponent(resourceId)}`, {}, accessToken);
  return { kind: "mesa_payment", attempt, resource };
}

async function recoverWebhookByExternalReference(payment) {
  const attemptId = parseExternalReference(payment?.external_reference);
  if (!attemptId) return null;
  let attempt = await MesaPaymentAttempt.findOne({ attemptId });
  if (!attempt) return null;
  if (!attempt.paymentId && payment?.id) {
    attempt = await MesaPaymentAttempt.findOneAndUpdate(
      { _id: attempt._id, paymentId: "" },
      { $set: { paymentId: String(payment.id), status: String(payment.status || "pending"), lastCheckedAt: new Date() } },
      { returnDocument: "after", runValidators: true },
    ) || await MesaPaymentAttempt.findById(attempt._id);
  }
  return { kind: "mesa_payment", attempt, resource: payment };
}

async function processWebhookPayment(event, payment, attempt) {
  if (!attempt) {
    const error = new Error("Tentativa Pix da mesa não encontrada.");
    error.code = "MESA_PIX_ATTEMPT_NOT_FOUND";
    throw error;
  }
  paymentIdentity(attempt, payment);
  event.estabelecimentoId = attempt.estabelecimentoId;
  await event.save();
  return aplicarStatusRemoto(attempt, payment, { source: "webhook" });
}

function publicStatus(data) {
  if (!data?.attempt) return null;
  const attempt = data.attempt;
  const printJob = data.printJob || null;
  return {
    attemptId: String(attempt.attemptId || ""),
    paymentStatus: String(attempt.status || ""),
    ativa: Boolean(attempt.ativa),
    expiraEm: attempt.expiresAt || null,
    valor: Number(attempt.expectedAmount || 0),
    valorPix: Number(attempt.expectedAmount || 0),
    valorTotal: Number(attempt.expectedTableAmount || attempt.expectedAmount || 0),
    pagamentoCombinado: String(attempt.paymentMode || "pix") === "combinado",
    printStatus: String(printJob?.status || (attempt.printError ? "falhou" : "pendente")),
    printError: String(printJob?.erro || attempt.printError || ""),
    printJobId: String(printJob?.jobId || ""),
    reconciliationRequired: String(attempt.reconciliationStatus || "") === "reconciliation_required",
    mesaLiberada: String(data.mesa?.status || "") === "livre" && String(attempt.status || "") === "approved",
  };
}

module.exports = {
  MESA_PIX_ACTIVE_STATUSES,
  aplicarStatusRemoto,
  cancelarPixMesa,
  consultarTentativa,
  externalReference,
  finalizarMesaAprovada,
  gerarPixMesa,
  loadWebhookPayment,
  parseExternalReference,
  processWebhookPayment,
  publicStatus,
  recoverWebhookByExternalReference,
};
