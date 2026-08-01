"use strict";

const crypto = require("crypto");
const validator = require("validator");
const {
  Assinatura,
  AssinaturaTentativa,
  Configuracao,
  OAuthState,
  PaymentEvent,
  Pedido,
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
const { registroModel } = require("../models/registroModel");
const {
  paidPeriod,
  subscriptionStatusForFinancialStatus,
  validateApprovedPayment,
  validatePaymentIdentity,
} = require("../services/mercadoPagoService");
const {
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
const PIX_ATTEMPT_TTL_MS = 30 * 60 * 1000;
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
const platformCollectorId = () => {
  const value = String(process.env.MERCADO_PAGO_PLATFORM_USER_ID || "").trim();
  if (!value) throw new Error("Conta principal da plataforma não configurada.");
  return value;
};
const subscriptionReference = assinatura =>
  `assinatura:${assinatura._id}:estabelecimento:${assinatura.estabelecimentoId}`;
const attemptReference = attempt =>
  `assinatura-tentativa:${attempt.attemptId}:estabelecimento:${attempt.estabelecimentoId}`;

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

function buildPixPaymentPayload({ amount, payerEmail, externalReference, notificationUrl }) {
  return {
    transaction_amount: Number(amount),
    payment_method_id: "pix",
    description: "Plano mensal ComandaFácil",
    external_reference: String(externalReference),
    notification_url: String(notificationUrl),
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

function parseSubscriptionPixResponse(data) {
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
  return {
    paymentId: String(data.id),
    status: String(data.status),
    qrCode: String(transactionData.qr_code),
    qrCodeBase64: String(transactionData.qr_code_base64),
    ticketUrl: String(transactionData.ticket_url || ""),
    expiresAt: String(
      transactionData.expiration_date
      || data.date_of_expiration
      || "",
    ),
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
      },
    },
  );
  const existing = await AssinaturaTentativa.findOne({
    estabelecimentoId: assinatura.estabelecimentoId,
    ativa: true,
    expiresAt: { $gt: now },
  });
  if (existing) {
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
      status: "criando",
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

function pixDaTentativa(attempt) {
  return {
    qrCodeBase64: attempt.pixQrCodeBase64 || "",
    copiaCola: attempt.pixCopiaCola || "",
  };
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
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error("Falha na API do Mercado Pago.");
      error.status = response.status;
      error.code = data.code || data.error || "";
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
  console.error("mercado_pago_platform_error", platformErrorLog(error, {
    correlationId: error.correlationId,
  }));
}

exports.pagina = async (req, res) => {
  try {
    const assinatura = await assinaturaDoUsuario(req);
    const dono = await registroModel.findById(estabelecimentoId(req)).lean();
    const integracao = mercadoPagoConfigStatus("subscription");
    const tentativaPix = await AssinaturaTentativa.findOne({
      estabelecimentoId: estabelecimentoId(req),
      metodo: "pix",
      ativa: true,
      pixCopiaCola: { $ne: "" },
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 }).lean();
    return res.render("assinatura", {
      assinatura: assinatura.toObject(),
      valorPlano: valorPlano(),
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || "",
      dono,
      pix: tentativaPix ? pixDaTentativa(tentativaPix) : null,
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
      diasRestantes: res.locals.diasRestantes || 0,
      csrfToken: res.locals.csrfToken,
      integracaoMercadoPago: validatePlatformPaymentConfig(),
      errors: [`Não foi possível carregar a assinatura. Código: ${error.correlationId || "indisponível"}`],
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
      { _id: attempt._id, status: "criando", ativa: true },
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
          status: "criando",
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
    const { attempt, created } = await obterOuCriarTentativa(assinatura, "pix");
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
        integracaoMercadoPago: mercadoPagoConfigStatus("subscription"),
      });
    }
    const data = await requestPlatform("/v1/payments", {
      operation: "create_subscription_pix",
      stage: "pix_payment_create",
      method: "POST",
      idempotencyKey: attempt.idempotencyKey,
      body: buildPixPaymentPayload({
        amount: valorPlano(),
        payerEmail,
        externalReference: attemptReference(attempt),
        notificationUrl: `${baseUrl(req)}/webhook/mercado-pago`,
      }),
    });
    const parsedPix = parseSubscriptionPixResponse(data);
    const pixQrCodeBase64 = parsedPix.qrCodeBase64;
    const pixCopiaCola = parsedPix.qrCode;
    await AssinaturaTentativa.updateOne(
      { _id: attempt._id, status: "criando", ativa: true },
      {
        $set: {
          status: ["pending", "authorized", "approved"].includes(data.status)
            ? data.status
            : "pending",
          mercadoPagoPaymentId: String(data.id),
          pixQrCodeBase64,
          pixCopiaCola,
          expiresAt: parsedPix.expiresAt
            ? new Date(parsedPix.expiresAt)
            : attempt.expiresAt,
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

    const pix = { qrCodeBase64: pixQrCodeBase64, copiaCola: pixCopiaCola };
    if (wantsJson(req)) {
      return res.status(200).json({
        ok: true,
        code: "SUBSCRIPTION_PIX_CREATED",
        paymentId: parsedPix.paymentId,
        qrCode: pixCopiaCola,
        qrCodeBase64: pixQrCodeBase64,
        ticketUrl: parsedPix.ticketUrl,
        expiresAt: parsedPix.expiresAt || attempt.expiresAt?.toISOString?.() || "",
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
      integracaoMercadoPago: mercadoPagoConfigStatus("subscription"),
    });
  } catch (error) {
    if (!["ASSINATURA_ATIVA", "TENTATIVA_METODO_DIFERENTE"].includes(error?.code)) {
      await AssinaturaTentativa.updateOne(
        {
          estabelecimentoId: estabelecimentoId(req),
          metodo: "pix",
          status: "criando",
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
      return res.status(error?.code === "MERCADO_PAGO_CONFIG_INCOMPLETA" ? 503 : 502).json(payload);
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
    const pedido = await buscarPedidoPorToken({
      estabelecimentoId: cfgPublica.estabelecimentoId,
      token,
      lean: false,
    });
    if (!pedido) return res.status(404).json({ success: false, message: "Pedido não encontrado." });
    if (pedido.pagamentoStatus === "pago") return res.json({ success: true, aprovado: true });
    if (pedido.mercadoPagoPaymentId && pedido.pixCopiaCola) {
      return res.json({
        success: true,
        copiaCola: pedido.pixCopiaCola,
        qrCodeBase64: pedido.pixQrCodeBase64,
        status: pedido.mercadoPagoStatus || "pending",
        expiraEm: pedido.pixExpiraEm,
      });
    }
    const acessoVenda = await consultarAcessoVenda({
      estabelecimentoId: cfgPublica.estabelecimentoId,
      estabelecimento: cfgPublica,
    });
    if (!acessoVenda.permitido) return respostaLojaIndisponivel(res);

    const { cfg: cfgPrivada, accessToken } = await configuracaoComToken(cfgPublica.estabelecimentoId);
    const emailCliente = String(pedido.emailCliente || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCliente)) {
      return res.status(400).json({
        success: false,
        message: "Informe um e-mail válido para gerar o pagamento Pix.",
      });
    }

    const data = await mp("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": `pedido-${pedido._id}` },
      body: JSON.stringify({
        transaction_amount: Number(pedido.total),
        description: `Pedido ${String(pedido._id).slice(-6).toUpperCase()} - ${cfgPublica.nomeEstabelecimento}`,
        payment_method_id: "pix",
        external_reference: `pedido:${pedido._id}`,
        notification_url: `${baseUrl(req)}/webhook/mercado-pago`,
        payer: { email: emailCliente, first_name: pedido.cliente || "Cliente" },
      }),
    }, accessToken);
    if (!data.id) throw new Error("Resposta de pagamento inválida.");
    validatePaymentIdentity(data, {
      paymentId: data.id,
      amount: pedido.total,
      externalReference: `pedido:${pedido._id}`,
      collectorId: cfgPrivada.mercadoPago.userId,
    });

    pedido.formaPagamento = "pix";
    pedido.mercadoPagoPaymentId = String(data.id);
    pedido.mercadoPagoStatus = String(data.status || "pending");
    pedido.pixCopiaCola = data.point_of_interaction?.transaction_data?.qr_code || "";
    pedido.pixQrCodeBase64 = data.point_of_interaction?.transaction_data?.qr_code_base64 || "";
    pedido.pixExpiraEm = data.date_of_expiration ? new Date(data.date_of_expiration) : null;
    await pedido.save();

    return res.status(201).json({
      success: true,
      status: data.status,
      copiaCola: pedido.pixCopiaCola,
      qrCodeBase64: pedido.pixQrCodeBase64,
      expiraEm: pedido.pixExpiraEm,
    });
  } catch (error) {
    console.error("Pix do pedido:", sanitizeMercadoPagoError(error));
    return res.status(400).json({
      success: false,
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
  });
  if (!pedido) return res.status(404).json({ success: false, message: "Pedido não encontrado." });
  return res.json({
    success: true,
    pagamentoStatus: pedido.pagamentoStatus,
  });
};

function eventData(req) {
  const bodyType = String(req.body?.type || "").trim();
  const queryType = String(req.query?.type || "").trim();
  const resourceType = bodyType || queryType;
  const action = String(req.body?.action || req.query?.action || resourceType).trim();
  const bodyResourceId = req.body?.data?.id;
  const queryResourceId = req.query?.["data.id"];
  if (bodyType && queryType && bodyType !== queryType) {
    throw new Error("Tipo de recurso divergente.");
  }
  if (bodyResourceId && queryResourceId
    && String(bodyResourceId) !== String(queryResourceId)) {
    throw new Error("Identificador de recurso divergente.");
  }
  const resourceId = bodyResourceId || queryResourceId;
  if (!["payment", "subscription_preapproval"].includes(resourceType)) {
    throw new Error("Tipo de evento não suportado.");
  }
  if (!resourceId || action.length > 120) throw new Error("Evento malformado.");
  return { resourceType, action, resourceId: String(resourceId) };
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

async function processOrderPayment(event, pedido, payment) {
  const { cfg } = await configuracaoComToken(pedido.estabelecimentoId);
  validatePaymentIdentity(payment, {
    paymentId: pedido.mercadoPagoPaymentId,
    amount: pedido.total,
    externalReference: `pedido:${pedido._id}`,
    collectorId: cfg.mercadoPago.userId,
  });
  event.estabelecimentoId = pedido.estabelecimentoId;
  event.pedidoId = pedido._id;

  pedido.mercadoPagoStatus = String(payment.status || "");
  pedido.historicoFinanceiro.push({
    paymentId: String(payment.id),
    status: String(payment.status || ""),
    registradoEm: new Date(),
  });

  if (payment.status === "approved") {
    validateApprovedPayment(payment, {
      paymentId: pedido.mercadoPagoPaymentId,
      amount: pedido.total,
      externalReference: `pedido:${pedido._id}`,
      collectorId: cfg.mercadoPago.userId,
    });
    if (pedido.status === "cancelado") {
      pedido.pagamentoInconsistente = true;
      pedido.pagamentoInconsistencia = "Pagamento aprovado após cancelamento do pedido.";
      await pedido.save();
      return;
    }
    assertStockCompleted(await baixarEstoqueDoPedido(pedido._id));
    pedido.pagamentoStatus = "pago";
    pedido.pagoEm = payment.date_approved ? new Date(payment.date_approved) : new Date();
  } else if (["cancelled", "rejected", "refunded", "charged_back"].includes(payment.status)) {
    assertStockCompleted(await restaurarEstoqueDoPedido(pedido._id));
    pedido.pagamentoStatus = "cancelado";
  }
  await pedido.save();
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

  const isCurrentPix = attempt
    ? String(attempt.mercadoPagoPaymentId) === String(payment.id)
    : String(assinatura.mercadoPagoPaymentId) === String(payment.id);
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
    amount: valorPlano(),
    externalReference: attempt ? attemptReference(attempt) : subscriptionReference(assinatura),
    collectorId: platformCollectorId(),
    preapprovalId: isCurrentRecurring
      ? (attempt?.mercadoPagoPreapprovalId || assinatura.mercadoPagoPreapprovalId)
      : undefined,
  });
  const obsoleteAttempt = attempt && (!attempt.ativa
    || ["expired", "superseded", "cancelled", "failed"].includes(attempt.status));
  if (obsoleteAttempt) {
    if (payment.status === "approved") {
      attempt.status = "reconciliation_required";
      attempt.ativa = false;
      attempt.completedAt = new Date();
      attempt.erro = "Pagamento aprovado para tentativa não vigente; conciliação manual necessária.";
      await attempt.save();
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
    const approvedAt = payment.date_approved ? new Date(payment.date_approved) : new Date();
    const previousExpiration = assinatura.planoExpira
      ? new Date(assinatura.planoExpira)
      : null;
    const continuedPeriod = previousExpiration
      && !Number.isNaN(previousExpiration.getTime())
      && previousExpiration > approvedAt;
    const period = paidPeriod(assinatura.planoExpira, approvedAt);
    assinatura.status = "ativa";
    if (!assinatura.planoInicio || !continuedPeriod) {
      assinatura.planoInicio = approvedAt;
    }
    assinatura.planoExpira = period.expiresAt;
    assinatura.ultimoPagamentoAprovadoId = String(payment.id);
    assinatura.ultimoPagamentoAprovadoEm = approvedAt;
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

  if (preapproval.status === "cancelled") {
    const trialValid = assinatura.fimTeste && new Date(assinatura.fimTeste) > new Date();
    assinatura.status = trialValid ? "teste" : "cancelada";
  } else if (["paused"].includes(preapproval.status) && assinatura.status !== "ativa") {
    assinatura.status = "atrasada";
  }
  // "authorized" confirma apenas autorização; nunca comprova pagamento.
  await assinatura.save();
  if (attempt) {
    attempt.status = String(preapproval.status || attempt.status);
    if (preapproval.status === "cancelled") {
      attempt.ativa = false;
      attempt.completedAt = new Date();
    }
    await attempt.save();
  }
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
  const pedido = await Pedido.findOne({
    mercadoPagoPaymentId: data.resourceId,
    excluido: { $ne: true },
  });
  if (pedido) {
    const { accessToken } = await configuracaoComToken(pedido.estabelecimentoId);
    return {
      kind: "order",
      pedido,
      resource: await mp(
        `/v1/payments/${encodeURIComponent(data.resourceId)}`,
        {},
        accessToken,
      ),
    };
  }
  return {
    kind: "subscription",
    resource: await requestPlatform(`/v1/payments/${encodeURIComponent(data.resourceId)}`, {
      operation: "load_subscription_payment_webhook",
      stage: "webhook_resource_lookup",
    }),
  };
}

async function processWebhookEvent(event, loaded) {
  if (loaded.kind === "preapproval") {
    return processPreapproval(event, loaded.resource);
  }
  if (loaded.kind === "order") {
    return processOrderPayment(event, loaded.pedido, loaded.resource);
  }
  return processSubscriptionPayment(event, loaded.resource);
}

exports.webhook = async (req, res) => {
  let event;
  let authenticated = false;
  try {
    const data = eventData(req);
    const authenticity = validateMercadoPagoWebhook({
      signatureHeader: req.get("x-signature"),
      requestId: req.get("x-request-id"),
      resourceId: data.resourceId,
      secret: process.env.MERCADO_PAGO_WEBHOOK_SECRET,
    });
    authenticated = true;
    const loaded = await loadWebhookResource(data);
    if (String(loaded.resource?.id || "") !== String(authenticity.resourceId)) {
      throw new Error("Recurso financeiro retornado é divergente.");
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
        return res.status(200).json({ received: true, duplicate: true });
      }
    }

    const claimed = await claimEvent(event);
    if (!claimed) return res.status(200).json({ received: true, duplicate: true });
    event = claimed;
    await processWebhookEvent(event, loaded);
    event.status = "processado";
    event.processadoEm = new Date();
    event.erro = "";
    await event.save();
    return res.status(200).json({ received: true });
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
      console.error("Webhook Mercado Pago:", sanitizeMercadoPagoError(error));
      return res.status(503).json({ received: false });
    }
    if (authenticated) {
      console.error("Webhook Mercado Pago não persistido:", sanitizeMercadoPagoError(error));
      return res.status(503).json({ received: false });
    }
    console.warn("Webhook Mercado Pago rejeitado:", sanitizeMercadoPagoError(error));
    return res.status(401).json({ received: false });
  }
};

exports.assinaturaDoUsuario = assinaturaDoUsuario;
exports._testing = {
  buildPixPaymentPayload,
  buildPreapprovalPayload,
  claimEvent,
  consumeOauthState,
  eventData,
  financialEffectiveDate,
  financialEventShouldApply,
  obterOuCriarTentativa,
  parseSubscriptionReference,
  parseSubscriptionPixResponse,
  processOrderPayment,
  processPreapproval,
  processSubscriptionPayment,
  subscriptionReference,
  attemptReference,
  webhookEventKey,
  mercadoPagoConfigStatus,
  validarRedirectMercadoPago,
};
