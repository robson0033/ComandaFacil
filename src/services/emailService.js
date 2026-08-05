"use strict";

const nodemailer = require("nodemailer");
const { sanitizeString } = require("../utils/logger");
const { operationalAlerts } = require("./operationalAlertService");

const SMTP_CONNECTION_TIMEOUT_MS = 15_000;
const SMTP_GREETING_TIMEOUT_MS = 15_000;
const SMTP_SOCKET_TIMEOUT_MS = 60_000;
const RESEND_REQUEST_TIMEOUT_MS = 15_000;
const RESEND_API_URL = "https://api.resend.com/emails";

function criarErroConfiguracao(message, code) {
  const error = new Error(message);
  error.name = "EmailConfigurationError";
  error.code = code;
  return error;
}

function obterEmailProvider(env = process.env) {
  const provider = String(env.EMAIL_PROVIDER || "smtp").trim().toLowerCase();
  if (!new Set(["smtp", "resend"]).has(provider)) {
    throw criarErroConfiguracao(
      "EMAIL_PROVIDER deve ser smtp ou resend.",
      "EMAIL_PROVIDER_INVALID",
    );
  }
  return provider;
}

function obterRemetentePadrao(env = process.env) {
  const provider = obterEmailProvider(env);
  const value = provider === "resend"
    ? env.EMAIL_FROM
    : (env.SMTP_FROM || env.SMTP_USER);
  const remetente = String(value || "").trim();
  if (!remetente) {
    throw criarErroConfiguracao(
      provider === "resend"
        ? "Configure EMAIL_FROM para enviar e-mails pela Resend."
        : "Configure SMTP_FROM ou SMTP_USER para enviar e-mails.",
      provider === "resend" ? "EMAIL_FROM_MISSING" : "SMTP_FROM_MISSING",
    );
  }
  return remetente;
}

function criarTransportador(env = process.env) {
  const host = String(env.SMTP_HOST || "").trim();
  const porta = Number(env.SMTP_PORT || 587);
  const usuario = String(env.SMTP_USER || "").trim();
  const senha = String(env.SMTP_PASS || "");

  if (!host || !usuario || !senha) {
    throw criarErroConfiguracao(
      "Configure SMTP_HOST, SMTP_PORT, SMTP_USER e SMTP_PASS para enviar e-mails.",
      "SMTP_CONFIGURATION_MISSING",
    );
  }

  return nodemailer.createTransport({
    host,
    port: porta,
    secure: porta === 465,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    auth: {
      user: usuario,
      pass: senha,
    },
  });
}

function mascararEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  const [local, domain] = email.split("@");
  if (!local || !domain) return "destinatario_invalido";
  return `${local.slice(0, 1)}***@${domain.slice(0, 120)}`;
}

function textoSeguro(value, maxLength = 160) {
  const sanitized = sanitizeString(String(value || ""), maxLength);
  return sanitized || null;
}

