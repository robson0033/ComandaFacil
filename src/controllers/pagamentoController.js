"use strict";

const { logger: appLogger } = require("../utils/logger");

const crypto = require("crypto");
const validator = require("validator");
const {
  BLOCKING_ATTEMPT_STATUSES,
  CANCELLABLE_ATTEMPT_STATUSES,
  SUBSCRIPTION_ATTEMPT_STATUS,
} = require("../constants/subscriptionAttempt");
const {
  Assinatura,
  AssinaturaTentativa,
  Configuracao,
  OAuthState,
  PaymentEvent,
  Pedido,
  OrderPaymentAttempt,
  PlatformFeeTermsAcceptance,
} = require("../models/painelModels");
const {
  consultarAcessoVenda,
  respostaLojaIndisponivel,
} = require("../services/assinaturaAcessoService");
const {
  buscarPedidoPorToken,
  extrairBearerToken,
} = require("../services/pedidoPublicoTokenService");
const { baixarEstoqueDoPedido, restaurarEstoqueDoPedido } = require("../services/estoqueService");
const printQueueService = require("../services/printQueueService");
const {
  pedidoTemPixOnline,
  valorPixOnlinePedidoCentavos,
} = require("../services/mesaPagamentoService");
const { operationalAlerts } = require("../services/operationalAlertService");
const {
  ORDER_PIX_EXPIRATION_MINUTES,
  ORDER_PIX_EXPIRATION_MS,
  ORDER_PIX_ACTIVE_STATUSES,
  ORDER_PIX_TERMINAL_UNPAID_STATUSES,
  effectiveAttemptExpiration,
  providerPixExpirationDate,
  orderPixExpirationDate,
  orderPixExpiredByClock,
  orderPixApprovedAfterExpiration,
  isRemoteTerminalUnpaidStatus,
  markOrderPixExpirationPending,
  markOrderPixExpired,
  markMissingOrderAttemptPending,
  findExpiredActiveAttempts,
  findOrderForAttempt,
} = require("../services/pedidoPixExpirationService");
const { registroModel } = require("../models/registroModel");
const {
  buildPlatformFeeSnapshot,
  centsToDecimal,
  getCurrentPlatformFeeConfig,
} = require("../services/platformFeeService");
const {
  paidPeriod,
  subscriptionStatusForFinancialStatus,
  validateApprovedPayment,
  validatePaymentIdentity,
} = require("../services/mercadoPagoService");
const {
  extractMercadoPagoProviderDetails,
  sanitizeMercadoPagoError,
  validateMercadoPagoWebhook,
} = require("../middleware/mercadoPagoSecurity");
const {
  assertPlatformPaymentConfig,
  platformErrorLog,
  requestPlatform,
  validatePlatformAccount,
  validatePlatformPaymentConfig,
} = require("../services/mercadoPagoPlatformService");
const {
  safeFlash,
  saveSessionOrRun,
} = require("../utils/safeFlash");

const MP_API = "https://api.mercadopago.com";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SUBSCRIPTION_PIX_EXPIRATION_MINUTES = 2;
const PIX_ATTEMPT_TTL_MS = SUBSCRIPTION_PIX_EXPIRATION_MINUTES * 60 * 1000;
const CARD_ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const valorPlano = () => {
  const value = Number(process.env.PLANO_MENSAL || 39.9);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Valor do plano inválido.");
  return value;
};
const estabelecimentoId = req =>
  req.session.user.estabelecimentoId || req.session.user.id;
const baseUrl = req =>
  String(process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const mercadoPagoWebhookUrl = req => {
  const url = new URL(`${baseUrl(req)}/webhook/mercado-pago`);
  // Força o Mercado Pago a entregar esta notification_url no formato Webhooks
  // (com assinatura secreta validável), evitando notificações IPN legadas.
  url.searchParams.set("source_news", "webhooks");
  return url.toString();
};
const getPixTechnicalPayerEmail = () => {
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
  throw error;
};
const platformCollectorId = () => {
  const value = String(process.env.MERCADO_PAGO_PLATFORM_USER_ID || "").trim();
  if (!value) throw new Error("Conta principal da plataforma não configurada.");
  return value;
};
const idSuffix = value => {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(-8) : null;
};
const sameMercadoPagoAccount = (left, right) => {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  return Boolean(a && b && a === b);
};
function assertMarketplaceSellerAccount(sellerUserId) {
  const platformUserId = String(process.env.MERCADO_PAGO_PLATFORM_USER_ID || "").trim();
  if (!sameMercadoPagoAccount(sellerUserId, platformUserId)) return;
  const error = new Error(
    "A conta Mercado Pago da loja deve ser diferente da conta integradora do Comanda Fácil para usar a taxa de marketplace.",
  );
  error.code = "MP_MARKETPLACE_SELLER_SAME_AS_PLATFORM";
  error.httpStatus = 409;
  throw error;
}
const subscriptionReference = assinatura =>
  `assinatura:${assinatura._id}:estabelecimento:${assinatura.estabelecimentoId}`;
const attemptReference = attempt =>
  `assinatura-tentativa:${attempt.attemptId}:estabelecimento:${attempt.estabelecimentoId}`;

async function currentPlatformFeeAcceptance(storeId) {
  const config = getCurrentPlatformFeeConfig();
  return PlatformFeeTermsAcceptance.findOne({
    estabelecimentoId: storeId,
    termsVersion: config.termsVersion,
    platformFeePercent: config.percentage,
    termsHash: config.termsHash,
    source: "mercado_pago_oauth",
    status: "active",
    revokedAt: null,
  }).sort({ acceptedAt: -1 });
}

async function requirePlatformFeeAcceptance(storeId) {
  const acceptance = await currentPlatformFeeAcceptance(storeId);
  if (acceptance) return acceptance;
  const error = new Error("Aceite os termos dos pagamentos online antes de continuar.");
  error.code = "PLATFORM_FEE_TERMS_REQUIRED";
  error.httpStatus = 409;
  throw error;
}

function hasOfficialPlatformFeeEvidence(payment, attempt) {
  const expected = centsToDecimal(Number(attempt?.platformFeeCents || 0));
  if (!expected) return false;
  if (Number(payment?.application_fee) === expected) return true;
  return Array.isArray(payment?.fee_details) && payment.fee_details.some(detail =>
    ["application_fee", "marketplace_fee"].includes(String(detail?.type || detail?.fee_payer || ""))
      && Number(detail?.amount) === expected);
}

function mercadoPagoConfigStatus(scope = "all") {
  if (scope === "subscription") return validatePlatformPaymentConfig();
  const groups = {
    oauth: [
      "MP_CLIENT_ID",
      "MP_CLIENT_SECRET",
      "MP_REDIRECT_URI",
      "TOKEN_ENCRYPTION_KEY",
      "APP_URL",
    ],
    subscription: [
      "MERCADO_PAGO_ACCESS_TOKEN",
      "MERCADO_PAGO_PLATFORM_USER_ID",
      "MERCADO_PAGO_WEBHOOK_SECRET",
      "APP_URL",
    ],
  };

  const required = scope === "oauth"
    ? groups.oauth
    : scope === "subscription"
      ? groups.subscription
      : [...new Set([...groups.oauth, ...groups.subscription])];
  const missing = required.filter(name => !String(process.env[name] || "").trim());

  if (required.includes("APP_URL") && !missing.includes("APP_URL")) {
    try {
      const app = new URL(String(process.env.APP_URL || "").trim());
      if (app.protocol !== "https:" || app.username || app.password || app.pathname !== "/") {
        missing.push("APP_URL");
      }
    } catch {
      missing.push("APP_URL");
    }
  }

  if (scope !== "subscription" && !missing.includes("MP_REDIRECT_URI")) {
    try {
      const redirect = new URL(String(process.env.MP_REDIRECT_URI || "").trim());
      const app = new URL(String(process.env.APP_URL || "").trim());
      const redirectValid = redirect.protocol === "https:"
        && redirect.origin === app.origin
        && redirect.pathname === "/admin/mercado-pago/callback"
        && !redirect.search
        && !redirect.hash;
      if (!redirectValid) missing.push("MP_REDIRECT_URI");
    } catch {
      missing.push("MP_REDIRECT_URI");
    }
  }

  return { ok: missing.length === 0, missing: [...new Set(missing)] };
}

function assertMercadoPagoConfig(scope = "all") {
  if (scope === "subscription") return assertPlatformPaymentConfig();
  const status = mercadoPagoConfigStatus(scope);
  if (status.missing.length) {
    const error = new Error("Integração Mercado Pago incompleta.");
    error.code = "MERCADO_PAGO_CONFIG_INCOMPLETA";
    error.missing = status.missing;
    throw error;
  }
}

function wantsJson(req) {
  return String(req.get?.("accept") || "").toLowerCase().includes("application/json")
    || String(req.get?.("x-requested-with") || "").toLowerCase() === "xmlhttprequest";
}

function safeMercadoPagoFailure(error) {
  const safeSpecific = [
    "PLATFORM_ACCOUNT_MISMATCH",
    "PLATFORM_MP_TIMEOUT",
    "SUBSCRIPTION_PIX_QR_MISSING",
    "SUBSCRIPTION_PIX_RESPONSE_INVALID",
    "SUBSCRIPTION_CHECKOUT_URL_MISSING",
    "SUBSCRIPTION_CHECKOUT_URL_INVALID",
    "SUBSCRIPTION_PAYER_EMAIL_INVALID",
    "ASSINATURA_ATIVA",
    "TENTATIVA_METODO_DIFERENTE",
    "PLATFORM_FEE_TERMS_REQUIRED",
  ].includes(error?.code) || String(error?.code || "").endsWith("_MISSING");
  return {
    ok: false,
    code: String(error?.code || "PLATFORM_MP_INTEGRATION_FAILED").slice(0, 80),
    message: error?.providerResponse?.providerMessage
      ? String(error.providerResponse.providerMessage)
      : safeSpecific || error?.code === "APP_URL_INVALID"
        ? String(error?.message || "Configuração de pagamento inválida.")
        : "Não foi possível concluir a operação com o Mercado Pago.",
    correlationId: String(error?.correlationId || ""),
  };
}

async function validarContaPrincipalMercadoPago() {
  return validatePlatformAccount();
}

function validarRedirectMercadoPago(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error("URL de pagamento insegura.");
  const host = url.hostname.toLowerCase();
  const permitido = host === "mercadopago.com"
    || host.endsWith(".mercadopago.com")
    || host === "mercadopago.com.br"
    || host.endsWith(".mercadopago.com.br")
    || host === "mercadopago.com.ar"
    || host.endsWith(".mercadopago.com.ar");
  if (!permitido) throw new Error("URL de pagamento não pertence ao Mercado Pago.");
  return url.toString();
}

function validarEmailPagador(dono) {
  const email = String(dono?.email || "").trim().toLowerCase();
  if (!validator.isEmail(email)) {
    const error = new Error("Cadastre um e-mail válido antes de iniciar o pagamento.");
    error.code = "SUBSCRIPTION_PAYER_EMAIL_INVALID";
    error.stage = "payer_validation";
    throw error;
  }
  return email;
}

function buildPixPaymentPayload({
  amount,
  payerEmail,
  externalReference,
  notificationUrl,
  now = Date.now(),
}) {
  const expiresAt = new Date(
    Number(now) + SUBSCRIPTION_PIX_EXPIRATION_MINUTES * 60 * 1000,
  );
  return {
    transaction_amount: Number(amount),
    payment_method_id: "pix",
    description: "Plano mensal ComandaFácil",
    external_reference: String(externalReference),
    notification_url: String(notificationUrl),
    date_of_expiration: expiresAt.toISOString(),
    payer: { email: String(payerEmail) },
  };
}

function buildPreapprovalPayload({ amount, payerEmail, externalReference, backUrl }) {
  return {
    reason: "Plano Profissional ComandaFácil",
    external_reference: String(externalReference),
    payer_email: String(payerEmail),
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: Number(amount),
      currency_id: "BRL",
    },
    back_url: String(backUrl),
    status: "pending",
  };
}

function validIsoDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function parseSubscriptionPixResponse(data, fallbackExpiresAt) {
  if (!data?.id || !String(data.status || "").trim()) {
    const error = new Error("O Mercado Pago retornou uma resposta de Pix inválida.");
    error.code = "SUBSCRIPTION_PIX_RESPONSE_INVALID";
    error.stage = "pix_response_validation";
    error.endpointPath = "/v1/payments";
    throw error;
  }
  const transactionData = data.point_of_interaction?.transaction_data;
  if (!transactionData?.qr_code || !transactionData?.qr_code_base64) {
    const error = new Error("O Mercado Pago não retornou o QR Code do Pix.");
    error.code = "SUBSCRIPTION_PIX_QR_MISSING";
    error.stage = "pix_response_validation";
    error.endpointPath = "/v1/payments";
    throw error;
  }
  const expiresAt = [
    data.date_of_expiration,
    data.expiration_date,
    fallbackExpiresAt,
  ].map(validIsoDate).find(Boolean);
  if (!expiresAt) {
    const error = new Error("O Mercado Pago não informou quando o Pix expira.");
    error.code = "SUBSCRIPTION_PIX_EXPIRATION_MISSING";
    error.stage = "pix_response_validation";
    error.endpointPath = "/v1/payments";
    throw error;
  }
  return {
    paymentId: String(data.id),
    status: String(data.status),
    qrCode: String(transactionData.qr_code),
    qrCodeBase64: String(transactionData.qr_code_base64),
    ticketUrl: String(transactionData.ticket_url || ""),
    expiresAt,
  };
}

function planoPagoVigente(assinatura, now = new Date()) {
  return Boolean(
    assinatura?.status === "ativa"
    && assinatura.ultimoPagamentoAprovadoId
    && assinatura.planoExpira
    && new Date(assinatura.planoExpira) > now
  );
}

