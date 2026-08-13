"use strict";

const { logger } = require("../utils/logger");

const DEFAULT_GRAPH_VERSION = "v26.0";
const REQUEST_TIMEOUT_MS = 10_000;

function somenteDigitos(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function versaoGraph(env = process.env) {
  const value = String(env.WHATSAPP_GRAPH_VERSION || DEFAULT_GRAPH_VERSION).trim();
  return /^v\d+\.\d+$/.test(value) ? value : DEFAULT_GRAPH_VERSION;
}

function credenciaisGlobais(env = process.env) {
  return {
    accessToken: String(env.WHATSAPP_ACCESS_TOKEN || "").trim(),
    phoneNumberId: somenteDigitos(env.WHATSAPP_PHONE_NUMBER_ID || ""),
    graphVersion: versaoGraph(env),
  };
}

function validarCredenciaisParaNumero(phoneNumberId, env = process.env) {
  const credentials = credenciaisGlobais(env);
  const requested = somenteDigitos(phoneNumberId);
  if (!credentials.accessToken || !credentials.phoneNumberId) {
    const error = new Error("Credenciais da WhatsApp Cloud API não configuradas.");
    error.code = "WHATSAPP_CREDENTIALS_MISSING";
    throw error;
  }
  if (!requested || requested !== credentials.phoneNumberId) {
    const error = new Error("Este número do WhatsApp não possui credencial de envio neste ambiente.");
    error.code = "WHATSAPP_PHONE_NOT_AUTHORIZED";
    throw error;
  }
  return credentials;
}

function textoSeguro(value, max = 4096) {
  return String(value || "").trim().slice(0, max);
}

async function enviarPayload({ phoneNumberId, payload, correlationId = null, fetchImpl = global.fetch }) {
  if (typeof fetchImpl !== "function") {
    const error = new Error("Cliente HTTP indisponível para WhatsApp.");
    error.code = "WHATSAPP_HTTP_UNAVAILABLE";
    throw error;
  }

  const credentials = validarCredenciaisParaNumero(phoneNumberId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `https://graph.facebook.com/${credentials.graphVersion}/${credentials.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );

    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error("A Meta recusou o envio da mensagem do WhatsApp.");
      error.code = `WHATSAPP_META_${response.status}`;
      error.providerCode = responseBody?.error?.code || null;
      error.providerSubcode = responseBody?.error?.error_subcode || null;
      error.retryable = response.status >= 500 || response.status === 429;
      throw error;
    }

    const messageId = String(responseBody?.messages?.[0]?.id || "").trim();
    logger.info("whatsapp_message_sent", {
      correlationId,
      phoneNumberIdSuffix: credentials.phoneNumberId.slice(-8),
      messageIdSuffix: messageId ? messageId.slice(-10) : null,
      type: payload?.type || null,
    });
    return { ok: true, messageId, response: responseBody };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Tempo limite excedido ao enviar mensagem pelo WhatsApp.");
      timeoutError.code = "WHATSAPP_SEND_TIMEOUT";
      timeoutError.retryable = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function enviarTexto({ phoneNumberId, to, text, correlationId = null, fetchImpl }) {
  const destino = somenteDigitos(to);
  const mensagem = textoSeguro(text);
  if (destino.length < 10 || !mensagem) {
    const error = new Error("Destinatário ou mensagem inválidos para WhatsApp.");
    error.code = "WHATSAPP_MESSAGE_INVALID";
    throw error;
  }
  return enviarPayload({
    phoneNumberId,
    correlationId,
    fetchImpl,
    payload: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: destino,
      type: "text",
      text: {
        preview_url: false,
        body: mensagem,
      },
    },
  });
}

function normalizarOpcoesMenu(options = []) {
  return (Array.isArray(options) ? options : [])
    .map((option, index) => ({
      id: String(option?.id || `opcao_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
      title: textoSeguro(option?.title || option?.titulo, 20),
    }))
    .filter(option => option.id && option.title)
    .slice(0, 10);
}

async function enviarMenu({
  phoneNumberId,
  to,
  bodyText,
  options,
  buttonText = "Ver opções",
  correlationId = null,
  fetchImpl,
}) {
  const destino = somenteDigitos(to);
  const normalized = normalizarOpcoesMenu(options);
  const body = textoSeguro(bodyText, 1024);
  if (destino.length < 10 || !body || normalized.length === 0) {
    const error = new Error("Menu inválido para envio pelo WhatsApp.");
    error.code = "WHATSAPP_MENU_INVALID";
    throw error;
  }

  const interactive = normalized.length <= 3
    ? {
        type: "button",
        body: { text: body },
        action: {
          buttons: normalized.map(option => ({
            type: "reply",
            reply: {
              id: `cfw:${option.id}`,
              title: option.title,
            },
          })),
        },
      }
    : {
        type: "list",
        body: { text: body },
        action: {
          button: textoSeguro(buttonText, 20) || "Ver opções",
          sections: [{
            title: "Opções",
            rows: normalized.map(option => ({
              id: `cfw:${option.id}`,
              title: option.title.slice(0, 24),
            })),
          }],
        },
      };

  return enviarPayload({
    phoneNumberId,
    correlationId,
    fetchImpl,
    payload: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: destino,
      type: "interactive",
      interactive,
    },
  });
}

module.exports = {
  credenciaisGlobais,
  enviarMenu,
  enviarPayload,
  enviarTexto,
  somenteDigitos,
  validarCredenciaisParaNumero,
  _testing: {
    normalizarOpcoesMenu,
    textoSeguro,
    versaoGraph,
  },
};
