"use strict";

const nodemailer = require("nodemailer");
const { sanitizeString } = require("../utils/logger");
const { operationalAlerts } = require("./operationalAlertService");

const SMTP_CONNECTION_TIMEOUT_MS = 15_000;
const SMTP_GREETING_TIMEOUT_MS = 15_000;
const SMTP_SOCKET_TIMEOUT_MS = 60_000;

function criarTransportador() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const porta = Number(process.env.SMTP_PORT || 587);
  const usuario = String(process.env.SMTP_USER || "").trim();
  const senha = String(process.env.SMTP_PASS || "");

  if (!host || !usuario || !senha) {
    throw new Error(
      "Configure SMTP_HOST, SMTP_PORT, SMTP_USER e SMTP_PASS para enviar e-mails.",
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

function diagnosticoSmtpSeguro(error) {
  return {
    errorName: textoSeguro(error?.name || "Error", 80),
    errorCode: textoSeguro(error?.code, 120),
    errorErrno: textoSeguro(error?.errno, 120),
    errorSyscall: textoSeguro(error?.syscall, 80),
    smtpCommand: textoSeguro(error?.command, 80),
    responseCode: numeroSeguro(error?.responseCode),
    remoteAddress: textoSeguro(error?.address, 160),
    remotePort: numeroSeguro(error?.port),
    errorMessage: textoSeguro(error?.message || "Falha ao enviar e-mail.", 300),
  };
}

async function enviarComAlerta({ tipo, destinatario, mensagem }) {
  const emailType = String(tipo || "unknown").slice(0, 80);
  const recipientMasked = mascararEmail(destinatario);
  const alertKey = chaveAlertaEmail(emailType);

  try {
    const transportador = criarTransportador();
    const resultado = await transportador.sendMail(mensagem);

    operationalAlerts.resolve({
      event: "email_delivery_failed",
      key: alertKey,
      severity: "info",
      details: {
        emailType,
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
        recipientMasked,
        ...diagnosticoSmtpSeguro(error),
      },
    });
    throw error;
  }
}

async function enviarCodigoRecuperacao({ email, nome, codigo }) {
  const remetente = String(
    process.env.SMTP_FROM || process.env.SMTP_USER || "",
  ).trim();

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
  const remetente = String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
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
  const remetenteConfigurado = String(
    process.env.SMTP_FROM || process.env.SMTP_USER || "",
  ).trim();
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
    diagnosticoSmtpSeguro,
    enviarComAlerta,
    mascararEmail,
    SMTP_CONNECTION_TIMEOUT_MS,
    SMTP_GREETING_TIMEOUT_MS,
    SMTP_SOCKET_TIMEOUT_MS,
  },
};