function numeroSeguro(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function chaveAlertaEmail(tipo) {
  return `email_delivery_failed:${String(tipo || "unknown").slice(0, 80)}`;
}

function diagnosticoEmailSeguro(error) {
  const cause = error?.cause || {};
  return {
    errorName: textoSeguro(error?.name || "Error", 80),
    errorCode: textoSeguro(error?.code || cause?.code, 120),
    errorErrno: textoSeguro(error?.errno || cause?.errno, 120),
    errorSyscall: textoSeguro(error?.syscall || cause?.syscall, 80),
    smtpCommand: textoSeguro(error?.command, 80),
    responseCode: numeroSeguro(error?.responseCode || error?.statusCode),
    remoteAddress: textoSeguro(error?.address || cause?.address, 160),
    remotePort: numeroSeguro(error?.port || cause?.port),
    errorMessage: textoSeguro(error?.message || "Falha ao enviar e-mail.", 300),
  };
}

function formatarEndereco(value) {
  if (typeof value === "string") return value.trim();
  const address = String(value?.address || "").trim();
  const name = String(value?.name || "").replace(/[\r\n]/g, " ").trim();
  if (!address) return "";
  return name ? `${name} <${address}>` : address;
}

function normalizarListaEnderecos(value) {
  const input = Array.isArray(value) ? value : [value];
  return input.map(formatarEndereco).filter(Boolean);
}

function montarPayloadResend(mensagem, env = process.env) {
  const from = formatarEndereco(mensagem?.from) || obterRemetentePadrao(env);
  const to = normalizarListaEnderecos(mensagem?.to);
  const subject = String(mensagem?.subject || "").trim();

  if (!from || to.length === 0 || !subject) {
    throw criarErroConfiguracao(
      "Mensagem de e-mail sem remetente, destinatário ou assunto.",
      "EMAIL_MESSAGE_INVALID",
    );
  }

  const payload = { from, to, subject };
  if (mensagem?.html !== undefined) payload.html = String(mensagem.html);
  if (mensagem?.text !== undefined) payload.text = String(mensagem.text);

  const replyTo = normalizarListaEnderecos(
    mensagem?.replyTo ?? mensagem?.reply_to,
  );
  if (replyTo.length === 1) payload.reply_to = replyTo[0];
  else if (replyTo.length > 1) payload.reply_to = replyTo;

  return payload;
}

async function lerRespostaJson(response) {
  try {
    if (typeof response?.json === "function") return await response.json();
    if (typeof response?.text === "function") {
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }
  } catch {
    return {};
  }
  return {};
}

function criarErroResend(response, body) {
  const message = String(
    body?.message || `A API de e-mail respondeu HTTP ${response?.status || 0}.`,
  ).slice(0, 300);
  const error = new Error(message);
  error.name = "ResendApiError";
  error.code = String(body?.name || "RESEND_API_ERROR").slice(0, 120);
  error.responseCode = Number(response?.status) || null;
  error.statusCode = Number(response?.status) || null;
  error.command = "POST";
  error.address = "api.resend.com";
  error.port = 443;
  return error;
}

async function enviarPorResend(
  mensagem,
  {
    env = process.env,
    fetchFn = globalThis.fetch,
    timeoutMs = RESEND_REQUEST_TIMEOUT_MS,
  } = {},
) {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    throw criarErroConfiguracao(
      "Configure RESEND_API_KEY para enviar e-mails pela Resend.",
      "RESEND_API_KEY_MISSING",
    );
  }
  if (typeof fetchFn !== "function") {
    throw criarErroConfiguracao(
      "Cliente HTTPS indisponível para envio de e-mail.",
      "EMAIL_FETCH_UNAVAILABLE",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetchFn(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "ComandaFacil/2.0",
      },
      body: JSON.stringify(montarPayloadResend(mensagem, env)),
      signal: controller.signal,
    });
    const body = await lerRespostaJson(response);
    if (!response?.ok) throw criarErroResend(response, body);

    return {
      messageId: String(body?.id || ""),
      provider: "resend",
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Tempo limite da API de e-mail excedido.");
      timeoutError.name = "EmailApiTimeoutError";
      timeoutError.code = "RESEND_API_TIMEOUT";
      timeoutError.command = "POST";
      timeoutError.address = "api.resend.com";
      timeoutError.port = 443;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function enviarMensagem(mensagem, options = {}) {
  const env = options.env || process.env;
  const provider = obterEmailProvider(env);
  if (provider === "resend") {
    return enviarPorResend(mensagem, { ...options, env });
  }
  return criarTransportador(env).sendMail(mensagem);
}

async function enviarComAlerta({
  tipo,
  destinatario,
  mensagem,
  env = process.env,
  fetchFn,
}) {
  const emailType = String(tipo || "unknown").slice(0, 80);
  const recipientMasked = mascararEmail(destinatario);
  const alertKey = chaveAlertaEmail(emailType);
  const configuredProvider = String(env.EMAIL_PROVIDER || "smtp")
    .trim().toLowerCase().slice(0, 30);

  try {
    const resultado = await enviarMensagem(mensagem, { env, fetchFn });

    operationalAlerts.resolve({
      event: "email_delivery_failed",
      key: alertKey,
      severity: "info",
      details: {
        emailType,
        emailProvider: configuredProvider,
        recipientMasked,
        status: "delivery_recovered",
      },
    });

    return resultado;
  } catch (error) {
    operationalAlerts.trigger({
      event: "email_delivery_failed",
      key: alertKey,
      severity: "critical",
      details: {
        emailType,
        emailProvider: configuredProvider,
        recipientMasked,
        ...diagnosticoEmailSeguro(error),
      },
    });
    throw error;
  }
}

async function enviarCodigoRecuperacao({ email, nome, codigo }) {
  const remetente = obterRemetentePadrao();
  const nomeSeguro = String(nome || "cliente").trim();

  await enviarComAlerta({
    tipo: "password_recovery",
    destinatario: email,
    mensagem: {
      from: remetente,
      to: email,
      subject: "Código para redefinir sua senha — Comanda Fácil",
      text: [
        `Olá, ${nomeSeguro}.`,
        "",
        "Recebemos uma solicitação para redefinir sua senha no Comanda Fácil.",
        `Seu código de recuperação é: ${codigo}`,
        "",
        "O código expira em 10 minutos.",
        "Se você não solicitou a alteração, ignore este e-mail.",
      ].join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;background:#f7f3f0;padding:32px;color:#1d1d1f">
          <div style="max-width:560px;margin:auto;background:#fff;border:1px solid #eadfd8;border-radius:18px;padding:32px">
            <h1 style="margin:0 0 12px;font-size:26px;color:#111827">Redefinição de senha</h1>
            <p style="line-height:1.6">Olá, <strong>${nomeSeguro}</strong>.</p>
            <p style="line-height:1.6">Use o código abaixo para criar uma nova senha no Comanda Fácil:</p>
            <div style="font-size:34px;font-weight:800;letter-spacing:8px;text-align:center;background:#fff4e8;color:#d94b16;border-radius:14px;padding:20px;margin:24px 0">${codigo}</div>
            <p style="line-height:1.6"><strong>Validade:</strong> 10 minutos.</p>
            <p style="line-height:1.6;color:#6b7280">Se você não solicitou esta alteração, ignore esta mensagem. Sua senha atual continuará funcionando.</p>
          </div>
        </div>
      `,
    },
  });
}

async function enviarCodigoConsultaPedidos({ email, codigo }) {
  const remetente = obterRemetentePadrao();
  await enviarComAlerta({
    tipo: "order_lookup_verification",
    destinatario: email,
    mensagem: {
      from: remetente,
      to: email,
      subject: "Código para consultar seus pedidos — Comanda Fácil",
      text: `Seu código para consultar pedidos é ${codigo}. Ele expira em 10 minutos.`,
    },
  });
}

function emailValido(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function limparCabecalho(value, fallback = "") {
  return String(value || fallback).replace(/[\r\n]/g, " ").trim().slice(0, 160);
}

function escaparHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function enviarConfirmacaoPedido({
  email,
  cliente,
  codigoPublico,
  nomeLoja,
  emailLoja,
  total,
  acompanhamentoUrl,
}) {
  if (!emailValido(email)) return false;
  const remetenteConfigurado = obterRemetentePadrao();
  const enderecoCentral = remetenteConfigurado.match(/<([^>]+)>/)?.[1]
    || remetenteConfigurado;
  const loja = limparCabecalho(nomeLoja, "Estabelecimento");
  const nomeCliente = limparCabecalho(cliente, "cliente");
  const codigo = limparCabecalho(codigoPublico);
  const ultimosQuatro = codigo.slice(-4);
  const valor = Number(total || 0).toFixed(2).replace(".", ",");
  const mail = {
    from: { name: `${loja} via Comanda Fácil`, address: enderecoCentral },
    to: String(email).trim().toLowerCase(),
    subject: `Seu pedido #${codigo} foi recebido`,
    text: [
      `Olá, ${nomeCliente}.`, "",
      `Seu pedido #${codigo} foi recebido pela ${loja}.`, "",
      "Para acompanhar o pedido, informe:",
      "Telefone usado na compra",
      `Código: ${ultimosQuatro}`, "",
      `Total: R$ ${valor}`,
      "Status atual: Novo", "",
      "Guarde este código até a conclusão do pedido.",
      acompanhamentoUrl ? `Acompanhar pedido: ${acompanhamentoUrl}` : "",
    ].filter(Boolean).join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
        <h1>Pedido #${escaparHtml(codigo)} recebido</h1>
        <p>Olá, ${escaparHtml(nomeCliente)}.</p>
        <p>Seu pedido foi recebido pela <strong>${escaparHtml(loja)}</strong>.</p>
        <p>Para acompanhar, informe o telefone usado na compra e o código <strong>${escaparHtml(ultimosQuatro)}</strong>.</p>
        <p><strong>Total:</strong> R$ ${escaparHtml(valor)}<br><strong>Status atual:</strong> Novo</p>
        ${acompanhamentoUrl ? `<p><a href="${escaparHtml(acompanhamentoUrl)}" style="display:inline-block;padding:12px 18px;background:#ee6b18;color:#fff;text-decoration:none;border-radius:10px">Acompanhar pedido</a></p>` : ""}
        <p>Guarde este código até a conclusão do pedido.</p>
      </div>`,
  };
  if (emailValido(emailLoja)) mail.replyTo = String(emailLoja).trim().toLowerCase();
  await enviarComAlerta({
    tipo: "order_confirmation",
    destinatario: email,
    mensagem: mail,
  });
  return true;
}

module.exports = {
  enviarConfirmacaoPedido,
  enviarCodigoRecuperacao,
  enviarCodigoConsultaPedidos,
  _testing: {
    criarTransportador,
    diagnosticoSmtpSeguro: diagnosticoEmailSeguro,
    diagnosticoEmailSeguro,
    enviarComAlerta,
    enviarMensagem,
    enviarPorResend,
    montarPayloadResend,
    obterEmailProvider,
    obterRemetentePadrao,
    mascararEmail,
    SMTP_CONNECTION_TIMEOUT_MS,
    SMTP_GREETING_TIMEOUT_MS,
    SMTP_SOCKET_TIMEOUT_MS,
    RESEND_REQUEST_TIMEOUT_MS,
    RESEND_API_URL,
  },
};