async function obterOuCriarTentativa(assinatura, metodo) {
  if (planoPagoVigente(assinatura)) {
    const error = new Error("A assinatura já está ativa.");
    error.code = "ASSINATURA_ATIVA";
    throw error;
  }
  const now = new Date();
  await AssinaturaTentativa.updateMany(
    {
      estabelecimentoId: assinatura.estabelecimentoId,
      ativa: true,
      expiresAt: { $lte: now },
    },
    {
      $set: {
        ativa: false,
        status: "expired",
        supersededAt: now,
        expiredAt: now,
      },
    },
  );
  await AssinaturaTentativa.updateMany(
    {
      estabelecimentoId: assinatura.estabelecimentoId,
      ativa: true,
      status: { $nin: BLOCKING_ATTEMPT_STATUSES },
    },
    { $set: { ativa: false, completedAt: now } },
  );
  const existing = await AssinaturaTentativa.findOne({
    estabelecimentoId: assinatura.estabelecimentoId,
    ativa: true,
    status: { $in: BLOCKING_ATTEMPT_STATUSES },
    expiresAt: { $gt: now },
  });
  if (existing) {
    if (existing.status === SUBSCRIPTION_ATTEMPT_STATUS.RECONCILIATION_REQUIRED) {
      const error = new Error("A tentativa exige reconciliação antes de uma nova cobrança.");
      error.code = "SUBSCRIPTION_ATTEMPT_REQUIRES_RECONCILIATION";
      throw error;
    }
    if (existing.metodo !== metodo) {
      const error = new Error(
        `Já existe uma tentativa ativa por ${existing.metodo}. Aguarde a expiração ou cancele-a antes de trocar o método.`,
      );
      error.code = "TENTATIVA_METODO_DIFERENTE";
      throw error;
    }
    return { attempt: existing, created: false };
  }

  const attemptId = crypto.randomUUID();
  try {
    const attempt = await AssinaturaTentativa.create({
      attemptId,
      assinaturaId: assinatura._id,
      estabelecimentoId: assinatura.estabelecimentoId,
      metodo,
      status: SUBSCRIPTION_ATTEMPT_STATUS.PROCESSING,
      ativa: true,
      idempotencyKey: crypto.randomUUID(),
      valorCentavos: Math.round(valorPlano() * 100),
      moeda: "BRL",
      expiresAt: new Date(
        Date.now() + (metodo === "pix" ? PIX_ATTEMPT_TTL_MS : CARD_ATTEMPT_TTL_MS),
      ),
    });
    return { attempt, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const attempt = await AssinaturaTentativa.findOne({
      estabelecimentoId: assinatura.estabelecimentoId,
      ativa: true,
    });
    if (!attempt) throw error;
    if (attempt.metodo !== metodo) {
      const conflict = new Error(
        `Já existe uma tentativa ativa por ${attempt.metodo}. Aguarde a expiração ou cancele-a antes de trocar o método.`,
      );
      conflict.code = "TENTATIVA_METODO_DIFERENTE";
      throw conflict;
    }
    return { attempt, created: false };
  }
}

async function expirarTentativasVencidas(estabId, now = new Date()) {
  await AssinaturaTentativa.updateMany({
    estabelecimentoId: estabId,
    ativa: true,
    expiresAt: { $lte: now },
  }, {
    $set: {
      ativa: false,
      status: SUBSCRIPTION_ATTEMPT_STATUS.EXPIRED,
      completedAt: now,
      expiredAt: now,
    },
  });
}

async function tentativaAtivaDoEstabelecimento(estabId) {
  await expirarTentativasVencidas(estabId);
  return AssinaturaTentativa.findOne({
    estabelecimentoId: estabId,
    ativa: true,
    status: { $in: BLOCKING_ATTEMPT_STATUSES },
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
}

function tentativaPublica(attempt) {
  if (!attempt) return null;
  return {
    metodo: String(attempt.metodo),
    status: attempt.status === SUBSCRIPTION_ATTEMPT_STATUS.LEGACY_PROCESSING
      ? SUBSCRIPTION_ATTEMPT_STATUS.PROCESSING
      : String(attempt.status),
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
    cancelavel: attempt.metodo === "cartao"
      && CANCELLABLE_ATTEMPT_STATUSES.includes(attempt.status),
  };
}

function classifyRemotePreapproval(preapproval) {
  const remoteStatus = String(preapproval?.status || "").trim().toLowerCase();
  const payerPresent = Boolean(String(preapproval?.payer_id || "").trim());
  const alreadyCancelled = ["canceled", "cancelled"].includes(remoteStatus);
  const isAuthorizedSubscription = ["authorized", "paused"].includes(remoteStatus);
  const canAbandonLocally = remoteStatus === "pending";
  const canRequestRemoteCancellation = isAuthorizedSubscription;
  const classification = alreadyCancelled
    ? "already_cancelled"
    : canAbandonLocally
      ? "checkout_pending"
      : canRequestRemoteCancellation
        ? "remote_subscription"
        : "unknown";
  return {
    classification,
    remoteStatus,
    payerPresent,
    isAuthorizedSubscription,
    canRequestRemoteCancellation,
    canAbandonLocally,
    alreadyCancelled,
    requiresReconciliation: !alreadyCancelled
      && !canAbandonLocally
      && !canRequestRemoteCancellation,
  };
}

function logRemotePreapprovalSnapshot(preapproval, correlationId) {
  const preapprovalId = String(preapproval?.id || "");
  appLogger.info("mercado_pago_preapproval_inspection", {
    correlationId: String(correlationId || "") || null,
    operation: "preapproval_cancel_inspection",
    preapprovalIdSuffix: preapprovalId.slice(-8) || null,
    remoteStatus: String(preapproval?.status || "").slice(0, 40) || null,
    payerIdPresent: Boolean(String(preapproval?.payer_id || "").trim()),
    payerEmailPresent: Boolean(String(preapproval?.payer_email || preapproval?.payer?.email || "").trim()),
    collectorIdPresent: Boolean(String(preapproval?.collector_id || "").trim()),
    externalReferencePresent: Boolean(String(preapproval?.external_reference || "").trim()),
    initPointPresent: Boolean(String(preapproval?.init_point || "").trim()),
    sandboxInitPointPresent: Boolean(String(preapproval?.sandbox_init_point || "").trim()),
    autoRecurringPresent: Boolean(preapproval?.auto_recurring),
    autoRecurringCurrency: String(preapproval?.auto_recurring?.currency_id || "").slice(0, 10) || null,
    autoRecurringFrequency: Number(preapproval?.auto_recurring?.frequency) || null,
    autoRecurringFrequencyType: String(preapproval?.auto_recurring?.frequency_type || "").slice(0, 30) || null,
    reasonPresent: Boolean(String(preapproval?.reason || "").trim()),
    dateCreatedPresent: Boolean(String(preapproval?.date_created || "").trim()),
    lastModifiedPresent: Boolean(String(preapproval?.last_modified || "").trim()),
    nextPaymentDatePresent: Boolean(String(preapproval?.next_payment_date || "").trim()),
  });
}

function assertRemotePreapprovalIdentity(remote, attempt, preapprovalId, endpointPath) {
  const identityMatches = String(remote?.id || "") === preapprovalId
    && String(remote?.external_reference || "") === attemptReference(attempt)
    && String(remote?.collector_id || "") === platformCollectorId();
  if (!identityMatches) {
    const error = new Error("O preapproval remoto não pertence à tentativa da plataforma.");
    error.code = "SUBSCRIPTION_ATTEMPT_NOT_CANCELLABLE";
    error.stage = "preapproval_cancel_identity";
    error.endpointPath = endpointPath;
    throw error;
  }
}

function reconciliationAttemptUpdate(cause, now = new Date()) {
  return {
    $set: {
      status: SUBSCRIPTION_ATTEMPT_STATUS.RECONCILIATION_REQUIRED,
      cancelRequestedAt: null,
      cancelRequestId: "",
      reconciliationReason: cause?.classificationReason || "remote_status_not_supported",
      reconciliationRequestedAt: now,
      lastRemoteStatus: String(cause?.remoteStatus || ""),
      lastRemoteCheckedAt: now,
      erro: "Estado remoto exige reconciliação manual.",
    },
    $inc: { reconciliationAttempts: 1 },
  };
}

async function cancelarPreapprovalRemoto(
  attempt,
  cancelRequestId,
  requester = requestPlatform,
  context = {},
) {
  const preapprovalId = String(attempt.mercadoPagoPreapprovalId || "").trim();
  if (!preapprovalId) return { action: "abandon", status: "not_applicable" };
  const endpointPath = `/preapproval/${encodeURIComponent(preapprovalId)}`;
  let remote = await requester(endpointPath, {
    operation: "verify_subscription_preapproval_before_cancel",
    stage: "preapproval_cancel_lookup",
  });
  logRemotePreapprovalSnapshot(remote, context.correlationId);
  assertRemotePreapprovalIdentity(remote, attempt, preapprovalId, endpointPath);
  let classification = classifyRemotePreapproval(remote);
  if (classification.alreadyCancelled) return { action: "cancel", status: remote.status };
  if (classification.canAbandonLocally) return { action: "abandon", status: "not_applicable" };
  if (classification.requiresReconciliation) {
    const error = new Error("Não foi possível confirmar o estado da tentativa.");
    error.code = "SUBSCRIPTION_ATTEMPT_REQUIRES_RECONCILIATION";
    error.stage = "preapproval_cancel_classification";
    error.endpointPath = endpointPath;
    error.responseReceived = true;
    error.httpStatus = 200;
    error.remoteStatus = classification.remoteStatus;
    error.classificationReason = "remote_status_not_supported";
    throw error;
  }
  let cancelled;
  try {
    cancelled = await requester(endpointPath, {
      operation: "cancel_subscription_preapproval",
      stage: "preapproval_cancel_update",
      method: "PUT",
      idempotencyKey: cancelRequestId,
      body: { status: "canceled" },
    });
  } catch (cause) {
    if (Number(cause?.httpStatus || cause?.status) !== 400) throw cause;
    remote = await requester(endpointPath, {
      operation: "reconcile_subscription_preapproval_after_cancel_rejection",
      stage: "preapproval_cancel_reconciliation_lookup",
    });
    logRemotePreapprovalSnapshot(remote, context.correlationId);
    assertRemotePreapprovalIdentity(remote, attempt, preapprovalId, endpointPath);
    classification = classifyRemotePreapproval(remote);
    if (classification.alreadyCancelled) return { action: "cancel", status: remote.status };
    if (classification.canAbandonLocally) return { action: "abandon", status: "not_applicable" };
    if (classification.requiresReconciliation) {
      const error = new Error("Não foi possível confirmar o estado da tentativa.");
      error.code = "SUBSCRIPTION_ATTEMPT_REQUIRES_RECONCILIATION";
      error.stage = "preapproval_cancel_classification";
      error.endpointPath = endpointPath;
      error.responseReceived = true;
      error.httpStatus = 200;
      error.remoteStatus = classification.remoteStatus;
      error.classificationReason = "remote_status_not_supported_after_cancel_rejection";
      throw error;
    }
    const error = new Error(
      cause?.providerResponse?.providerMessage
      || "O Mercado Pago rejeitou o cancelamento remoto.",
      { cause },
    );
    error.code = "SUBSCRIPTION_REMOTE_CANCEL_REJECTED";
    error.operation = cause?.operation;
    error.stage = "preapproval_cancel_rejected";
    error.endpointPath = endpointPath;
    error.status = cause?.status;
    error.httpStatus = cause?.httpStatus;
    error.providerResponse = cause?.providerResponse;
    error.responseReceived = cause?.responseReceived;
    throw error;
  }
  if (String(cancelled?.id || "") !== preapprovalId
    || !["canceled", "cancelled"].includes(String(cancelled?.status || ""))) {
    const error = new Error("O Mercado Pago não confirmou o cancelamento da tentativa.");
    error.code = "SUBSCRIPTION_REMOTE_CANCEL_FAILED";
    error.stage = "preapproval_cancel_confirmation";
    error.endpointPath = endpointPath;
    throw error;
  }
  return { action: "cancel", status: String(cancelled.status) };
}

function pixDaTentativa(attempt) {
  return {
    qrCodeBase64: attempt.pixQrCodeBase64 || "",
    copiaCola: attempt.pixCopiaCola || "",
    expiresAt: attempt.expiresAt?.toISOString?.() || String(attempt.expiresAt || ""),
  };
}

const SUBSCRIPTION_PIX_TERMINAL_UNPAID = new Set([
  "cancelled",
  "canceled",
  "rejected",
  "refunded",
  "charged_back",
]);

async function reconciliarTentativaPixAssinatura(attempt, context = {}) {
  if (!attempt || attempt.metodo !== "pix") {
    return { attempt, remoteStatus: "", approved: false, terminal: false };
  }
  const paymentId = String(attempt.mercadoPagoPaymentId || "").trim();
  if (!paymentId) {
    return { attempt, remoteStatus: "", approved: false, terminal: false };
  }

  let payment;
  try {
    payment = await requestPlatform(`/v1/payments/${encodeURIComponent(paymentId)}`, {
      operation: "reconcile_subscription_pix_before_reuse",
      stage: "subscription_pix_status_lookup",
    });
  } catch (error) {
    appLogger.warn("subscription_pix_status_lookup_failed", {
      operation: "reconcile_subscription_pix_before_reuse",
      source: String(context.source || "unknown"),
      paymentIdSuffix: paymentId.slice(-8),
      httpStatus: Number(error?.httpStatus || error?.status || 0) || null,
      providerCode: error?.providerResponse?.providerCode || error?.code || null,
      errorName: String(error?.name || "Error"),
    });
    return { attempt, remoteStatus: "unknown", approved: false, terminal: false };
  }

  const remoteStatus = String(payment?.status || "").trim().toLowerCase();
  const now = new Date();
  attempt.lastRemoteStatus = remoteStatus;
  attempt.lastRemoteCheckedAt = now;

  if (remoteStatus === "approved") {
    await attempt.save();
    await processSubscriptionPayment({
      eventKey: `subscription_pix_reconcile:${paymentId}:approved`,
      requestId: `subscription_pix_reconcile:${String(context.source || "unknown")}`,
    }, payment);
    appLogger.info("subscription_pix_reconciled_before_reuse", {
      operation: "reconcile_subscription_pix_before_reuse",
      source: String(context.source || "unknown"),
      paymentIdSuffix: paymentId.slice(-8),
      remoteStatus,
    });
    return { attempt: null, remoteStatus, approved: true, terminal: true };
  }

  if (SUBSCRIPTION_PIX_TERMINAL_UNPAID.has(remoteStatus)) {
    attempt.ativa = false;
    attempt.completedAt = now;
    attempt.erro = "";
    if (["cancelled", "canceled"].includes(remoteStatus)) {
      attempt.status = SUBSCRIPTION_ATTEMPT_STATUS.CANCELLED;
      attempt.cancelledAt = attempt.cancelledAt || now;
    } else {
      attempt.status = SUBSCRIPTION_ATTEMPT_STATUS.FAILED;
    }
    await attempt.save();
    appLogger.info("subscription_pix_terminal_before_reuse", {
      operation: "reconcile_subscription_pix_before_reuse",
      source: String(context.source || "unknown"),
      paymentIdSuffix: paymentId.slice(-8),
      remoteStatus,
    });
    return { attempt: null, remoteStatus, approved: false, terminal: true };
  }

  if (remoteStatus === "authorized") {
    attempt.status = SUBSCRIPTION_ATTEMPT_STATUS.AUTHORIZED;
  } else if (remoteStatus === "pending" || remoteStatus === "in_process") {
    attempt.status = SUBSCRIPTION_ATTEMPT_STATUS.PENDING;
  }
  await attempt.save();
  return { attempt, remoteStatus, approved: false, terminal: false };
}

function chaveCriptografia() {
  const segredo = process.env.TOKEN_ENCRYPTION_KEY;
  if (!segredo) throw new Error("TOKEN_ENCRYPTION_KEY não foi configurada.");
  return crypto.createHash("sha256").update(segredo).digest();
}

function criptografar(texto) {
  if (!texto) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", chaveCriptografia(), iv);
  const encrypted = Buffer.concat([cipher.update(String(texto), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(buffer => buffer.toString("base64url")).join(".");
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

async function mp(path, options = {}, accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN) {
  if (!accessToken) throw new Error("Credencial Mercado Pago não configurada.");
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
    const rawBody = await response.text();
    let data = {};
    if (rawBody) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = { message: rawBody.slice(0, 300) };
      }
    }
    if (!response.ok) {
      const providerResponse = extractMercadoPagoProviderDetails(data);
      const error = new Error(
        providerResponse.providerMessage
        || `Mercado Pago respondeu HTTP ${response.status}.`,
      );
      error.name = "MercadoPagoHttpError";
      error.status = response.status;
      error.httpStatus = response.status;
      error.code = providerResponse.providerCode || "MERCADO_PAGO_HTTP_ERROR";
      error.providerResponse = providerResponse;
      error.responseReceived = true;
      error.endpointPath = path;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function assinaturaDoUsuario(req) {
  const id = estabelecimentoId(req);
  let assinatura = await Assinatura.findOne({ estabelecimentoId: id });
  if (!assinatura) {
    const inicio = new Date();
    assinatura = await Assinatura.create({
      estabelecimentoId: id,
      status: "teste",
      metodo: "teste",
      inicioTeste: inicio,
      fimTeste: new Date(inicio.getTime() + 7 * 86_400_000),
    });
  }
  return assinatura;
}

function manterTesteOuStatusAtual(assinatura) {
  if (assinatura.fimTeste && new Date(assinatura.fimTeste).getTime() > Date.now()) {
    return "teste";
  }
  if (assinatura.status === "ativa") return "ativa";
  return "pendente";
}

function flashSafeIntegrationError(req, error) {
  error.correlationId ||= String(req?.correlationId || "");
  appLogger.error("mercado_pago_platform_error", platformErrorLog(error, {
    correlationId: error.correlationId,
  }));
}

exports.pagina = async (req, res) => {
  try {
    let assinatura = await assinaturaDoUsuario(req);
    let tentativaAtiva = await tentativaAtivaDoEstabelecimento(estabelecimentoId(req));
    const dono = await registroModel.findById(estabelecimentoId(req)).lean();
    const integracao = mercadoPagoConfigStatus("subscription");

    if (tentativaAtiva?.metodo === "pix" && tentativaAtiva.pixCopiaCola) {
      const reconciliacao = await reconciliarTentativaPixAssinatura(tentativaAtiva, {
        source: "subscription_page",
      });
      if (reconciliacao.approved) {
        assinatura = await Assinatura.findOne({
          estabelecimentoId: estabelecimentoId(req),
        });
      }
      tentativaAtiva = await tentativaAtivaDoEstabelecimento(estabelecimentoId(req));
    }

    const tentativaPix = tentativaAtiva?.metodo === "pix"
      && tentativaAtiva.pixCopiaCola
      && tentativaAtiva.expiresAt
      && new Date(tentativaAtiva.expiresAt) > new Date()
      ? tentativaAtiva
      : null;
    return res.render("assinatura", {
      assinatura: assinatura.toObject(),
      valorPlano: valorPlano(),
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || "",
      dono,
      pix: tentativaPix ? pixDaTentativa(tentativaPix) : null,
      tentativaAtiva: tentativaPublica(tentativaAtiva),
      diasRestantes: res.locals.diasRestantes || 0,
      csrfToken: res.locals.csrfToken,
      integracaoMercadoPago: integracao,
    });
  } catch (error) {
    flashSafeIntegrationError(req, error);
    return res.status(500).render("assinatura", {
      assinatura: req.assinatura?.toObject?.() || { status: "indisponível" },
      valorPlano: valorPlano(),
      dono: null,
      pix: null,
      tentativaAtiva: null,
      diasRestantes: res.locals.diasRestantes || 0,
      csrfToken: res.locals.csrfToken,
      integracaoMercadoPago: validatePlatformPaymentConfig(),
      errors: [`Não foi possível carregar a assinatura. Código: ${error.correlationId || "indisponível"}`],
    });
  }
};

exports.cancelarTentativaAtiva = async (req, res) => {
  const estabId = estabelecimentoId(req);
  const cancelRequestId = crypto.randomUUID();
  try {
    if (planoPagoVigente(req.assinatura)) {
      return res.status(409).json({
        ok: false,
        code: "SUBSCRIPTION_ATTEMPT_NOT_CANCELLABLE",
        message: "A assinatura já está ativa.",
        correlationId: String(req.correlationId || ""),
      });
    }
    await expirarTentativasVencidas(estabId);
    const attempt = await AssinaturaTentativa.findOneAndUpdate({
      estabelecimentoId: estabId,
      metodo: "cartao",
      ativa: true,
      status: { $in: CANCELLABLE_ATTEMPT_STATUSES },
      expiresAt: { $gt: new Date() },
      $or: [
        { cancelRequestedAt: null },
        {
          status: SUBSCRIPTION_ATTEMPT_STATUS.RECONCILIATION_REQUIRED,
          cancelRequestId: { $in: ["", null] },
        },
      ],
    }, {
      $set: { cancelRequestedAt: new Date(), cancelRequestId },
    }, { returnDocument: "after" });

    if (!attempt) {
      const cancellationInProgress = await AssinaturaTentativa.findOne({
        estabelecimentoId: estabId,
        metodo: "cartao",
        ativa: true,
        status: { $in: CANCELLABLE_ATTEMPT_STATUSES },
        cancelRequestedAt: { $ne: null },
      });
      if (cancellationInProgress) {
        return res.status(200).json({
          ok: true,
          code: "SUBSCRIPTION_ATTEMPT_CANCELLATION_IN_PROGRESS",
          message: "O cancelamento já está sendo processado.",
        });
      }
      const alreadyCancelled = await AssinaturaTentativa.findOne({
        estabelecimentoId: estabId,
        metodo: "cartao",
        status: SUBSCRIPTION_ATTEMPT_STATUS.CANCELLED,
      }).sort({ cancelledAt: -1 });
      if (alreadyCancelled) {
        return res.status(200).json({
          ok: true,
          code: "SUBSCRIPTION_ATTEMPT_ALREADY_CANCELLED",
          message: "A tentativa já estava cancelada.",
        });
      }
      const nonCancellable = await AssinaturaTentativa.findOne({
        estabelecimentoId: estabId,
        metodo: "cartao",
        status: { $in: [
          SUBSCRIPTION_ATTEMPT_STATUS.APPROVED,
          SUBSCRIPTION_ATTEMPT_STATUS.RECONCILIATION_REQUIRED,
        ] },
      });
      return res.status(nonCancellable ? 409 : 404).json({
        ok: false,
        code: nonCancellable
          ? "SUBSCRIPTION_ATTEMPT_NOT_CANCELLABLE"
          : "SUBSCRIPTION_ATTEMPT_NOT_FOUND",
        message: nonCancellable
          ? "A tentativa não pode mais ser cancelada."
          : "Tentativa ativa de cartão não encontrada.",
        correlationId: String(req.correlationId || ""),
      });
    }

    let remote;
    try {
      remote = await cancelarPreapprovalRemoto(attempt, cancelRequestId, requestPlatform, {
        correlationId: req.correlationId,
      });
    } catch (cause) {
      if (cause?.code === "SUBSCRIPTION_ATTEMPT_REQUIRES_RECONCILIATION") {
        await AssinaturaTentativa.updateOne({
          _id: attempt._id,
          estabelecimentoId: estabId,
          cancelRequestId,
          ativa: true,
        }, reconciliationAttemptUpdate(cause)).catch(() => {});
        throw cause;
      }
      await AssinaturaTentativa.updateOne({
        _id: attempt._id,
        estabelecimentoId: estabId,
        cancelRequestId,
        ativa: true,
      }, { $set: { cancelRequestedAt: null, cancelRequestId: "" } }).catch(() => {});
      if ([
        "SUBSCRIPTION_ATTEMPT_NOT_CANCELLABLE",
        "SUBSCRIPTION_REMOTE_CANCEL_REJECTED",
      ].includes(cause?.code)) throw cause;
      const error = new Error("Não foi possível confirmar o cancelamento no Mercado Pago.", { cause });
      error.code = "SUBSCRIPTION_REMOTE_CANCEL_FAILED";
      error.operation = cause?.operation || "cancel_subscription_preapproval";
      error.stage = cause?.stage || "preapproval_cancel";
      error.endpointPath = cause?.endpointPath || "/preapproval/:id";
      error.status = cause?.status;
      error.httpStatus = cause?.httpStatus;
      error.providerResponse = cause?.providerResponse;
      error.responseReceived = cause?.responseReceived;
      error.timeout = cause?.timeout;
      throw error;
    }

    const now = new Date();
    const cancelled = await AssinaturaTentativa.findOneAndUpdate({
      _id: attempt._id,
      estabelecimentoId: estabId,
      metodo: "cartao",
      ativa: true,
      status: { $in: CANCELLABLE_ATTEMPT_STATUSES },
      cancelRequestId,
    }, {
      $set: {
        status: SUBSCRIPTION_ATTEMPT_STATUS.CANCELLED,
        ativa: false,
        cancelledAt: now,
        cancelledBy: estabId,
        completedAt: now,
        cancelRequestId: "",
        remoteCancellationStatus: remote.status,
        erro: "",
      },
    }, { returnDocument: "after" });
    if (!cancelled) {
      const current = await AssinaturaTentativa.findOne({
        _id: attempt._id,
        estabelecimentoId: estabId,
      });
      if (current?.status === SUBSCRIPTION_ATTEMPT_STATUS.CANCELLED) {
        return res.status(200).json({
          ok: true,
          code: "SUBSCRIPTION_ATTEMPT_ALREADY_CANCELLED",
          message: "A tentativa já estava cancelada.",
        });
      }
      return res.status(409).json({
        ok: false,
        code: "SUBSCRIPTION_ATTEMPT_NOT_CANCELLABLE",
        message: "A tentativa mudou de estado e não pode ser cancelada.",
        correlationId: String(req.correlationId || ""),
      });
    }
    return res.status(200).json({
      ok: true,
      code: remote.action === "abandon"
        ? "SUBSCRIPTION_ATTEMPT_ABANDONED"
        : "SUBSCRIPTION_ATTEMPT_CANCELLED",
      message: remote.action === "abandon"
        ? "A tentativa de cartão foi descartada."
        : "Tentativa cancelada.",
    });
  } catch (error) {
    error.correlationId ||= String(req.correlationId || "");
    flashSafeIntegrationError(req, error);
    const status = [
      "SUBSCRIPTION_ATTEMPT_NOT_CANCELLABLE",
      "SUBSCRIPTION_ATTEMPT_REQUIRES_RECONCILIATION",
    ].includes(error.code) ? 409 : 502;
    const responseCode = [
      "SUBSCRIPTION_ATTEMPT_NOT_CANCELLABLE",
      "SUBSCRIPTION_ATTEMPT_REQUIRES_RECONCILIATION",
      "SUBSCRIPTION_REMOTE_CANCEL_REJECTED",
    ].includes(error.code)
      ? error.code
      : "SUBSCRIPTION_REMOTE_CANCEL_FAILED";
    return res.status(status).json({
      ok: false,
      code: responseCode,
      message: error.code === "SUBSCRIPTION_ATTEMPT_REQUIRES_RECONCILIATION"
        ? "Não foi possível confirmar o estado da tentativa."
        : error.message,
      correlationId: error.correlationId,
    });
  }
};

exports.assinarCartao = async (req, res) => {
  try {
    assertMercadoPagoConfig("subscription");
    const id = estabelecimentoId(req);
    await validarContaPrincipalMercadoPago();
    const assinatura = await assinaturaDoUsuario(req);
    const dono = await registroModel.findById(id).lean();
    const payerEmail = validarEmailPagador(dono);
    const { attempt, created } = await obterOuCriarTentativa(assinatura, "cartao");
    if (!created) {
      if (attempt.redirectUrl) {
        const redirectUrl = validarRedirectMercadoPago(attempt.redirectUrl);
        return wantsJson(req)
          ? res.status(200).json({ ok: true, code: "SUBSCRIPTION_CHECKOUT_CREATED", checkoutUrl: redirectUrl })
          : res.redirect(303, redirectUrl);
      }
      safeFlash(req, "success", "Sua solicitação de assinatura já está sendo processada.");
      return saveSessionOrRun(req, () => res.redirect("/assinatura"));
    }
    const data = await requestPlatform("/preapproval", {
      operation: "create_subscription_checkout",
      stage: "preapproval_create",
      method: "POST",
      idempotencyKey: attempt.idempotencyKey,
      body: buildPreapprovalPayload({
        amount: valorPlano(),
        payerEmail,
        externalReference: attemptReference(attempt),
        backUrl: `${baseUrl(req)}/assinatura/retorno`,
      }),
    });
    if (!data.id || !data.init_point) {
      const error = new Error("O Mercado Pago não retornou a URL do checkout.");
      error.code = "SUBSCRIPTION_CHECKOUT_URL_MISSING";
      error.stage = "preapproval_response_validation";
      error.endpointPath = "/preapproval";
      throw error;
    }
    let redirectSeguro;
    try {
      redirectSeguro = validarRedirectMercadoPago(data.init_point);
    } catch (cause) {
      const error = new Error("O Mercado Pago retornou uma URL de checkout inválida.", { cause });
      error.code = "SUBSCRIPTION_CHECKOUT_URL_INVALID";
      error.stage = "preapproval_redirect_validation";
      error.endpointPath = "/preapproval";
      throw error;
    }
    await AssinaturaTentativa.updateOne(
      { _id: attempt._id, status: { $in: [
        SUBSCRIPTION_ATTEMPT_STATUS.PROCESSING,
        SUBSCRIPTION_ATTEMPT_STATUS.LEGACY_PROCESSING,
      ] }, ativa: true },
      {
        $set: {
          status: ["authorized", "pending"].includes(data.status)
            ? data.status
            : "pending",
          mercadoPagoPreapprovalId: String(data.id),
          redirectUrl: redirectSeguro,
          erro: "",
        },
      },
    );
    assinatura.metodo = "cartao";
    assinatura.status = manterTesteOuStatusAtual(assinatura);
    assinatura.mercadoPagoPreapprovalId = String(data.id);
    assinatura.mercadoPagoPreapprovalCriadoEm = new Date();
    assinatura.ultimoStatusMercadoPago = String(data.status || "pending");
    assinatura.proximaCobranca = null;
    await assinatura.save();
    return wantsJson(req)
      ? res.status(200).json({ ok: true, code: "SUBSCRIPTION_CHECKOUT_CREATED", checkoutUrl: redirectSeguro })
      : res.redirect(303, redirectSeguro);
  } catch (error) {
    if (!["ASSINATURA_ATIVA", "TENTATIVA_METODO_DIFERENTE"].includes(error?.code)) {
      await AssinaturaTentativa.updateOne(
        {
          estabelecimentoId: estabelecimentoId(req),
          metodo: "cartao",
          status: { $in: [
            SUBSCRIPTION_ATTEMPT_STATUS.PROCESSING,
            SUBSCRIPTION_ATTEMPT_STATUS.LEGACY_PROCESSING,
          ] },
          ativa: true,
        },
        {
          $set: {
            status: "failed",
            ativa: false,
            erro: sanitizeMercadoPagoError(error).message,
          },
        },
      ).catch(() => {});
    }
    flashSafeIntegrationError(req, error);
    if (wantsJson(req)) {
      const payload = safeMercadoPagoFailure(error);
      return res.status(String(error?.code || "").includes("MISSING") || error?.code === "APP_URL_INVALID" ? 503 : 502).json(payload);
    }
    return saveSessionOrRun(req, () => res.redirect("/assinatura"));
  }
};

exports.gerarPix = async (req, res) => {
  try {
    assertMercadoPagoConfig("subscription");
    await validarContaPrincipalMercadoPago();
    const id = estabelecimentoId(req);
    const assinatura = await assinaturaDoUsuario(req);
    const dono = await registroModel.findById(id).lean();
    const payerEmail = validarEmailPagador(dono);
    let { attempt, created } = await obterOuCriarTentativa(assinatura, "pix");
    if (!created && attempt.pixCopiaCola) {
      const reconciliacao = await reconciliarTentativaPixAssinatura(attempt, {
        source: "subscription_pix_create",
      });
      if (reconciliacao.approved) {
        if (wantsJson(req)) {
          return res.status(200).json({
            ok: true,
            code: "SUBSCRIPTION_ALREADY_PAID",
            subscriptionActive: true,
            redirectUrl: "/assinatura",
          });
        }
        return saveSessionOrRun(req, () => res.redirect("/assinatura"));
      }
      if (reconciliacao.terminal) {
        ({ attempt, created } = await obterOuCriarTentativa(assinatura, "pix"));
      } else {
        attempt = reconciliacao.attempt || attempt;
      }
    }
    if (!created) {
      if (!attempt.pixCopiaCola) {
        safeFlash(req, "success", "Seu Pix já está sendo gerado.");
        return saveSessionOrRun(req, () => res.redirect("/assinatura"));
      }
      if (wantsJson(req)) {
        return res.status(200).json({
          ok: true,
          code: "SUBSCRIPTION_PIX_CREATED",
          paymentId: String(attempt.mercadoPagoPaymentId || ""),
          qrCode: attempt.pixCopiaCola,
          qrCodeBase64: attempt.pixQrCodeBase64,
          expiresAt: attempt.expiresAt?.toISOString?.() || String(attempt.expiresAt || ""),
        });
      }
      return res.render("assinatura", {
        assinatura: assinatura.toObject(),
        valorPlano: valorPlano(),
        publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || "",
        dono,
        diasRestantes: res.locals.diasRestantes || 0,
        csrfToken: res.locals.csrfToken,
        pix: pixDaTentativa(attempt),
        tentativaAtiva: tentativaPublica(attempt),
        integracaoMercadoPago: mercadoPagoConfigStatus("subscription"),
      });
    }
    const pixPaymentPayload = buildPixPaymentPayload({
      amount: valorPlano(),
      payerEmail,
      externalReference: attemptReference(attempt),
      notificationUrl: mercadoPagoWebhookUrl(req),
    });
    const data = await requestPlatform("/v1/payments", {
      operation: "create_subscription_pix",
      stage: "pix_payment_create",
      method: "POST",
      idempotencyKey: attempt.idempotencyKey,
      body: pixPaymentPayload,
    });
    const parsedPix = parseSubscriptionPixResponse(data, pixPaymentPayload.date_of_expiration);
    const pixQrCodeBase64 = parsedPix.qrCodeBase64;
    const pixCopiaCola = parsedPix.qrCode;
    await AssinaturaTentativa.updateOne(
      { _id: attempt._id, status: { $in: [
        SUBSCRIPTION_ATTEMPT_STATUS.PROCESSING,
        SUBSCRIPTION_ATTEMPT_STATUS.LEGACY_PROCESSING,
      ] }, ativa: true },
      {
        $set: {
          status: ["pending", "authorized", "approved"].includes(data.status)
            ? data.status
            : "pending",
          mercadoPagoPaymentId: String(data.id),
          pixQrCodeBase64,
          pixCopiaCola,
          expiresAt: new Date(parsedPix.expiresAt),
          erro: "",
        },
      },
    );
    assinatura.metodo = "pix";
    assinatura.status = manterTesteOuStatusAtual(assinatura);
    assinatura.mercadoPagoPaymentId = String(data.id);
    assinatura.mercadoPagoPaymentCriadoEm = new Date();
    assinatura.ultimoStatusMercadoPago = String(data.status || "pending");
    await assinatura.save();

    const pix = {
      qrCodeBase64: pixQrCodeBase64,
      copiaCola: pixCopiaCola,
      expiresAt: parsedPix.expiresAt,
    };
    if (wantsJson(req)) {
      return res.status(200).json({
        ok: true,
        code: "SUBSCRIPTION_PIX_CREATED",
        paymentId: parsedPix.paymentId,
        qrCode: pixCopiaCola,
        qrCodeBase64: pixQrCodeBase64,
        ticketUrl: parsedPix.ticketUrl,
        expiresAt: parsedPix.expiresAt,
      });
    }
    return res.render("assinatura", {
      assinatura: assinatura.toObject(),
      valorPlano: valorPlano(),
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || "",
      dono,
      diasRestantes: res.locals.diasRestantes || 0,
      csrfToken: res.locals.csrfToken,
      pix,
      tentativaAtiva: tentativaPublica({
        metodo: "pix",
        status: data.status || SUBSCRIPTION_ATTEMPT_STATUS.PENDING,
        createdAt: attempt.createdAt,
        expiresAt: parsedPix.expiresAt,
      }),
      integracaoMercadoPago: mercadoPagoConfigStatus("subscription"),
    });
  } catch (error) {
    if (!["ASSINATURA_ATIVA", "TENTATIVA_METODO_DIFERENTE"].includes(error?.code)) {
      await AssinaturaTentativa.updateOne(
        {
          estabelecimentoId: estabelecimentoId(req),
          metodo: "pix",
          status: { $in: [
            SUBSCRIPTION_ATTEMPT_STATUS.PROCESSING,
            SUBSCRIPTION_ATTEMPT_STATUS.LEGACY_PROCESSING,
          ] },
          ativa: true,
        },
        {
          $set: {
            status: "failed",
            ativa: false,
            erro: sanitizeMercadoPagoError(error).message,
          },
        },
      ).catch(() => {});
    }
    flashSafeIntegrationError(req, error);
    if (wantsJson(req)) {
      const payload = safeMercadoPagoFailure(error);
      return res.status(String(error?.code || "").includes("MISSING") || error?.code === "APP_URL_INVALID" ? 503 : 502).json(payload);
    }
    return saveSessionOrRun(req, () => res.redirect("/assinatura"));
  }
};

exports.retorno = async (req, res) => {
  safeFlash(
    req,
    "success",
    "Pagamento iniciado. A liberação ocorrerá somente após confirmação financeira.",
  );
  return saveSessionOrRun(req, () => res.redirect("/assinatura"));
};

exports.conectarMercadoPago = async (req, res) => {
  try {
    assertMercadoPagoConfig("oauth");
    await requirePlatformFeeAcceptance(estabelecimentoId(req));
    const state = crypto.randomBytes(32).toString("base64url");
    const codeVerifier = crypto.randomBytes(48).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    await OAuthState.create({
      stateHash,
      sessionId: String(req.sessionID),
      estabelecimentoId: estabelecimentoId(req),
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    });
    req.session.mpOauthStateHash = stateHash;
    req.session.mpOauthCodeVerifier = codeVerifier;
    await new Promise((resolve, reject) =>
      req.session.save(error => error ? reject(error) : resolve()));

    const url = new URL("https://auth.mercadopago.com/authorization");
    url.searchParams.set("client_id", process.env.MP_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("platform_id", "mp");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", process.env.MP_REDIRECT_URI);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    const authorizationUrl = url.toString();
    return wantsJson(req)
      ? res.status(200).json({ ok: true, code: "MERCADO_PAGO_OAUTH_READY", authorizationUrl })
      : res.redirect(303, authorizationUrl);
  } catch (error) {
    flashSafeIntegrationError(req, error);
    if (wantsJson(req)) {
      const payload = safeMercadoPagoFailure(error);
      return res.status(Number(error?.httpStatus || (error?.code === "MERCADO_PAGO_CONFIG_INCOMPLETA" ? 503 : 502))).json(payload);
    }
    return saveSessionOrRun(req, () => res.redirect("/admin#configuracoes"));
  }
};

async function consumeOauthState(req) {
  const supplied = String(req.query.state || "");
  if (!supplied || !req.sessionID) throw new Error("Estado OAuth inválido ou expirado.");
  const suppliedHash = crypto.createHash("sha256").update(supplied).digest("hex");
  const consumed = await OAuthState.findOneAndUpdate(
    {
      stateHash: suppliedHash,
      sessionId: String(req.sessionID),
      estabelecimentoId: estabelecimentoId(req),
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { consumedAt: new Date() } },
    { returnDocument: "after" },
  );
  const codeVerifier = String(req.session.mpOauthCodeVerifier || "");
  delete req.session.mpOauthStateHash;
  delete req.session.mpOauthCodeVerifier;
  await new Promise((resolve, reject) =>
    req.session.save(error => error ? reject(error) : resolve()));
  if (!consumed || !codeVerifier) {
    throw new Error("Estado OAuth inválido ou expirado.");
  }
  return codeVerifier;
}

exports.callbackMercadoPago = async (req, res) => {
  try {
    assertMercadoPagoConfig("oauth");
    await requirePlatformFeeAcceptance(estabelecimentoId(req));
    if (!req.query.code || !req.query.state) throw new Error("Callback OAuth incompleto.");
    const codeVerifier = await consumeOauthState(req);

    const response = await fetch(`${MP_API}/oauth/token`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_secret: process.env.MP_CLIENT_SECRET,
        client_id: process.env.MP_CLIENT_ID,
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: process.env.MP_REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    });
    const token = await response.json().catch(() => ({}));
    if (!response.ok || !token.access_token || !token.user_id) {
      const error = new Error("Falha ao conectar conta.");
      error.status = response.status;
      error.code = token.error || token.code || "";
      throw error;
    }
    const account = await mp("/users/me", {}, token.access_token);
    if (!account?.id || String(account.id) !== String(token.user_id)) {
      throw new Error("Identidade da conta Mercado Pago não pôde ser confirmada.");
    }
    if (getCurrentPlatformFeeConfig().enabled) {
      assertMarketplaceSellerAccount(token.user_id);
    }

    await Configuracao.findOneAndUpdate(
      { estabelecimentoId: estabelecimentoId(req) },
      { $set: {
        "mercadoPago.conectado": true,
        "mercadoPago.userId": String(token.user_id),
        "mercadoPago.publicKey": String(token.public_key || ""),
        "mercadoPago.accessTokenCriptografado": criptografar(token.access_token),
        "mercadoPago.refreshTokenCriptografado": criptografar(token.refresh_token),
        "mercadoPago.tokenExpiraEm": token.expires_in
          ? new Date(Date.now() + Number(token.expires_in) * 1000)
          : null,
        "mercadoPago.scope": String(token.scope || ""),
        "mercadoPago.conectadoEm": new Date(),
        "mercadoPago.conectadoPor": req.session.user.id,
        "mercadoPago.desconectadoEm": null,
        "mercadoPago.desconectadoPor": null,
      }},
      { upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );
    safeFlash(req, "success", "Conta Mercado Pago conectada com sucesso.");
    return saveSessionOrRun(req, () => res.redirect("/admin#configuracoes"));
  } catch (error) {
    flashSafeIntegrationError(req, error);
    return saveSessionOrRun(req, () => res.redirect("/admin#configuracoes"));
  }
};

exports.aceitarTermosTaxaPix = async (req, res) => {
  try {
    const storeId = estabelecimentoId(req);
    const config = getCurrentPlatformFeeConfig();
    if (req.body?.accepted !== true && String(req.body?.accepted) !== "true") {
      return res.status(400).json({
        ok: false,
        code: "PLATFORM_FEE_TERMS_NOT_ACCEPTED",
        message: "Confirme que leu e aceitou os termos.",
      });
    }
    const ipKey = String(process.env.TOKEN_ENCRYPTION_KEY || process.env.SESSION_SECRET || "");
    if (!ipKey) throw new Error("Chave de auditoria não configurada.");
    const ipHash = crypto.createHmac("sha256", ipKey)
      .update(`${String(req.ip || "")}|${storeId}`)
      .digest("hex");
    await PlatformFeeTermsAcceptance.updateMany({
      estabelecimentoId: storeId,
      source: "mercado_pago_oauth",
      status: "active",
      $or: [
        { termsVersion: { $ne: config.termsVersion } },
        { termsHash: { $ne: config.termsHash } },
        { platformFeePercent: { $ne: config.percentage } },
      ],
    }, { $set: { status: "revoked", revokedAt: new Date() } });
    const acceptanceQuery = {
      estabelecimentoId: storeId,
      termsVersion: config.termsVersion,
      termsHash: config.termsHash,
      source: "mercado_pago_oauth",
      status: "active",
    };
    let acceptance;
    try {
      acceptance = await PlatformFeeTermsAcceptance.findOneAndUpdate(
        acceptanceQuery,
        { $setOnInsert: {
          usuarioId: req.session.user.id,
          platformFeePercent: config.percentage,
          acceptedAt: new Date(),
          ipHash,
          userAgentSanitized: String(req.get?.("user-agent") || "")
            .replace(/[\r\n]/g, " ").slice(0, 300),
          revokedAt: null,
        } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      acceptance = await PlatformFeeTermsAcceptance.findOne(acceptanceQuery);
      if (!acceptance) throw error;
    }
    await Configuracao.updateOne({ estabelecimentoId: storeId }, { $set: {
      "mercadoPago.termsAcceptedAt": acceptance.acceptedAt,
      "mercadoPago.termsVersion": acceptance.termsVersion,
      "mercadoPago.platformFeePercent": acceptance.platformFeePercent,
    } });
    return res.status(201).json({
      ok: true,
      code: "PLATFORM_FEE_TERMS_ACCEPTED",
      termsVersion: acceptance.termsVersion,
      platformFeePercent: acceptance.platformFeePercent,
      acceptedAt: acceptance.acceptedAt,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      code: "PLATFORM_FEE_TERMS_SAVE_FAILED",
      message: "Não foi possível registrar o aceite.",
      correlationId: String(req.correlationId || ""),
    });
  }
};

exports.desconectarMercadoPago = async (req, res) => {
  await Configuracao.findOneAndUpdate(
    { estabelecimentoId: estabelecimentoId(req) },
    { $set: {
      "mercadoPago.conectado": false,
      "mercadoPago.userId": "",
      "mercadoPago.publicKey": "",
      "mercadoPago.accessTokenCriptografado": "",
      "mercadoPago.refreshTokenCriptografado": "",
      "mercadoPago.tokenExpiraEm": null,
      "mercadoPago.scope": "",
      "mercadoPago.conectadoEm": null,
      "mercadoPago.conectadoPor": null,
      "mercadoPago.desconectadoEm": new Date(),
      "mercadoPago.desconectadoPor": req.session.user.id,
    }},
    { runValidators: true },
  );
  safeFlash(req, "success", "Conta Mercado Pago desconectada.");
  return saveSessionOrRun(req, () => res.redirect("/admin#configuracoes"));
};

async function configuracaoComToken(estabelecimento) {
  const cfg = await Configuracao.findOne({ estabelecimentoId: estabelecimento })
    .select("+mercadoPago.accessTokenCriptografado +mercadoPago.refreshTokenCriptografado");
  if (!cfg?.mercadoPago?.conectado || !cfg.mercadoPago.accessTokenCriptografado) {
    throw new Error("Este estabelecimento ainda não conectou a conta Mercado Pago.");
  }
  if (!cfg.mercadoPago.userId) throw new Error("Conta Mercado Pago sem identificação.");
  return {
    cfg,
    accessToken: descriptografar(cfg.mercadoPago.accessTokenCriptografado),
  };
}

const orderAttemptExternalReference = publicReference =>
  `order_payment_attempt:${publicReference}`;
const isOpaqueOrderReference = value =>
  /^order_payment_attempt:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));

async function activeOrderPaymentAttempt({
  pedido,
  collectorId,
  feeSnapshot,
  expectedAmount,
}) {
  const normalizedExpectedAmount = Number(expectedAmount);
  if (!Number.isFinite(normalizedExpectedAmount) || normalizedExpectedAmount <= 0) {
    const error = new Error("Valor Pix do pedido inválido.");
    error.code = "ORDER_PIX_AMOUNT_INVALID";
    error.httpStatus = 422;
    throw error;
  }

  const now = new Date();
  const current = await OrderPaymentAttempt.findOne({
    estabelecimentoId: pedido.estabelecimentoId,
    pedidoId: pedido._id,
    paymentMethod: "pix",
    status: { $in: ORDER_PIX_ACTIVE_STATUSES },
    expiresAt: { $gt: now },
    createdAt: { $gt: new Date(now.getTime() - ORDER_PIX_EXPIRATION_MS) },
    legacyReference: false,
  }).sort({ createdAt: -1 });
  if (current) {
    if (Math.abs(Number(current.expectedAmount) - normalizedExpectedAmount) > 0.001) {
      const error = new Error("O valor Pix desta tentativa não corresponde ao pedido atual.");
      error.code = "ORDER_PIX_AMOUNT_CONFLICT";
      error.httpStatus = 409;
      throw error;
    }
    if (!current.paymentId && !current.platformFeeCents) {
      Object.assign(current, feeSnapshot);
      await current.save();
    }
    return current;
  }
  const publicReference = crypto.randomUUID();
  return OrderPaymentAttempt.create({
    publicReference,
    externalReference: orderAttemptExternalReference(publicReference),
    estabelecimentoId: pedido.estabelecimentoId,
    pedidoId: pedido._id,
    expectedCollectorId: String(collectorId),
    expectedAmount: normalizedExpectedAmount,
    currency: "BRL",
    status: "creating",
    paymentMethod: "pix",
    idempotencyKey: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + ORDER_PIX_EXPIRATION_MS),
    ...feeSnapshot,
  });
}

async function cancelarPixPendenteRemoto(paymentId, accessToken) {
  const id = String(paymentId || "").trim();
  if (!id || !accessToken) return null;
  try {
    return await mp(`/v1/payments/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ status: "cancelled" }),
    }, accessToken);
  } catch (error) {
    // Não convertemos falha do provedor em expiração local definitiva. O worker
    // manterá a tentativa em expiration_pending e fará novas consultas/cancelamentos.
    appLogger.warn("order_pix_remote_expiration_cancel_failed", {
      paymentIdSuffix: idSuffix(id),
      providerCode: String(error?.code || "").slice(0, 80) || null,
      errorName: String(error?.name || "Error").slice(0, 80),
    });
    return null;
  }
}

async function registrarAprovacaoPixAposExpiracao({
  pedido,
  payment,
  attempt,
  correlationId = "",
}) {
  const now = new Date();
  if (attempt) {
    attempt.status = "approved";
    attempt.lastCheckedAt = now;
    attempt.reconciliationStatus = "reconciliation_required";
    if (Number(attempt.platformFeeCents || 0) > 0) {
      attempt.platformFeeStatus = "reconciliation_required";
      attempt.platformFeeNetCents = 0;
    }
    await attempt.save();
  }

  if (!Array.isArray(pedido.historicoFinanceiro)) pedido.historicoFinanceiro = [];
  const operationKey = `pix_aprovado_apos_expiracao:${String(payment.id || "")}`;
  if (!pedido.historicoFinanceiro.some(item => String(item?.operationKey || "") === operationKey)) {
    pedido.historicoFinanceiro.push({
      paymentId: String(payment.id || ""),
      status: "reconciliation_required:approved_after_expiration",
      tipo: "pix_online_aprovado_apos_expiracao",
      statusAnterior: String(pedido.pagamentoStatus || "pendente"),
      statusNovo: "expirado",
      formaPagamento: "pix_online",
      pagamentos: [{
        formaPagamento: "pix_online",
        valorCentavos: Math.max(0, Math.round(Number(attempt?.expectedAmount || payment.transaction_amount || 0) * 100)),
      }],
      valor: Number(attempt?.expectedAmount || payment.transaction_amount || 0),
      motivo: "Pagamento Pix aprovado depois do prazo de 10 minutos; conciliação manual necessária.",
      operationKey,
      registradoEm: now,
    });
  }
  pedido.pagamentoStatus = "expirado";
  pedido.mercadoPagoPaymentId = String(payment.id || pedido.mercadoPagoPaymentId || "");
  pedido.mercadoPagoStatus = "approved";
  pedido.pixExpiradoEm = pedido.pixExpiradoEm || now;
  pedido.pagamentoInconsistente = true;
  pedido.pagamentoInconsistencia = "Pagamento Pix aprovado após a expiração de 10 minutos. Conciliação manual necessária.";
  if (Number(attempt?.platformFeeCents || 0) > 0) {
    pedido.platformFeeStatus = "reconciliation_required";
    pedido.platformFeeNetCents = 0;
  }
  await pedido.save();

  const details = {
    estabelecimentoIdSuffix: idSuffix(pedido.estabelecimentoId),
    pedidoIdSuffix: idSuffix(pedido._id),
    paymentIdSuffix: idSuffix(payment.id),
    correlationId: String(correlationId || "").slice(0, 100) || null,
  };
  appLogger.error("mercado_pago_order_pix_approved_after_expiration", details);
  operationalAlerts.trigger({
    event: "mercado_pago_order_pix_approved_after_expiration",
    key: `mercado_pago_order_pix_approved_after_expiration:${String(payment.id || "")}`,
    severity: "critical",
    details,
  });
  return { pedido, stateTransitionApplied: false, jobs: [] };
}

async function expirarPixPedidoSeNecessario({
  pedido,
  attempt = null,
  accessToken = "",
  now = new Date(),
  correlationId = "",
  consultarRemoto = true,
}) {
  if (!orderPixExpiredByClock(pedido, attempt, now)) {
    return { expired: false, expirationPending: false, pedido, attempt };
  }

  const paymentId = String(attempt?.paymentId || pedido?.mercadoPagoPaymentId || "").trim();
  const pendingReason = async (reason, remoteStatus = "") => {
    const result = await markOrderPixExpirationPending({
      pedido,
      attempt,
      now,
      remoteStatus,
      reason,
    });
    appLogger.warn("order_pix_expiration_pending_remote_confirmation", {
      estabelecimentoIdSuffix: idSuffix(pedido?.estabelecimentoId),
      pedidoIdSuffix: idSuffix(pedido?._id),
      paymentIdSuffix: idSuffix(paymentId),
      remoteStatus: String(remoteStatus || "").slice(0, 40) || null,
      reason: String(reason || "").slice(0, 180),
      correlationId: String(correlationId || "").slice(0, 100) || null,
    });
    return { expired: false, expirationPending: true, ...result };
  };

  // Sem paymentId ou credencial não há como provar que o QR remoto ficou inválido.
  // O pedido permanece bloqueado para arquivamento e o worker tentará novamente.
  if (!paymentId) {
    return pendingReason("A tentativa atingiu o prazo sem paymentId confirmado pelo provedor.");
  }
  if (!consultarRemoto || !accessToken) {
    return pendingReason("Não há credencial disponível para confirmar a expiração no Mercado Pago.");
  }

  let remotePayment = null;
  try {
    remotePayment = await mp(`/v1/payments/${encodeURIComponent(paymentId)}`, {}, accessToken);
  } catch (error) {
    appLogger.warn("order_pix_expiration_status_lookup_failed", {
      paymentIdSuffix: idSuffix(paymentId),
      providerCode: String(error?.code || "").slice(0, 80) || null,
      errorName: String(error?.name || "Error").slice(0, 80),
    });
    return pendingReason("Falha ao consultar o status remoto antes de expirar o Pix.");
  }

  let remoteStatus = String(remotePayment?.status || "").trim().toLowerCase();

  if (remoteStatus === "approved") {
    const result = await applyOrderPayment(
      pedido,
      remotePayment,
      attempt,
      "expiration_reconciliation",
      correlationId,
    );
    return {
      expired: String(result?.pagamentoStatus || "") === "expirado",
      expirationPending: String(result?.pagamentoStatus || "") === "expiracao_pendente",
      approved: String(result?.pagamentoStatus || "") === "pago",
      pedido: result,
      attempt,
    };
  }

  if (isRemoteTerminalUnpaidStatus(remoteStatus)) {
    const result = await markOrderPixExpired({ pedido, attempt, now, remoteStatus });
    appLogger.info("order_pix_expired", {
      estabelecimentoIdSuffix: idSuffix(pedido.estabelecimentoId),
      pedidoIdSuffix: idSuffix(pedido._id),
      paymentIdSuffix: idSuffix(paymentId),
      remoteStatus,
      expirationMinutes: ORDER_PIX_EXPIRATION_MINUTES,
      correlationId: String(correlationId || "").slice(0, 100) || null,
    });
    return { expired: true, expirationPending: false, ...result };
  }

  if (["pending", "in_process", "authorized"].includes(remoteStatus)) {
    const cancelled = await cancelarPixPendenteRemoto(paymentId, accessToken);
    if (!cancelled) {
      return pendingReason("O Mercado Pago não confirmou o cancelamento do Pix.", remoteStatus);
    }
    remotePayment = cancelled;
    remoteStatus = String(cancelled.status || "").trim().toLowerCase();

    if (remoteStatus === "approved") {
      const result = await applyOrderPayment(
        pedido,
        remotePayment,
        attempt,
        "expiration_cancel_race",
        correlationId,
      );
      return {
        expired: String(result?.pagamentoStatus || "") === "expirado",
        expirationPending: String(result?.pagamentoStatus || "") === "expiracao_pendente",
        approved: String(result?.pagamentoStatus || "") === "pago",
        pedido: result,
        attempt,
      };
    }

    if (!isRemoteTerminalUnpaidStatus(remoteStatus)) {
      return pendingReason(
        "O cancelamento foi solicitado, mas o provedor ainda não retornou um estado terminal.",
        remoteStatus,
      );
    }

    const result = await markOrderPixExpired({ pedido, attempt, now, remoteStatus });
    appLogger.info("order_pix_expired", {
      estabelecimentoIdSuffix: idSuffix(pedido.estabelecimentoId),
      pedidoIdSuffix: idSuffix(pedido._id),
      paymentIdSuffix: idSuffix(paymentId),
      remoteStatus,
      expirationMinutes: ORDER_PIX_EXPIRATION_MINUTES,
      correlationId: String(correlationId || "").slice(0, 100) || null,
    });
    return { expired: true, expirationPending: false, ...result };
  }

  return pendingReason(
    "O provedor retornou um status não terminal; a expiração ainda precisa ser confirmada.",
    remoteStatus,
  );
}

async function reconciliarPixPedidosExpirados({ limit = 100 } = {}) {
  const attempts = await findExpiredActiveAttempts({ limit });
  const tokenCache = new Map();
  const result = { encontrados: attempts.length, expirados: 0, pendentesConfirmacao: 0, aprovados: 0, falhas: 0 };

  for (const attempt of attempts) {
    try {
      const pedido = await findOrderForAttempt(attempt);
      if (!pedido) {
        await markMissingOrderAttemptPending(attempt);
        result.pendentesConfirmacao += 1;
        continue;
      }
      if (pedido.pagamentoStatus === "pago") {
        attempt.status = "approved";
        attempt.reconciliationStatus = "processed";
        attempt.processedAt = attempt.processedAt || new Date();
        await attempt.save();
        result.aprovados += 1;
        continue;
      }

      const tenantKey = String(attempt.estabelecimentoId);
      let accessToken = tokenCache.get(tenantKey);
      if (accessToken === undefined) {
        try {
          ({ accessToken } = await configuracaoComToken(attempt.estabelecimentoId));
        } catch {
          accessToken = "";
        }
        tokenCache.set(tenantKey, accessToken);
      }
      const expiration = await expirarPixPedidoSeNecessario({
        pedido,
        attempt,
        accessToken,
        now: new Date(),
        correlationId: "worker_pix_expiration",
        consultarRemoto: Boolean(accessToken),
      });
      if (expiration.approved) result.aprovados += 1;
      else if (expiration.expired) result.expirados += 1;
      else if (expiration.expirationPending) result.pendentesConfirmacao += 1;
    } catch (error) {
      result.falhas += 1;
      appLogger.error("order_pix_expiration_worker_failed", {
        attemptIdSuffix: idSuffix(attempt?._id),
        paymentIdSuffix: idSuffix(attempt?.paymentId),
        errorName: String(error?.name || "Error").slice(0, 80),
        errorMessage: String(error?.message || "Falha desconhecida").slice(0, 240),
      });
    }
  }

  return result;
}

exports.gerarPixPedido = async (req, res) => {
  try {
    const token = extrairBearerToken(req);
    if (!token) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado.",
      });
    }
    const cfgPublica = await Configuracao.findOne({ slug: req.params.slug }).lean();
    if (!cfgPublica) {
      return res.status(404).json({ success: false, message: "Estabelecimento não encontrado." });
    }
    const acessoVenda = await consultarAcessoVenda({
      estabelecimentoId: cfgPublica.estabelecimentoId,
      estabelecimento: cfgPublica,
    });
    if (!acessoVenda.permitido) return respostaLojaIndisponivel(res);

    const pedido = await buscarPedidoPorToken({
      estabelecimentoId: cfgPublica.estabelecimentoId,
      token,
      lean: false,
    });
    if (!pedido) return res.status(404).json({ success: false, message: "Pedido não encontrado." });

    const valorPixCentavos = valorPixOnlinePedidoCentavos(pedido);
    if (!Number.isSafeInteger(valorPixCentavos) || valorPixCentavos <= 0) {
      return res.status(422).json({
        success: false,
        code: "ORDER_PIX_NOT_PLANNED",
        message: "Este pedido não possui uma parte destinada ao Pix online.",
      });
    }
    const valorPix = valorPixCentavos / 100;
    const pagamentoCombinado = String(pedido.formaPagamento || "") === "combinado";

    if (pedido.pagamentoStatus === "pago") {
      return res.json({
        success: true,
        aprovado: true,
        valorPix,
        pagamentoCombinado,
      });
    }
    if (pedido.pagamentoStatus === "expiracao_pendente" && !pedido.mercadoPagoPaymentId) {
      return res.json({
        success: true,
        expiracaoPendente: true,
        status: pedido.mercadoPagoStatus || "pending",
        expiraEm: pedido.pixExpiraEm,
        valorPix,
        pagamentoCombinado,
        message: "O prazo do Pix terminou e a tentativa ainda precisa de conciliação antes de gerar outro pagamento.",
      });
    }
    if (pedido.mercadoPagoPaymentId) {
      const existingAttempt = await OrderPaymentAttempt.findOne({
        estabelecimentoId: pedido.estabelecimentoId,
        pedidoId: pedido._id,
        paymentMethod: "pix",
        paymentId: String(pedido.mercadoPagoPaymentId),
      }).sort({ createdAt: -1 });
      if (["expirado", "expiracao_pendente"].includes(String(pedido.pagamentoStatus || ""))
        || orderPixExpiredByClock(pedido, existingAttempt)) {
        let existingAccessToken = "";
        try {
          ({ accessToken: existingAccessToken } = await configuracaoComToken(cfgPublica.estabelecimentoId));
        } catch {}
        const expiration = await expirarPixPedidoSeNecessario({
          pedido,
          attempt: existingAttempt,
          accessToken: existingAccessToken,
          correlationId: req.correlationId,
          consultarRemoto: Boolean(existingAccessToken),
        });
        if (expiration.expired || String(expiration.pedido?.pagamentoStatus || pedido.pagamentoStatus) === "expirado") {
          return res.json({
            success: true,
            expirado: true,
            status: String(expiration.pedido?.mercadoPagoStatus || "expired"),
            expiraEm: expiration.pedido?.pixExpiraEm || pedido.pixExpiraEm,
            valorPix,
            pagamentoCombinado,
            message: "Este QR Code Pix expirou e o cancelamento foi confirmado. O pedido pode ser arquivado pela loja.",
          });
        }
        return res.json({
          success: true,
          expiracaoPendente: true,
          status: String(expiration.pedido?.mercadoPagoStatus || pedido.mercadoPagoStatus || "pending"),
          expiraEm: expiration.pedido?.pixExpiraEm || pedido.pixExpiraEm,
          valorPix,
          pagamentoCombinado,
          message: "O prazo de 10 minutos terminou. Estamos confirmando o cancelamento do Pix antes de liberar o arquivamento.",
        });
      }
      if (pedido.pixCopiaCola) {
        return res.json({
          success: true,
          copiaCola: pedido.pixCopiaCola,
          qrCodeBase64: pedido.pixQrCodeBase64,
          status: pedido.mercadoPagoStatus || "pending",
          expiraEm: pedido.pixExpiraEm,
          valorPix,
          pagamentoCombinado,
        });
      }
    }
    const { cfg: cfgPrivada, accessToken } = await configuracaoComToken(cfgPublica.estabelecimentoId);
    const platformFeeConfig = getCurrentPlatformFeeConfig();
    const sellerUserId = String(cfgPrivada.mercadoPago.userId || "");
    const platformUserId = String(process.env.MERCADO_PAGO_PLATFORM_USER_ID || "");
    appLogger.info("mercado_pago_order_token_diagnostic", {
      operation: "create_order_pix",
      tokenSource: "oauth_estabelecimento",
      sellerUserIdSuffix: idSuffix(sellerUserId),
      platformUserIdSuffix: idSuffix(platformUserId),
      sellerMatchesPlatform: sameMercadoPagoAccount(sellerUserId, platformUserId),
      platformFeeEnabled: platformFeeConfig.enabled,
      accessTokenPresent: Boolean(accessToken),
    });
    if (platformFeeConfig.enabled) {
      assertMarketplaceSellerAccount(sellerUserId);
      await requirePlatformFeeAcceptance(cfgPublica.estabelecimentoId);
    }
    const feeSnapshot = buildPlatformFeeSnapshot(valorPix);
    const attempt = await activeOrderPaymentAttempt({
      pedido,
      collectorId: cfgPrivada.mercadoPago.userId,
      feeSnapshot,
      expectedAmount: valorPix,
    });
    const payerEmail = getPixTechnicalPayerEmail();

    const data = await mp("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": attempt.idempotencyKey },
      body: JSON.stringify({
        transaction_amount: valorPix,
        ...(platformFeeConfig.enabled && Number(attempt.platformFeeCents || 0) > 0
          ? { application_fee: centsToDecimal(attempt.platformFeeCents) }
          : {}),
        description: `Pedido ${String(pedido.codigoPublico || pedido._id).slice(pedido.codigoPublico ? 0 : -6).toUpperCase()} - ${cfgPublica.nomeEstabelecimento}`,
        payment_method_id: "pix",
        external_reference: attempt.externalReference,
        notification_url: mercadoPagoWebhookUrl(req),
        // A janela comercial continua sendo 10 minutos (attempt.expiresAt).
        // O provedor recebe a menor expiração Pix aceita por sua API e o
        // ComandaFacil solicita cancelamento remoto ao fim dos 10 minutos.
        date_of_expiration: providerPixExpirationDate().toISOString(),
        payer: { email: payerEmail, first_name: pedido.cliente || "Cliente" },
      }),
    }, accessToken);
    if (!data.id) throw new Error("Resposta de pagamento inválida.");
    validatePaymentIdentity(data, {
      paymentId: data.id,
      amount: valorPix,
      externalReference: attempt.externalReference,
      collectorId: attempt.expectedCollectorId,
    });

    attempt.paymentId = String(data.id);
    attempt.status = String(data.status || "pending");
    const requestedExpiration = effectiveAttemptExpiration(attempt)
      || new Date(Date.now() + ORDER_PIX_EXPIRATION_MS);
    const providerExpiration = data.date_of_expiration
      ? new Date(data.date_of_expiration)
      : null;
    attempt.expiresAt = providerExpiration
      && !Number.isNaN(providerExpiration.getTime())
      && providerExpiration < requestedExpiration
        ? providerExpiration
        : requestedExpiration;
    attempt.lastCheckedAt = new Date();
    await attempt.save();

    if (!pagamentoCombinado) {
      pedido.formaPagamento = "pix_online";
      if (!Array.isArray(pedido.pagamentos) || !pedido.pagamentos.length) {
        pedido.pagamentos = [{
          formaPagamento: "pix_online",
          valorCentavos: valorPixCentavos,
        }];
      }
    }
    pedido.mercadoPagoPaymentId = String(data.id);
    pedido.mercadoPagoStatus = String(data.status || "pending");
    pedido.pixCopiaCola = data.point_of_interaction?.transaction_data?.qr_code || "";
    pedido.pixQrCodeBase64 = data.point_of_interaction?.transaction_data?.qr_code_base64 || "";
    pedido.pixExpiraEm = attempt.expiresAt;
    pedido.pixExpiradoEm = null;
    pedido.pixExpiracaoStatusRemoto = "";
    pedido.pixExpiracaoUltimaTentativaEm = null;
    pedido.pixExpiracaoErro = "";
    pedido.platformFeePercent = attempt.platformFeePercent;
    pedido.platformFeeCents = attempt.platformFeeCents;
    pedido.platformFeeStatus = attempt.platformFeeStatus || (platformFeeConfig.enabled ? "requested" : "not_applied");
    pedido.platformFeeTermsVersion = attempt.platformFeeTermsVersion;
    pedido.platformFeeCalculatedAt = attempt.platformFeeCalculatedAt;
    pedido.grossAmountCents = attempt.grossAmountCents;
    pedido.merchantAmountBeforeMpFeesCents = attempt.merchantAmountBeforeMpFeesCents;
    pedido.platformFeeReversedCents = 0;
    pedido.platformFeeNetCents = 0;
    await pedido.save();

    return res.status(201).json({
      success: true,
      status: data.status,
      copiaCola: pedido.pixCopiaCola,
      qrCodeBase64: pedido.pixQrCodeBase64,
      expiraEm: pedido.pixExpiraEm,
      valorPix,
      valorPixCentavos,
      pagamentoCombinado,
    });
  } catch (error) {
    appLogger.error("Pix do pedido:", sanitizeMercadoPagoError(error));
    const status = Number(error?.httpStatus || 400);
    if (error?.code === "PLATFORM_FEE_TERMS_REQUIRED") {
      return res.status(status).json({
        success: false,
        code: error.code,
        message: "Pix online temporariamente indisponível. A loja precisa aceitar os termos dos pagamentos online.",
      });
    }
    if (error?.code === "PIX_PAYER_EMAIL_NOT_CONFIGURED") {
      return res.status(503).json({
        success: false,
        code: error.code,
        message: "Pix online temporariamente indisponível. A loja precisa concluir a configuração do pagamento.",
      });
    }
    const providerCauses = Array.isArray(error?.providerCauses)
      ? error.providerCauses
      : Array.isArray(error?.details?.providerCauses)
        ? error.details.providerCauses
        : [];
    if (providerCauses.some(cause => String(cause?.code) === "2059")) {
      return res.status(503).json({
        success: false,
        code: "PLATFORM_FEE_NOT_AVAILABLE",
        message: "Pix online com taxa de serviço ainda não está habilitado para esta conexão Mercado Pago.",
      });
    }
    return res.status(status >= 400 && status < 500 ? status : 502).json({
      success: false,
      code: String(error?.code || "PIX_PAYMENT_CREATE_FAILED"),
      message: "Não foi possível gerar o pagamento Pix.",
    });
  }
};

exports.statusPagamentoPedido = async (req, res) => {
  const token = extrairBearerToken(req);
  if (!token) {
    return res.status(404).json({
      success: false,
      message: "Pedido não encontrado.",
    });
  }
  const cfg = await Configuracao.findOne({ slug: req.params.slug }).lean();
  if (!cfg) return res.status(404).json({ success: false, message: "Estabelecimento não encontrado." });
  const pedido = await buscarPedidoPorToken({
    estabelecimentoId: cfg.estabelecimentoId,
    token,
    lean: false,
  });
  if (!pedido) return res.status(404).json({ success: false, message: "Pedido não encontrado." });
  const cooldownPassed = !pedido.mercadoPagoLastCheckedAt
    || Date.now() - new Date(pedido.mercadoPagoLastCheckedAt).getTime() >= 2_500;
  const expirationDue = orderPixExpiredByClock(pedido, null);
  if (["pendente", "expiracao_pendente"].includes(String(pedido.pagamentoStatus || ""))
    && pedido.mercadoPagoPaymentId
    && (cooldownPassed || expirationDue)) {
    const claimed = await Pedido.findOneAndUpdate({
      _id: pedido._id,
      estabelecimentoId: cfg.estabelecimentoId,
      pagamentoStatus: { $in: ["pendente", "expiracao_pendente"] },
      $or: [
        { mercadoPagoCheckLockedUntil: null },
        { mercadoPagoCheckLockedUntil: { $lt: new Date() } },
      ],
    }, { $set: {
      mercadoPagoCheckLockedUntil: new Date(Date.now() + 5_000),
      mercadoPagoLastCheckedAt: new Date(),
    } }, { returnDocument: "after" });
    if (claimed) {
      try {
        const { cfg: privateConfig, accessToken } = await configuracaoComToken(cfg.estabelecimentoId);
        let attempt = await OrderPaymentAttempt.findOne({
          estabelecimentoId: cfg.estabelecimentoId,
          pedidoId: claimed._id,
          paymentId: claimed.mercadoPagoPaymentId,
        }).sort({ createdAt: -1 });
        if (!attempt) {
          attempt = await OrderPaymentAttempt.create({
            publicReference: crypto.randomUUID(),
            externalReference: `pedido:${claimed._id}`,
            estabelecimentoId: cfg.estabelecimentoId,
            pedidoId: claimed._id,
            paymentId: claimed.mercadoPagoPaymentId,
            expectedCollectorId: String(privateConfig.mercadoPago.userId),
            expectedAmount: valorPixOnlinePedidoCentavos(claimed) / 100,
            currency: "BRL",
            status: String(claimed.mercadoPagoStatus || "pending"),
            paymentMethod: "pix",
            idempotencyKey: `legacy-${crypto.randomUUID()}`,
            expiresAt: claimed.pixExpiraEm
              || new Date(new Date(claimed.createdAt || Date.now()).getTime() + ORDER_PIX_EXPIRATION_MS),
            legacyReference: true,
          });
        }
        if (orderPixExpiredByClock(claimed, attempt)) {
          await expirarPixPedidoSeNecessario({
            pedido: claimed,
            attempt,
            accessToken,
            correlationId: req.correlationId,
            consultarRemoto: true,
          });
        } else {
          const payment = await mp(`/v1/payments/${encodeURIComponent(claimed.mercadoPagoPaymentId)}`, {}, accessToken);
          await applyOrderPayment(claimed, payment, attempt, "status_fallback", req.correlationId);
        }
      } finally {
        await Pedido.updateOne({ _id: pedido._id }, { $set: { mercadoPagoCheckLockedUntil: null } });
      }
    }
  }
  const current = await Pedido.findById(pedido._id)
    .select("pagamentoStatus pagoEm mercadoPagoStatus formaPagamento pagamentos pixExpiraEm pixExpiradoEm pixExpiracaoStatusRemoto pixExpiracaoErro")
    .lean();
  const statusPix = current?.mercadoPagoStatus || pedido.mercadoPagoStatus || "pending";
  const pagamentoCombinado = String(
    current?.formaPagamento || pedido.formaPagamento || "",
  ) === "combinado";
  const currentPaymentStatus = current?.pagamentoStatus || pedido.pagamentoStatus;
  const expiration = current?.pixExpiraEm || pedido.pixExpiraEm || null;
  const expirationTime = expiration ? new Date(expiration).getTime() : NaN;
  return res.json({
    success: true,
    pagamentoStatus: currentPaymentStatus,
    status: statusPix,
    pixAprovado: statusPix === "approved" && currentPaymentStatus === "pago",
    pixExpirado: currentPaymentStatus === "expirado",
    pixExpiracaoPendente: currentPaymentStatus === "expiracao_pendente",
    expiraEm: expiration,
    expiradoEm: current?.pixExpiradoEm || null,
    segundosRestantes: Number.isFinite(expirationTime)
      ? Math.max(0, Math.ceil((expirationTime - Date.now()) / 1000))
      : null,
    pagamentoCombinado,
    aguardandoPagamentoRestante:
      pagamentoCombinado
      && statusPix === "approved"
      && currentPaymentStatus !== "pago"
      && currentPaymentStatus !== "expirado"
      && currentPaymentStatus !== "expiracao_pendente",
    pagoEm: current?.pagoEm || null,
  });
};

function webhookPayloadError(code, message) {
  const error = new Error(message);
  error.name = "MercadoPagoWebhookPayloadError";
  error.code = code;
  error.stage = "webhook_event_extract";
  error.httpStatus = 400;
  return error;
}

function webhookScalar(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === null || candidate === undefined) return "";
  return String(candidate).trim();
}

function extractMercadoPagoWebhookEvent(req) {
  const typeCandidates = [
    req.body?.type,
    req.body?.topic,
    req.query?.type,
    req.query?.topic,
  ].map(webhookScalar).filter(Boolean);
  const normalizedTypes = typeCandidates.map(value => (
    value === "preapproval" ? "subscription_preapproval" : value
  ));
  if (new Set(normalizedTypes).size > 1) {
    throw webhookPayloadError("WEBHOOK_EVENT_TYPE_DIVERGENT", "Tipo de recurso divergente.");
  }
  const resourceType = normalizedTypes[0] || "";

  // A assinatura oficial do Mercado Pago usa exclusivamente o parâmetro
  // query `data.id`. O `body.id` da notificação pode identificar o evento
  // e, portanto, não deve ser comparado com o ID do pagamento.
  const signedQueryId = webhookScalar(req.query?.["data.id"]);
  const bodyDataId = webhookScalar(req.body?.data?.id);
  if (signedQueryId && bodyDataId && signedQueryId !== bodyDataId) {
    throw webhookPayloadError("WEBHOOK_RESOURCE_ID_DIVERGENT", "Identificador de recurso divergente.");
  }
  const legacyQueryId = webhookScalar(req.query?.id);
  const legacyBodyId = webhookScalar(req.body?.id);
  const resourceId = signedQueryId || bodyDataId || legacyQueryId || legacyBodyId;
  const eventAction = webhookScalar(req.body?.action || req.query?.action || resourceType);
  if (!resourceId) {
    throw webhookPayloadError("WEBHOOK_RESOURCE_ID_MISSING", "Identificador do recurso ausente.");
  }
  if (!["payment", "subscription_preapproval"].includes(resourceType)) {
    throw webhookPayloadError("WEBHOOK_EVENT_TYPE_UNSUPPORTED", "Tipo de evento não suportado.");
  }
  if (!eventAction || eventAction.length > 120) {
    throw webhookPayloadError("WEBHOOK_EVENT_ACTION_INVALID", "Ação do evento inválida.");
  }
  return {
    resourceId,
    // A assinatura HMAC deve usar exclusivamente data.id da query quando presente.
    // body.data.id e campos legados continuam disponíveis apenas para localizar o recurso.
    signatureResourceId: signedQueryId || "",
    eventType: resourceType,
    eventAction,
    resourceType,
    action: eventAction,
  };
}

const eventData = extractMercadoPagoWebhookEvent;

function webhookDiagnostic(error, req, data = {}, context = {}) {
  const sanitized = sanitizeMercadoPagoError(error);
  const resourceId = String(data.resourceId || "");
  return {
    correlationId: String(req?.correlationId || "") || null,
    operation: "mercado_pago_webhook",
    stage: sanitized.stage || String(context.stage || "webhook_unknown"),
    method: String(req?.method || "POST").slice(0, 10),
    path: String(req?.path || req?.originalUrl || "/webhook/mercado-pago").split("?")[0].slice(0, 200),
    eventType: String(data.eventType || data.resourceType || "").slice(0, 80) || null,
    eventAction: String(data.eventAction || data.action || "").slice(0, 120) || null,
    resourceIdSuffix: resourceId.slice(-8) || null,
    signaturePresent: Boolean(req?.get?.("x-signature")),
    requestIdPresent: Boolean(req?.get?.("x-request-id")),
    signatureValid: Boolean(context.signatureValid),
    httpStatus: sanitized.status,
    responseStatus: Number(context.responseStatus || 0) || null,
    providerCode: sanitized.providerCode,
    providerMessage: sanitized.providerMessage,
    providerCauses: sanitized.providerCauses,
    responseReceived: sanitized.responseReceived,
    timeout: sanitized.timeout,
    errorName: sanitized.errorName,
    errorMessage: sanitized.message,
    causeName: sanitized.causeName,
  };
}

function webhookEventKey({
  resourceType,
  resourceId,
  action,
  financialStatus,
  effectiveAt,
}) {
  return crypto.createHash("sha256")
    .update([
      resourceType,
      resourceId,
      action,
      financialStatus || "",
      effectiveAt ? new Date(effectiveAt).toISOString() : "",
    ].join(":"))
    .digest("hex");
}

function financialEffectiveDate(resource) {
  const raw = resource.date_last_updated
    || resource.date_approved
    || resource.date_created
    || resource.last_modified;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date : new Date(0);
}

function financialEventShouldApply({
  effectiveAt,
  lastFinancialAt,
  status,
  paymentId,
  lastApprovedPaymentId,
}) {
  const current = lastFinancialAt ? new Date(lastFinancialAt) : null;
  if (current && new Date(effectiveAt) < current) return false;
  return !(
    ["refunded", "charged_back", "cancelled", "rejected"].includes(status)
    && lastApprovedPaymentId
    && String(paymentId) !== String(lastApprovedPaymentId)
  );
}

function assertStockCompleted(result) {
  if (result?.success
    && ["concluido", "ja_concluido"].includes(result.status)) return result;
  const error = new Error("Movimentação de estoque pendente.");
  error.code = result?.errorCode || "ESTOQUE_PENDENTE";
  error.retryable = result?.retryable !== false;
  throw error;
}

function assertStockRestored(result) {
  if (result?.success
    && ["restaurado", "ja_restaurado", "nao_baixado"].includes(result.status)) return result;
  const error = new Error("Restauração de estoque pendente.");
  error.code = result?.errorCode || "ESTOQUE_RESTAURACAO_PENDENTE";
  error.retryable = result?.retryable !== false;
  throw error;
}

async function claimEvent(eventDocument) {
  const staleAt = new Date(Date.now() - 5 * 60_000);
  return PaymentEvent.findOneAndUpdate(
    {
      _id: eventDocument._id,
      $or: [
        { status: { $in: ["recebido", "falhou"] } },
        { status: "processando", processandoEm: { $lt: staleAt } },
        { status: "processando", processandoEm: null },
      ],
    },
    {
      $set: { status: "processando", processandoEm: new Date(), erro: "" },
      $inc: { tentativas: 1 },
    },
    { returnDocument: "after" },
  );
}

async function processApprovedOrderPayment({
  pedido,
  payment,
  attempt = null,
  confirmationSource = "webhook",
  correlationId = "",
}) {
  const startedAt = Date.now();
  const approvedAt = payment.date_approved
    ? new Date(payment.date_approved)
    : new Date();
  const feeApplied = Number(attempt?.platformFeeCents || 0) > 0
    && hasOfficialPlatformFeeEvidence(payment, attempt);
  const feeStatus = Number(attempt?.platformFeeCents || 0) <= 0
    ? "not_applied"
    : feeApplied ? "applied" : "reconciliation_required";
  const pixAmount = Number(
    attempt?.expectedAmount
    ?? payment?.transaction_amount
    ?? pedido.total,
  );
  const pixAmountCents = Math.round(pixAmount * 100);
  const totalOrderCents = Math.round(Number(pedido.total || 0) * 100);
  const partialCombinedPayment = String(pedido.formaPagamento || "") === "combinado"
    && pedidoTemPixOnline(pedido)
    && Number.isSafeInteger(pixAmountCents)
    && pixAmountCents > 0
    && pixAmountCents < totalOrderCents;

  if (pedido.status === "cancelado") {
    await Pedido.updateOne({
      _id: pedido._id,
      estabelecimentoId: pedido.estabelecimentoId,
    }, { $set: {
      pagamentoInconsistente: true,
      pagamentoInconsistencia: "Pagamento aprovado após cancelamento do pedido.",
      mercadoPagoStatus: "approved",
    } });
    return { pedido, stateTransitionApplied: false, jobs: [] };
  }

  assertStockCompleted(await baixarEstoqueDoPedido(pedido._id));

  if (partialCombinedPayment) {
    const transitioned = await Pedido.findOneAndUpdate({
      _id: pedido._id,
      estabelecimentoId: pedido.estabelecimentoId,
      status: { $ne: "cancelado" },
      $or: [
        { mercadoPagoStatus: { $ne: "approved" } },
        { mercadoPagoPaymentId: { $ne: String(payment.id) } },
      ],
    }, { $set: {
      mercadoPagoPaymentId: String(payment.id),
      mercadoPagoStatus: "approved",
      pagamentoInformadoEm: approvedAt,
      platformFeeStatus: feeStatus,
      platformFeeNetCents: feeApplied ? attempt.platformFeeCents : 0,
    } }, { returnDocument: "after" });

    let jobs = [];
    if (transitioned) {
      await Pedido.updateOne({ _id: transitioned._id }, { $push: {
        historicoFinanceiro: {
          paymentId: String(payment.id),
          status: "approved",
          tipo: "pix_parcial_aprovado",
          statusAnterior: "pendente",
          statusNovo: "pendente",
          formaPagamento: "pix_online",
          pagamentos: [{
            formaPagamento: "pix_online",
            valorCentavos: pixAmountCents,
          }],
          valor: pixAmount,
          motivo: "Parte Pix do pagamento combinado aprovada.",
          operationKey: `pix_parcial:${payment.id}`,
          registradoEm: new Date(),
        },
      } });
      jobs = await printQueueService.criarJobsAutomaticos(transitioned);
    }

    const current = transitioned || await Pedido.findOne({
      _id: pedido._id,
      estabelecimentoId: pedido.estabelecimentoId,
    });
    appLogger.info("order_pix_confirmation", {
      operation: "order_pix_confirmation",
      stage: "partial_approved_processed",
      orderIdSuffix: String(pedido._id).slice(-6),
      paymentIdSuffix: String(payment.id).slice(-8),
      paymentStatus: "approved_partial",
      feeStatus,
      platformFeeCents: Number(attempt?.platformFeeCents || 0),
      stateTransitionApplied: Boolean(transitioned),
      printJobCreated: jobs.length > 0,
      printJobDeduplicated: Boolean(transitioned) && jobs.length === 0,
      confirmationSource,
      durationMs: Date.now() - startedAt,
      correlationId: String(correlationId || "").slice(0, 100),
    });
    return { pedido: current, stateTransitionApplied: Boolean(transitioned), jobs };
  }

  const transitioned = await Pedido.findOneAndUpdate({
    _id: pedido._id,
    estabelecimentoId: pedido.estabelecimentoId,
    pagamentoStatus: { $ne: "pago" },
    status: { $ne: "cancelado" },
  }, { $set: {
    pagamentoStatus: "pago",
    pagoEm: approvedAt,
    mercadoPagoPaymentId: String(payment.id),
    mercadoPagoStatus: "approved",
    formaPagamento: "pix_online",
    platformFeeStatus: feeStatus,
    platformFeeNetCents: feeApplied ? attempt.platformFeeCents : 0,
  } }, { returnDocument: "after" });

  let jobs = [];
  if (transitioned) {
    await Pedido.updateOne({ _id: transitioned._id }, { $push: {
      historicoFinanceiro: {
        paymentId: String(payment.id),
        status: "approved",
        tipo: "pix_online_aprovado",
        statusAnterior: "pendente",
        statusNovo: "pago",
        formaPagamento: "pix_online",
        pagamentos: [{
          formaPagamento: "pix_online",
          valorCentavos: pixAmountCents,
        }],
        valor: pixAmount,
        operationKey: `pix_aprovado:${payment.id}`,
        registradoEm: new Date(),
      },
    } });
    jobs = await printQueueService.criarJobsAutomaticos(transitioned);
  }
  const current = transitioned || await Pedido.findOne({
    _id: pedido._id,
    estabelecimentoId: pedido.estabelecimentoId,
  });
  appLogger.info("order_pix_confirmation", {
    operation: "order_pix_confirmation",
    stage: "approved_processed",
    orderIdSuffix: String(pedido._id).slice(-6),
    paymentIdSuffix: String(payment.id).slice(-8),
    paymentStatus: "approved",
    feeStatus,
    platformFeeCents: Number(attempt?.platformFeeCents || 0),
    stateTransitionApplied: Boolean(transitioned),
    printJobCreated: jobs.length > 0,
    printJobDeduplicated: Boolean(transitioned) && jobs.length === 0,
    confirmationSource,
    durationMs: Date.now() - startedAt,
    correlationId: String(correlationId || "").slice(0, 100),
  });
  return { pedido: current, stateTransitionApplied: Boolean(transitioned), jobs };
}

async function applyOrderPayment(
  pedido,
  payment,
  attempt = null,
  confirmationSource = "webhook",
  correlationId = "",
) {
  const { cfg, accessToken } = await configuracaoComToken(pedido.estabelecimentoId);
  const expectedReference = attempt?.externalReference || `pedido:${pedido._id}`;
  if (attempt) {
    if (String(attempt.estabelecimentoId) !== String(pedido.estabelecimentoId)
      || String(attempt.pedidoId) !== String(pedido._id)) {
      throw new Error("Tentativa de pagamento não pertence ao pedido e estabelecimento esperados.");
    }
    if (!attempt.legacyReference && !isOpaqueOrderReference(attempt.externalReference)) {
      throw new Error("Referência opaca da tentativa é inválida.");
    }
  }
  validatePaymentIdentity(payment, {
    paymentId: attempt?.paymentId || pedido.mercadoPagoPaymentId,
    amount: attempt?.expectedAmount ?? pedido.total,
    externalReference: expectedReference,
    collectorId: attempt?.expectedCollectorId || cfg.mercadoPago.userId,
  });
  if (payment.currency_id && String(payment.currency_id) !== String(attempt?.currency || "BRL")) {
    throw new Error("Moeda do pagamento divergente.");
  }
  const paymentStatus = String(payment.status || "").trim().toLowerCase();
  if (paymentStatus === "approved" && orderPixApprovedAfterExpiration(payment, attempt, pedido)) {
    const lateApproval = await registrarAprovacaoPixAposExpiracao({
      pedido,
      payment,
      attempt,
      correlationId,
    });
    return lateApproval.pedido || pedido;
  }
  if (paymentStatus !== "approved"
    && (isRemoteTerminalUnpaidStatus(paymentStatus) || orderPixExpiredByClock(pedido, attempt))) {
    let remoteStatus = paymentStatus;
    let terminalPayment = payment;

    if (["pending", "in_process", "authorized"].includes(paymentStatus)) {
      const cancelled = await cancelarPixPendenteRemoto(
        attempt?.paymentId || pedido.mercadoPagoPaymentId || payment.id,
        accessToken,
      );
      if (cancelled?.status) {
        terminalPayment = cancelled;
        remoteStatus = String(cancelled.status).toLowerCase();
      } else {
        const pending = await markOrderPixExpirationPending({
          pedido,
          attempt,
          now: new Date(),
          remoteStatus: paymentStatus,
          reason: "O prazo local terminou, mas o cancelamento remoto ainda não foi confirmado.",
        });
        appLogger.warn("order_pix_expiration_pending_from_payment_status", {
          pedidoIdSuffix: idSuffix(pedido._id),
          paymentIdSuffix: idSuffix(payment.id),
          providerStatus: paymentStatus || null,
          confirmationSource,
          correlationId: String(correlationId || "").slice(0, 100) || null,
        });
        return pending.pedido || pedido;
      }
    }

    if (remoteStatus === "approved") {
      return applyOrderPayment(
        pedido,
        terminalPayment,
        attempt,
        `${confirmationSource}_expiration_race`,
        correlationId,
      );
    }

    if (!isRemoteTerminalUnpaidStatus(remoteStatus)) {
      const pending = await markOrderPixExpirationPending({
        pedido,
        attempt,
        now: new Date(),
        remoteStatus,
        reason: "O provedor ainda não retornou um estado terminal para a expiração do Pix.",
      });
      return pending.pedido || pedido;
    }

    const expired = await markOrderPixExpired({
      pedido,
      attempt,
      now: new Date(),
      remoteStatus,
    });
    appLogger.info("order_pix_expired_from_payment_status", {
      pedidoIdSuffix: idSuffix(pedido._id),
      paymentIdSuffix: idSuffix(payment.id),
      providerStatus: paymentStatus || null,
      remoteStatus: remoteStatus || null,
      confirmationSource,
      correlationId: String(correlationId || "").slice(0, 100) || null,
    });
    return expired.pedido || pedido;
  }
  pedido.mercadoPagoStatus = String(payment.status || "");
  const alreadyRecorded = pedido.historicoFinanceiro.some(item =>
    String(item.paymentId) === String(payment.id) && String(item.status) === String(payment.status));
  if (!alreadyRecorded) pedido.historicoFinanceiro.push({
    paymentId: String(payment.id), status: String(payment.status || ""), registradoEm: new Date(),
  });

  if (payment.status === "approved") {
    validateApprovedPayment(payment, {
      paymentId: attempt?.paymentId || pedido.mercadoPagoPaymentId,
      amount: attempt?.expectedAmount ?? pedido.total,
      externalReference: expectedReference,
      collectorId: attempt?.expectedCollectorId || cfg.mercadoPago.userId,
    });
    const approved = await processApprovedOrderPayment({
      pedido,
      payment,
      attempt,
      confirmationSource,
      correlationId,
    });
    pedido = approved.pedido || pedido;
  } else if (["cancelled", "rejected", "refunded", "charged_back"].includes(payment.status)) {
    assertStockRestored(await restaurarEstoqueDoPedido(pedido._id));
    pedido.pagamentoStatus = "cancelado";
    if (["refunded", "charged_back"].includes(payment.status)
      && Number(attempt?.platformFeeCents || 0) > 0) {
      const refundedCents = Math.round(Number(payment.transaction_amount_refunded || 0) * 100);
      const fullReversal = payment.status === "charged_back"
        || refundedCents >= Number(attempt.grossAmountCents || 0);
      pedido.platformFeeStatus = fullReversal ? "reversed" : "reconciliation_required";
      pedido.platformFeeReversedCents = fullReversal
        ? Number(attempt.platformFeeCents)
        : 0;
      pedido.platformFeeNetCents = fullReversal ? 0 : Number(attempt.platformFeeCents);
      attempt.platformFeeStatus = pedido.platformFeeStatus;
      attempt.platformFeeReversedCents = pedido.platformFeeReversedCents;
      attempt.platformFeeNetCents = pedido.platformFeeNetCents;
    } else {
      pedido.platformFeeStatus = "not_applied";
      pedido.platformFeeNetCents = 0;
      if (attempt) {
        attempt.platformFeeStatus = "not_applied";
        attempt.platformFeeNetCents = 0;
      }
    }
  }
  if (payment.status !== "approved") await pedido.save();
  if (attempt) {
    attempt.status = String(payment.status || attempt.status);
    attempt.lastCheckedAt = new Date();
    if (payment.status === "approved") {
      attempt.processedAt = attempt.processedAt || new Date();
      attempt.reconciliationStatus = "processed";
      const feeApplied = Number(attempt.platformFeeCents || 0) > 0
        && hasOfficialPlatformFeeEvidence(payment, attempt);
      attempt.platformFeeStatus = Number(attempt.platformFeeCents || 0) <= 0
        ? "not_applied"
        : feeApplied ? "applied" : "reconciliation_required";
      attempt.platformFeeNetCents = feeApplied ? attempt.platformFeeCents : 0;
    }
    await attempt.save();
  }
  return pedido;
}

async function processOrderPayment(event, pedido, payment, attempt = null) {
  event.estabelecimentoId = pedido.estabelecimentoId;
  event.pedidoId = pedido._id;
  if (attempt && event.eventKey && !attempt.webhookEvents.includes(event.eventKey)) {
    attempt.webhookEvents.push(event.eventKey);
  }
  return applyOrderPayment(pedido, payment, attempt, "webhook", event?.requestId);
}

function parseSubscriptionReference(value) {
  const attempt = /^assinatura-tentativa:([0-9a-f-]{36}):estabelecimento:([a-f0-9]{24})$/i
    .exec(String(value || ""));
  if (attempt) {
    return { attemptId: attempt[1], estabelecimentoId: attempt[2] };
  }
  const match = /^assinatura:([a-f0-9]{24}):estabelecimento:([a-f0-9]{24})$/i
    .exec(String(value || ""));
  return match ? { assinaturaId: match[1], estabelecimentoId: match[2] } : null;
}

async function processSubscriptionPayment(event, payment) {
  const reference = parseSubscriptionReference(payment.external_reference);
  if (!reference) throw new Error("Referência de assinatura inválida.");
  const attempt = reference.attemptId
    ? await AssinaturaTentativa.findOne({
      attemptId: reference.attemptId,
      estabelecimentoId: reference.estabelecimentoId,
    })
    : null;
  const assinatura = await Assinatura.findOne({
    _id: attempt?.assinaturaId || reference.assinaturaId,
    estabelecimentoId: reference.estabelecimentoId,
  });
  if (!assinatura) throw new Error("Assinatura não encontrada.");

  let isCurrentPix = attempt
    ? String(attempt.mercadoPagoPaymentId) === String(payment.id)
    : String(assinatura.mercadoPagoPaymentId) === String(payment.id);

  if (attempt
    && attempt.metodo === "pix"
    && !String(attempt.mercadoPagoPaymentId || "").trim()
    && payment?.id) {
    validatePaymentIdentity(payment, {
      paymentId: payment.id,
      amount: Number(attempt.valorCentavos || 0) / 100,
      externalReference: attemptReference(attempt),
      collectorId: platformCollectorId(),
    });
    attempt.mercadoPagoPaymentId = String(payment.id);
    attempt.lastRemoteStatus = String(payment.status || "");
    attempt.lastRemoteCheckedAt = new Date();
    await attempt.save();
    if (!String(assinatura.mercadoPagoPaymentId || "").trim()) {
      assinatura.mercadoPagoPaymentId = String(payment.id);
      assinatura.mercadoPagoPaymentCriadoEm = assinatura.mercadoPagoPaymentCriadoEm || new Date();
    }
    isCurrentPix = true;
    appLogger.info("mercado_pago_subscription_webhook_race_recovered", {
      estabelecimentoIdSuffix: idSuffix(assinatura.estabelecimentoId),
      paymentIdSuffix: idSuffix(payment.id),
      attemptIdSuffix: idSuffix(attempt.attemptId),
      paymentStatus: String(payment.status || "").slice(0, 40) || null,
    });
  }

  const paymentPreapprovalId = String(
    payment.preapproval_id || payment.metadata?.preapproval_id || "",
  );
  const isCurrentRecurring = paymentPreapprovalId && paymentPreapprovalId === String(
    attempt?.mercadoPagoPreapprovalId || assinatura.mercadoPagoPreapprovalId,
  );
  if (!isCurrentPix && !isCurrentRecurring) {
    throw new Error("Pagamento não pertence à tentativa vigente.");
  }
  validatePaymentIdentity(payment, {
    paymentId: payment.id,
    amount: attempt ? Number(attempt.valorCentavos || 0) / 100 : valorPlano(),
    externalReference: attempt ? attemptReference(attempt) : subscriptionReference(assinatura),
    collectorId: platformCollectorId(),
    preapprovalId: isCurrentRecurring
      ? (attempt?.mercadoPagoPreapprovalId || assinatura.mercadoPagoPreapprovalId)
      : undefined,
  });
  const approvedAt = payment.status === "approved" && payment.date_approved
    ? new Date(payment.date_approved)
    : null;
  const approvedBeforePixExpiration = Boolean(
    attempt?.metodo === "pix"
    && approvedAt
    && !Number.isNaN(approvedAt.getTime())
    && attempt.expiresAt
    && approvedAt <= new Date(attempt.expiresAt),
  );
  const pixApprovedAfterExpiration = Boolean(
    attempt?.metodo === "pix"
    && payment.status === "approved"
    && attempt.expiresAt
    && (!approvedAt
      || Number.isNaN(approvedAt.getTime())
      || approvedAt > new Date(attempt.expiresAt)),
  );
  const obsoleteAttempt = attempt && !approvedBeforePixExpiration && (pixApprovedAfterExpiration
    || attempt.cancelRequestedAt
    || !attempt.ativa
    || ["expired", "superseded", "cancelled", "failed"].includes(attempt.status));
  if (obsoleteAttempt) {
    if (payment.status === "approved") {
      attempt.status = "reconciliation_required";
      attempt.ativa = false;
      attempt.completedAt = new Date();
      attempt.erro = "Pagamento aprovado para tentativa não vigente; conciliação manual necessária.";
      await attempt.save();
      if (!Array.isArray(assinatura.historicoFinanceiro)) assinatura.historicoFinanceiro = [];
      assinatura.historicoFinanceiro.push({
        paymentId: String(payment.id),
        preapprovalId: paymentPreapprovalId,
        status: "reconciliation_required:approved",
        aprovadoEm: payment.date_approved ? new Date(payment.date_approved) : null,
        registradoEm: new Date(),
      });
      await assinatura.save();
      appLogger.warn("subscription_abandoned_payment_reconciliation", {
        paymentId: String(payment.id),
        attemptId: String(attempt.attemptId),
        estabelecimentoId: String(assinatura.estabelecimentoId),
      });
    }
    event.estabelecimentoId = assinatura.estabelecimentoId;
    event.assinaturaId = assinatura._id;
    return;
  }

  event.estabelecimentoId = assinatura.estabelecimentoId;
  event.assinaturaId = assinatura._id;
  assinatura.ultimoStatusMercadoPago = String(payment.status || "");
  const effectiveAt = financialEffectiveDate(payment);
  const lastFinancialAt = assinatura.ultimoEventoFinanceiroEm
    ? new Date(assinatura.ultimoEventoFinanceiroEm)
    : null;
  if (!financialEventShouldApply({
    effectiveAt,
    lastFinancialAt,
    status: payment.status,
    paymentId: payment.id,
    lastApprovedPaymentId: assinatura.ultimoPagamentoAprovadoId,
  })) {
    assinatura.historicoFinanceiro.push({
      paymentId: String(payment.id),
      preapprovalId: paymentPreapprovalId,
      status: `ignorado_fora_de_ordem:${String(payment.status || "")}`,
      aprovadoEm: payment.date_approved ? new Date(payment.date_approved) : null,
      registradoEm: new Date(),
    });
    await assinatura.save();
    return;
  }

  if (payment.status === "approved") {
    if (String(assinatura.ultimoPagamentoAprovadoId || "") === String(payment.id)) {
      return;
    }
    const paymentApprovedAt = approvedAt || new Date();
    const previousExpiration = assinatura.planoExpira
      ? new Date(assinatura.planoExpira)
      : null;
    const continuedPeriod = previousExpiration
      && !Number.isNaN(previousExpiration.getTime())
      && previousExpiration > paymentApprovedAt;
    const period = paidPeriod(assinatura.planoExpira, paymentApprovedAt);
    assinatura.status = "ativa";
    if (!assinatura.planoInicio || !continuedPeriod) {
      assinatura.planoInicio = paymentApprovedAt;
    }
    assinatura.planoExpira = period.expiresAt;
    assinatura.ultimoPagamentoAprovadoId = String(payment.id);
    assinatura.ultimoPagamentoAprovadoEm = paymentApprovedAt;
    assinatura.proximaCobranca = isCurrentRecurring
      ? assinatura.proximaCobranca
      : null;
  } else {
    assinatura.status = subscriptionStatusForFinancialStatus(
      payment.status,
      assinatura.status,
    );
  }
  assinatura.ultimoEventoFinanceiroEm = effectiveAt;
  assinatura.ultimoEventoFinanceiroKey = event.eventKey || "";
  assinatura.historicoFinanceiro.push({
    paymentId: String(payment.id),
    preapprovalId: paymentPreapprovalId,
    status: String(payment.status || ""),
    aprovadoEm: payment.status === "approved"
      ? (payment.date_approved ? new Date(payment.date_approved) : new Date())
      : null,
    registradoEm: new Date(),
  });
  await assinatura.save();
  if (attempt) {
    attempt.status = payment.status === "approved"
      ? "approved"
      : (["pending", "authorized"].includes(payment.status) ? payment.status : "failed");
    if (["approved", "cancelled", "rejected", "refunded", "charged_back"].includes(payment.status)) {
      attempt.ativa = false;
      attempt.completedAt = new Date();
    }
    await attempt.save();
  }
}

async function processPreapproval(event, preapproval) {
  const reference = parseSubscriptionReference(preapproval.external_reference);
  if (!reference) throw new Error("Referência de assinatura inválida.");
  const attempt = reference.attemptId
    ? await AssinaturaTentativa.findOne({
      attemptId: reference.attemptId,
      estabelecimentoId: reference.estabelecimentoId,
      mercadoPagoPreapprovalId: String(preapproval.id),
    })
    : null;
  const assinatura = await Assinatura.findOne({
    _id: attempt?.assinaturaId || reference.assinaturaId,
    estabelecimentoId: reference.estabelecimentoId,
    ...(attempt ? {} : { mercadoPagoPreapprovalId: String(preapproval.id) }),
  });
  if (!assinatura) throw new Error("Preapproval não pertence à assinatura vigente.");
  if (attempt?.cancelRequestedAt) {
    event.estabelecimentoId = assinatura.estabelecimentoId;
    event.assinaturaId = assinatura._id;
    if (["canceled", "cancelled"].includes(preapproval.status)) {
      attempt.status = SUBSCRIPTION_ATTEMPT_STATUS.CANCELLED;
      attempt.ativa = false;
      attempt.cancelledAt ||= new Date();
      attempt.cancelledBy ||= attempt.estabelecimentoId;
      attempt.completedAt ||= new Date();
      attempt.cancelRequestId = "";
      attempt.remoteCancellationStatus = String(preapproval.status);
      await attempt.save();
    }
    return;
  }
  if (attempt && (!attempt.ativa
    || ["expired", "superseded", "cancelled", "failed"].includes(attempt.status))) {
    event.estabelecimentoId = assinatura.estabelecimentoId;
    event.assinaturaId = assinatura._id;
    return;
  }

  event.estabelecimentoId = assinatura.estabelecimentoId;
  event.assinaturaId = assinatura._id;
  assinatura.ultimoStatusMercadoPago = String(preapproval.status || "");
  assinatura.proximaCobranca = preapproval.next_payment_date
    ? new Date(preapproval.next_payment_date)
    : null;

  if (["canceled", "cancelled"].includes(preapproval.status)) {
    const trialValid = assinatura.fimTeste && new Date(assinatura.fimTeste) > new Date();
    assinatura.status = trialValid ? "teste" : "cancelada";
  } else if (["paused"].includes(preapproval.status) && assinatura.status !== "ativa") {
    assinatura.status = "atrasada";
  }
  // "authorized" confirma apenas autorização; nunca comprova pagamento.
  await assinatura.save();
  if (attempt) {
    attempt.status = ["canceled", "cancelled"].includes(preapproval.status)
      ? SUBSCRIPTION_ATTEMPT_STATUS.CANCELLED
      : String(preapproval.status || attempt.status);
    if (["canceled", "cancelled"].includes(preapproval.status)) {
      attempt.ativa = false;
      attempt.completedAt = new Date();
    }
    await attempt.save();
  }
}

function webhookStage(error, stage, code = "") {
  if (error && typeof error === "object") {
    if (!error.stage) error.stage = stage;
    if (code && !error.code) error.code = code;
  }
  return error;
}

function isArchivedOrderFinancialStatus(status) {
  return ["approved", "refunded", "charged_back"].includes(
    String(status || "").trim().toLowerCase(),
  );
}

function validatePersistedOrderAttemptPayment(payment, attempt, stage) {
  try {
    validatePaymentIdentity(payment, {
      paymentId: attempt.paymentId,
      amount: attempt.expectedAmount,
      externalReference: attempt.externalReference,
      collectorId: attempt.expectedCollectorId,
    });
    if (payment.currency_id && String(payment.currency_id) !== String(attempt.currency || "BRL")) {
      throw new Error("Moeda do pagamento divergente.");
    }
  } catch (error) {
    throw webhookStage(error, stage, "ORDER_PAYMENT_WEBHOOK_INVALID");
  }
}

function appendAttemptWebhookEvent(attempt, event) {
  if (!attempt || !event?.eventKey) return;
  if (!Array.isArray(attempt.webhookEvents)) attempt.webhookEvents = [];
  if (!attempt.webhookEvents.includes(event.eventKey)) {
    attempt.webhookEvents.push(event.eventKey);
  }
}

function archivedOrderReconciliationDetails({ pedido, attempt, payment }) {
  return {
    estabelecimentoIdSuffix: String(attempt.estabelecimentoId || "").slice(-8) || null,
    pedidoIdSuffix: String(pedido?._id || attempt.pedidoId || "").slice(-8) || null,
    paymentIdSuffix: String(payment?.id || attempt.paymentId || "").slice(-8) || null,
    paymentStatus: String(payment?.status || "").slice(0, 40) || null,
    amountCents: Number.isFinite(Number(attempt.expectedAmount))
      ? Math.round(Number(attempt.expectedAmount) * 100)
      : null,
    reconciliationStatus: String(attempt.reconciliationStatus || "").slice(0, 80) || null,
  };
}

async function processArchivedOrderPayment(event, pedido, payment, attempt) {
  event.estabelecimentoId = attempt.estabelecimentoId;
  event.pedidoId = pedido._id;
  appendAttemptWebhookEvent(attempt, event);
  validatePersistedOrderAttemptPayment(
    payment,
    attempt,
    "webhook_archived_order_validation",
  );

  const now = new Date();
  const status = String(payment.status || attempt.status || "").trim().toLowerCase();
  const financialStatus = isArchivedOrderFinancialStatus(status);
  const closedWithoutPayment = ORDER_PIX_TERMINAL_UNPAID_STATUSES.includes(status);

  attempt.status = status || attempt.status;
  attempt.lastCheckedAt = now;
  if (financialStatus) {
    attempt.reconciliationStatus = "reconciliation_required";
    if (Number(attempt.platformFeeCents || 0) > 0) {
      attempt.platformFeeStatus = "reconciliation_required";
      attempt.platformFeeNetCents = 0;
    }
  } else if (closedWithoutPayment) {
    attempt.reconciliationStatus = "processed";
    attempt.processedAt = attempt.processedAt || now;
  }
  await attempt.save();

  pedido.mercadoPagoPaymentId = String(payment.id || pedido.mercadoPagoPaymentId || "");
  pedido.mercadoPagoStatus = status;
  const alreadyRecorded = Array.isArray(pedido.historicoFinanceiro)
    && pedido.historicoFinanceiro.some(item =>
      String(item.paymentId) === String(payment.id)
      && String(item.tipo) === "pix_online_pedido_arquivado"
      && String(item.status) === status);
  if (!alreadyRecorded) {
    if (!Array.isArray(pedido.historicoFinanceiro)) pedido.historicoFinanceiro = [];
    pedido.historicoFinanceiro.push({
      paymentId: String(payment.id || ""),
      status,
      tipo: "pix_online_pedido_arquivado",
      statusAnterior: String(pedido.pagamentoStatus || ""),
      statusNovo: String(pedido.pagamentoStatus || ""),
      formaPagamento: "pix_online",
      pagamentos: [{
        formaPagamento: "pix_online",
        valorCentavos: Math.max(0, Math.round(Number(attempt.expectedAmount || 0) * 100)),
      }],
      valor: Number(attempt.expectedAmount || 0),
      motivo: financialStatus
        ? "Evento financeiro recebido após o pedido ter sido arquivado; conciliação manual necessária."
        : "Atualização do Pix recebida após o pedido ter sido arquivado.",
      operationKey: `pix_arquivado:${String(payment.id || "")}:${status}`,
      registradoEm: now,
    });
  }
  if (financialStatus) {
    pedido.pagamentoInconsistente = true;
    pedido.pagamentoInconsistencia = status === "approved"
      ? "Pagamento Pix aprovado após o pedido ter sido arquivado. Conciliação manual necessária."
      : `Evento financeiro Pix (${status}) recebido após o pedido ter sido arquivado. Conciliação manual necessária.`;
    if (Number(attempt.platformFeeCents || 0) > 0) {
      pedido.platformFeeStatus = "reconciliation_required";
      pedido.platformFeeNetCents = 0;
    }
  }
  await pedido.save();

  const details = archivedOrderReconciliationDetails({ pedido, attempt, payment });
  if (financialStatus) {
    appLogger.error("mercado_pago_archived_order_payment_detected", details);
    operationalAlerts.trigger({
      event: "mercado_pago_archived_order_payment_detected",
      key: `mercado_pago_archived_order_payment_detected:${String(payment.id || attempt.paymentId)}`,
      severity: "critical",
      details,
    });
  } else {
    appLogger.warn("mercado_pago_archived_order_payment_update", details);
  }
}

async function processOrphanedOrderAttemptPayment(event, payment, attempt) {
  event.estabelecimentoId = attempt.estabelecimentoId;
  event.pedidoId = attempt.pedidoId;
  appendAttemptWebhookEvent(attempt, event);
  validatePersistedOrderAttemptPayment(
    payment,
    attempt,
    "webhook_orphaned_order_validation",
  );

  const now = new Date();
  const status = String(payment.status || attempt.status || "").trim().toLowerCase();
  const financialStatus = isArchivedOrderFinancialStatus(status);
  attempt.status = status || attempt.status;
  attempt.lastCheckedAt = now;
  if (financialStatus) {
    attempt.reconciliationStatus = "reconciliation_required";
    if (Number(attempt.platformFeeCents || 0) > 0) {
      attempt.platformFeeStatus = "reconciliation_required";
      attempt.platformFeeNetCents = 0;
    }
  } else if (ORDER_PIX_TERMINAL_UNPAID_STATUSES.includes(status)) {
    attempt.reconciliationStatus = "processed";
    attempt.processedAt = attempt.processedAt || now;
  }
  await attempt.save();

  const details = archivedOrderReconciliationDetails({ pedido: null, attempt, payment });
  if (financialStatus) {
    appLogger.error("mercado_pago_orphaned_order_payment_detected", details);
    operationalAlerts.trigger({
      event: "mercado_pago_orphaned_order_payment_detected",
      key: `mercado_pago_orphaned_order_payment_detected:${String(payment.id || attempt.paymentId)}`,
      severity: "critical",
      details,
    });
  } else {
    appLogger.warn("mercado_pago_orphaned_order_attempt_update", details);
  }
}

async function bindOrderAttemptFromWebhookReference({ attempt, payment, resourceId }) {
  if (!attempt) return null;
  const normalizedResourceId = String(resourceId || payment?.id || "").trim();
  if (!normalizedResourceId) {
    const error = new Error("Pagamento do pedido sem identificador.");
    throw webhookStage(error, "webhook_order_reference_validation", "ORDER_PAYMENT_WEBHOOK_ID_MISSING");
  }

  try {
    validatePaymentIdentity(payment, {
      paymentId: normalizedResourceId,
      amount: attempt.expectedAmount,
      externalReference: attempt.externalReference,
      collectorId: attempt.expectedCollectorId,
    });
    if (payment.currency_id && String(payment.currency_id) !== String(attempt.currency || "BRL")) {
      throw new Error("Moeda do pagamento divergente.");
    }
  } catch (error) {
    throw webhookStage(error, "webhook_order_reference_validation", "ORDER_PAYMENT_WEBHOOK_INVALID");
  }

  if (attempt.paymentId) {
    if (String(attempt.paymentId) !== normalizedResourceId) {
      const error = new Error("Referência do pedido já está vinculada a outro pagamento.");
      throw webhookStage(error, "webhook_order_reference_binding", "ORDER_PAYMENT_BINDING_CONFLICT");
    }
    return attempt;
  }

  const updated = await OrderPaymentAttempt.findOneAndUpdate(
    { _id: attempt._id, paymentId: "" },
    {
      $set: {
        paymentId: normalizedResourceId,
        status: String(payment.status || attempt.status || "pending"),
        lastCheckedAt: new Date(),
      },
    },
    { new: true, runValidators: true },
  );
  if (updated) return updated;

  const current = await OrderPaymentAttempt.findOne({ _id: attempt._id });
  if (current && String(current.paymentId || "") === normalizedResourceId) return current;

  const error = new Error("Não foi possível vincular o pagamento à tentativa do pedido.");
  throw webhookStage(error, "webhook_order_reference_binding", "ORDER_PAYMENT_BINDING_CONFLICT");
}

async function recoverOrderWebhookByExternalReference(data, payment) {
  const externalReference = String(payment?.external_reference || "").trim();
  if (!externalReference.toLowerCase().startsWith("order_payment_attempt:")) return null;

  if (!isOpaqueOrderReference(externalReference)) {
    const error = new Error("Referência de pagamento do pedido inválida.");
    throw webhookStage(error, "webhook_order_reference_lookup", "ORDER_PAYMENT_REFERENCE_INVALID");
  }

  let attempt = await OrderPaymentAttempt.findOne({ externalReference });
  if (!attempt) {
    const error = new Error("Tentativa de pagamento do pedido ainda não localizada.");
    throw webhookStage(error, "webhook_order_reference_lookup", "ORDER_PAYMENT_ATTEMPT_NOT_FOUND");
  }

  attempt = await bindOrderAttemptFromWebhookReference({
    attempt,
    payment,
    resourceId: data.resourceId,
  });

  const pedido = await Pedido.findOne({
    _id: attempt.pedidoId,
    estabelecimentoId: attempt.estabelecimentoId,
  });

  appLogger.info("mercado_pago_order_webhook_race_recovered", {
    estabelecimentoIdSuffix: idSuffix(attempt.estabelecimentoId),
    pedidoIdSuffix: idSuffix(attempt.pedidoId),
    paymentIdSuffix: idSuffix(data.resourceId),
    paymentStatus: String(payment?.status || "").slice(0, 40) || null,
  });

  if (!pedido) {
    return {
      kind: "orphaned_order_attempt",
      attempt,
      pedido: null,
      resource: payment,
    };
  }
  return {
    kind: pedido.excluido === true ? "archived_order" : "order",
    attempt,
    pedido,
    resource: payment,
  };
}

async function loadWebhookResource(data) {
  if (data.resourceType === "subscription_preapproval") {
    return {
      kind: "preapproval",
      resource: await requestPlatform(`/preapproval/${encodeURIComponent(data.resourceId)}`, {
        operation: "load_subscription_preapproval_webhook",
        stage: "webhook_resource_lookup",
      }),
    };
  }
  const attempt = await OrderPaymentAttempt.findOne({ paymentId: data.resourceId });
  if (attempt) {
    const pedido = await Pedido.findOne({
      _id: attempt.pedidoId,
      estabelecimentoId: attempt.estabelecimentoId,
    });
    let accessToken;
    try {
      ({ accessToken } = await configuracaoComToken(attempt.estabelecimentoId));
    } catch (error) {
      throw webhookStage(error, "webhook_order_token_lookup", "ORDER_PAYMENT_TOKEN_LOOKUP_FAILED");
    }
    let resource;
    try {
      resource = await mp(`/v1/payments/${encodeURIComponent(data.resourceId)}`, {}, accessToken);
    } catch (error) {
      throw webhookStage(error, "webhook_order_resource_lookup", "ORDER_PAYMENT_RESOURCE_LOOKUP_FAILED");
    }
    if (!pedido) {
      return {
        kind: "orphaned_order_attempt",
        attempt,
        pedido: null,
        resource,
      };
    }
    return {
      kind: pedido.excluido === true ? "archived_order" : "order",
      attempt,
      pedido,
      resource,
    };
  }
  const pedido = await Pedido.findOne({
    mercadoPagoPaymentId: data.resourceId,
  });
  if (pedido) {
    let cfg;
    let accessToken;
    try {
      ({ cfg, accessToken } = await configuracaoComToken(pedido.estabelecimentoId));
    } catch (error) {
      throw webhookStage(error, "webhook_order_token_lookup", "ORDER_PAYMENT_TOKEN_LOOKUP_FAILED");
    }
    const legacyExternalReference = `pedido:${pedido._id}`;
    let legacyAttempt = await OrderPaymentAttempt.findOne({
      paymentId: data.resourceId,
      legacyReference: true,
    });
    if (!legacyAttempt) {
      legacyAttempt = await OrderPaymentAttempt.create({
        publicReference: crypto.randomUUID(),
        externalReference: legacyExternalReference,
        estabelecimentoId: pedido.estabelecimentoId,
        pedidoId: pedido._id,
        paymentId: String(data.resourceId),
        expectedCollectorId: String(cfg.mercadoPago.userId),
        expectedAmount: valorPixOnlinePedidoCentavos(pedido) / 100,
        currency: "BRL",
        status: String(pedido.mercadoPagoStatus || "pending"),
        paymentMethod: "pix",
        idempotencyKey: `legacy-${crypto.randomUUID()}`,
        expiresAt: pedido.pixExpiraEm || new Date(Date.now() + 24 * 60 * 60_000),
        legacyReference: true,
      });
    }
    let resource;
    try {
      resource = await mp(
        `/v1/payments/${encodeURIComponent(data.resourceId)}`,
        {},
        accessToken,
      );
    } catch (error) {
      throw webhookStage(error, "webhook_order_resource_lookup", "ORDER_PAYMENT_RESOURCE_LOOKUP_FAILED");
    }
    return {
      kind: pedido.excluido === true ? "archived_order" : "order",
      pedido,
      attempt: legacyAttempt,
      resource,
    };
  }
  const platformPayment = await requestPlatform(
    `/v1/payments/${encodeURIComponent(data.resourceId)}`,
    {
      operation: "load_payment_webhook_for_classification",
      stage: "webhook_resource_lookup",
    },
  );

  const recoveredOrder = await recoverOrderWebhookByExternalReference(data, platformPayment);
  if (recoveredOrder) return recoveredOrder;

  return {
    kind: "subscription",
    resource: platformPayment,
  };
}

async function processWebhookEvent(event, loaded) {
  let stage = "webhook_processing";
  try {
    if (loaded.kind === "preapproval") {
      stage = "webhook_preapproval_processing";
      return await processPreapproval(event, loaded.resource);
    }
    if (loaded.kind === "order") {
      stage = "webhook_order_processing";
      return await processOrderPayment(event, loaded.pedido, loaded.resource, loaded.attempt || null);
    }
    if (loaded.kind === "archived_order") {
      stage = "webhook_archived_order_processing";
      return await processArchivedOrderPayment(event, loaded.pedido, loaded.resource, loaded.attempt);
    }
    if (loaded.kind === "orphaned_order_attempt") {
      stage = "webhook_orphaned_order_processing";
      return await processOrphanedOrderAttemptPayment(event, loaded.resource, loaded.attempt);
    }
    stage = "webhook_subscription_processing";
    return await processSubscriptionPayment(event, loaded.resource);
  } catch (error) {
    throw webhookStage(error, stage, "WEBHOOK_PROCESSING_FAILED");
  }
}

exports.webhook = async (req, res) => {
  let event;
  let data = {};
  let signatureValid = false;
  try {
    data = extractMercadoPagoWebhookEvent(req);
    const authenticity = validateMercadoPagoWebhook({
      signatureHeader: req.get("x-signature"),
      requestId: req.get("x-request-id"),
      resourceId: data.signatureResourceId || data.resourceId,
      secret: process.env.MERCADO_PAGO_WEBHOOK_SECRET,
    });
    signatureValid = true;
    const loaded = await loadWebhookResource(data);
    if (String(loaded.resource?.id || "") !== String(authenticity.resourceId)) {
      const error = new Error("Recurso financeiro retornado é divergente.");
      error.code = "WEBHOOK_RESOURCE_IDENTITY_MISMATCH";
      error.stage = "webhook_resource_identity";
      throw error;
    }
    const effectiveAt = financialEffectiveDate(loaded.resource);
    const eventKey = webhookEventKey({
      resourceType: data.resourceType,
      resourceId: authenticity.resourceId,
      action: data.action,
      financialStatus: loaded.resource.status,
      effectiveAt,
    });
    const payloadHash = crypto.createHash("sha256")
      .update(JSON.stringify(req.body || {}))
      .digest("hex");

    try {
      event = await PaymentEvent.create({
        eventKey,
        requestId: authenticity.requestId,
        resourceId: authenticity.resourceId,
        resourceType: data.resourceType,
        action: data.action,
        payloadHash,
        status: "recebido",
        recebidoEm: new Date(),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      event = await PaymentEvent.findOne({ eventKey });
      const processingIsRecent = event?.status === "processando"
        && event.processandoEm
        && Date.now() - new Date(event.processandoEm).getTime() < 5 * 60_000;
      if (event?.status === "processado" || processingIsRecent) {
        return res.status(200).json({
          ok: true,
          code: "WEBHOOK_ALREADY_PROCESSED",
          received: true,
          duplicate: true,
        });
      }
    }

    const claimed = await claimEvent(event);
    if (!claimed) return res.status(200).json({
      ok: true,
      code: "WEBHOOK_ALREADY_PROCESSED",
      received: true,
      duplicate: true,
    });
    event = claimed;
    await processWebhookEvent(event, loaded);
    event.status = "processado";
    event.processadoEm = new Date();
    event.erro = "";
    await event.save();
    return res.status(200).json({ ok: true, code: "WEBHOOK_ACCEPTED", received: true });
  } catch (error) {
    if (event?._id) {
      await PaymentEvent.updateOne(
        { _id: event._id },
        {
          $set: {
            status: "falhou",
            erro: sanitizeMercadoPagoError(error).message,
          },
        },
      ).catch(() => {});
      const diagnostic = webhookDiagnostic(error, req, data, {
        signatureValid,
        responseStatus: 503,
      });
      appLogger.error("mercado_pago_webhook_error", diagnostic);
      operationalAlerts.trigger({
        event: "mercado_pago_webhook_failed",
        key: `mercado_pago_webhook_failed:${diagnostic.stage}`,
        severity: "critical",
        details: {
          stage: diagnostic.stage,
          eventType: diagnostic.eventType,
          resourceIdSuffix: diagnostic.resourceIdSuffix,
          providerCode: diagnostic.providerCode,
          errorName: diagnostic.errorName,
          correlationId: diagnostic.correlationId,
        },
      });
      res.locals.operationalAlertHandled = true;
      return res.status(503).json({
        ok: false,
        code: error.code || "WEBHOOK_PROCESSING_RETRYABLE",
        received: false,
        correlationId: String(req.correlationId || ""),
      });
    }
    if (signatureValid) {
      const diagnostic = webhookDiagnostic(error, req, data, {
        signatureValid,
        responseStatus: 503,
      });
      appLogger.error("mercado_pago_webhook_error", diagnostic);
      operationalAlerts.trigger({
        event: "mercado_pago_webhook_failed",
        key: `mercado_pago_webhook_failed:${diagnostic.stage}`,
        severity: "critical",
        details: {
          stage: diagnostic.stage,
          eventType: diagnostic.eventType,
          resourceIdSuffix: diagnostic.resourceIdSuffix,
          providerCode: diagnostic.providerCode,
          errorName: diagnostic.errorName,
          correlationId: diagnostic.correlationId,
        },
      });
      res.locals.operationalAlertHandled = true;
      return res.status(503).json({
        ok: false,
        code: error.code || "WEBHOOK_PROVIDER_RETRYABLE",
        received: false,
        correlationId: String(req.correlationId || ""),
      });
    }
    const responseStatus = Number(error?.httpStatus || 401);
    appLogger.warn("mercado_pago_webhook_rejected", webhookDiagnostic(error, req, data, {
      signatureValid,
      responseStatus,
    }));
    return res.status(responseStatus).json({
      ok: false,
      code: error.code || "WEBHOOK_SIGNATURE_INVALID",
      received: false,
      correlationId: String(req.correlationId || ""),
    });
  }
};

exports.assinaturaDoUsuario = assinaturaDoUsuario;
exports.reconciliarPixPedidosExpirados = reconciliarPixPedidosExpirados;
exports._testing = {
  SUBSCRIPTION_PIX_EXPIRATION_MINUTES,
  cancelarPreapprovalRemoto,
  classifyRemotePreapproval,
  buildPixPaymentPayload,
  buildPreapprovalPayload,
  claimEvent,
  consumeOauthState,
  eventData,
  extractMercadoPagoWebhookEvent,
  expirarTentativasVencidas,
  financialEffectiveDate,
  financialEventShouldApply,
  obterOuCriarTentativa,
  parseSubscriptionReference,
  parseSubscriptionPixResponse,
  processArchivedOrderPayment,
  processOrphanedOrderAttemptPayment,
  processOrderPayment,
  processWebhookEvent,
  processApprovedOrderPayment,
  processPreapproval,
  processSubscriptionPayment,
  reconciliationAttemptUpdate,
  subscriptionReference,
  tentativaPublica,
  attemptReference,
  webhookEventKey,
  webhookDiagnostic,
  mercadoPagoConfigStatus,
  loadWebhookResource,
  orderAttemptExternalReference,
  isOpaqueOrderReference,
  applyOrderPayment,
  expirarPixPedidoSeNecessario,
  reconciliarPixPedidosExpirados,
  registrarAprovacaoPixAposExpiracao,
  assertStockRestored,
  validarRedirectMercadoPago,
};
