"use strict";

const crypto = require("crypto");
const {
  Configuracao,
  Pedido,
  WhatsAppConfiguracao,
  WhatsAppConversa,
  WhatsAppMensagem,
} = require("../models/painelModels");
const { logger } = require("../utils/logger");
const cloudApi = require("./whatsappCloudApiService");

const MESSAGE_RETENTION_DAYS = 30;
const recentMessageIds = new Map();
const RECENT_MESSAGE_TTL_MS = 10 * 60 * 1000;
let lastRetentionCleanupAt = 0;

function hash(value, purpose = "wa") {
  const salt = String(process.env.WHATSAPP_APP_SECRET || process.env.SESSION_SECRET || "comanda-facil");
  return crypto.createHash("sha256").update(`${purpose}:${salt}:${String(value || "")}`).digest("hex");
}

function phoneNumberIdHash(value) {
  return hash(cloudApi.somenteDigitos(value), "phone-number-id");
}

function messageIdHash(value) {
  return hash(String(value || ""), "message-id");
}

function telefonePedidoDoWaId(value) {
  return cloudApi.somenteDigitos(value).slice(-11);
}

function textoDaMensagem(message = {}) {
  if (message.type === "text") return String(message?.text?.body || "").trim();
  if (message.type === "interactive") {
    return String(
      message?.interactive?.button_reply?.title
      || message?.interactive?.list_reply?.title
      || "",
    ).trim();
  }
  return "";
}

function interactiveReplyId(message = {}) {
  if (message.type !== "interactive") return "";
  return String(
    message?.interactive?.button_reply?.id
    || message?.interactive?.list_reply?.id
    || "",
  ).trim();
}

function extrairMensagensRecebidas(body = {}) {
  const result = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "messages") continue;
      const value = change?.value || {};
      const phoneNumberId = cloudApi.somenteDigitos(value?.metadata?.phone_number_id || "");
      const contacts = new Map(
        (Array.isArray(value?.contacts) ? value.contacts : []).map(contact => [
          cloudApi.somenteDigitos(contact?.wa_id || ""),
          String(contact?.profile?.name || "").trim().slice(0, 120),
        ]),
      );
      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        const from = cloudApi.somenteDigitos(message?.from || "");
        const messageId = String(message?.id || "").trim();
        if (!phoneNumberId || !from || !messageId) continue;
        result.push({
          phoneNumberId,
          from,
          profileName: contacts.get(from) || "",
          messageId,
          type: String(message?.type || "unknown").slice(0, 40),
          text: textoDaMensagem(message).slice(0, 4096),
          interactiveId: interactiveReplyId(message),
          timestamp: String(message?.timestamp || ""),
        });
      }
    }
  }
  return result;
}


function extrairStatuses(body = {}) {
  const result = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "messages") continue;
      for (const status of Array.isArray(change?.value?.statuses) ? change.value.statuses : []) {
        const id = String(status?.id || "").trim();
        const value = String(status?.status || "").trim().slice(0, 40);
        if (id && value) result.push({ id, status: value });
      }
    }
  }
  return result;
}

function mensagemVistaRecentemente(messageId) {
  const key = messageIdHash(messageId);
  const now = Date.now();
  for (const [storedKey, expiresAt] of recentMessageIds) {
    if (expiresAt <= now) recentMessageIds.delete(storedKey);
  }
  if (recentMessageIds.has(key)) return true;
  recentMessageIds.set(key, now + RECENT_MESSAGE_TTL_MS);
  return false;
}

function statusPedidoTexto(status) {
  return ({
    novo: "🟢 Recebido",
    preparo: "🟡 Em preparo",
    pronto: "✅ Pronto",
    entregue: "🛵 Entregue",
    finalizado: "✅ Finalizado",
    cancelado: "❌ Cancelado",
  })[status] || String(status || "Em andamento");
}

function pagamentoTexto(status) {
  return ({
    pendente: "Pendente",
    pago: "Pago",
    cancelado: "Cancelado",
    expirado: "Expirado",
  })[status] || String(status || "Pendente");
}

function montarStatusPedido(pedido) {
  if (!pedido) return "Não encontrei um pedido recente para este WhatsApp.";
  const codigo = String(pedido.codigoPublicoFinal || pedido.codigoPublico || pedido._id || "")
    .trim()
    .slice(-12);
  const canal = ({ delivery: "Delivery", retirada: "Retirada", balcao: "Retirada", mesa: "Mesa" })[pedido.canal] || "Pedido";
  const linhas = [
    `🍽️ Pedido${codigo ? ` #${codigo}` : ""}`,
    `Status: ${statusPedidoTexto(pedido.status)}`,
    `Pagamento: ${pagamentoTexto(pedido.pagamentoStatus)}`,
    `Tipo: ${canal}`,
  ];
  if (Number.isFinite(Number(pedido.total))) {
    linhas.push(`Total: ${Number(pedido.total || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`);
  }
  return linhas.join("\n");
}

async function buscarPedidoRecente(estabelecimentoId, waId) {
  const telefone = telefonePedidoDoWaId(waId);
  if (telefone.length < 10) return null;
  return Pedido.findOne({
    estabelecimentoId,
    telefoneNormalizado: telefone,
    excluido: { $ne: true },
  })
    .sort({ createdAt: -1 })
    .select("_id codigoPublico codigoPublicoFinal status pagamentoStatus canal total createdAt")
    .lean();
}

function montarLinkCatalogo(slug = "") {
  const cleanSlug = String(slug || "").trim();
  if (!cleanSlug) return "";
  const base = String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (!base || !/^https:\/\//i.test(base)) return "";
  return `${base}/catalogo/${encodeURIComponent(cleanSlug)}`;
}

function menuOptions(config) {
  return (Array.isArray(config?.menuOpcoes) ? config.menuOpcoes : [])
    .filter(item => item?.ativo !== false && item?.titulo && item?.id)
    .slice(0, 10)
    .map(item => ({ id: String(item.id), title: String(item.titulo).slice(0, 20) }));
}

async function registrarMensagem({ conversa, direcao, texto, tipo, metaMessageId = "", status = "" }) {
  const expiresAt = new Date(Date.now() + MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const doc = {
    estabelecimentoId: conversa.estabelecimentoId,
    conversaId: conversa._id,
    direcao,
    texto: String(texto || "").slice(0, 4096),
    tipo: String(tipo || "text").slice(0, 40),
    metaMessageIdHash: metaMessageId ? messageIdHash(metaMessageId) : "",
    status: String(status || "").slice(0, 40),
    expiresAt,
  };
  try {
    return await WhatsAppMensagem.create(doc);
  } catch (error) {
    if (error?.code === 11000 && doc.metaMessageIdHash) return null;
    throw error;
  }
}

async function enviarTextoRegistrado({ config, conversa, text, correlationId }) {
  const result = await cloudApi.enviarTexto({
    phoneNumberId: config.phoneNumberId,
    to: conversa.clienteWaId,
    text,
    correlationId,
  });
  await registrarMensagem({
    conversa,
    direcao: "saida",
    texto: text,
    tipo: "text",
    metaMessageId: result.messageId,
    status: "sent",
  });
  conversa.ultimaSaidaEm = new Date();
  if (conversa.modo === "bot") conversa.naoLidas = 0;
  await conversa.save();
  return result;
}

async function enviarMenuConfigurado({ config, conversa, correlationId, prefixText = "" }) {
  const options = menuOptions(config);
  const body = [prefixText, config.mensagemBoasVindas, config.mensagemMenu]
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 1024);
  if (config.menuAtivo && options.length) {
    const result = await cloudApi.enviarMenu({
      phoneNumberId: config.phoneNumberId,
      to: conversa.clienteWaId,
      bodyText: body || "Como podemos ajudar?",
      options,
      buttonText: config.textoBotaoMenu || "Ver opções",
      correlationId,
    });
    await registrarMensagem({
      conversa,
      direcao: "saida",
      texto: body,
      tipo: options.length <= 3 ? "interactive_button" : "interactive_list",
      metaMessageId: result.messageId,
      status: "sent",
    });
    conversa.ultimaSaidaEm = new Date();
    if (conversa.modo === "bot") conversa.naoLidas = 0;
    await conversa.save();
    return result;
  }
  return enviarTextoRegistrado({
    config,
    conversa,
    text: config.mensagemBoasVindas || "Olá! Como podemos ajudar?",
    correlationId,
  });
}

function normalizarIntencao(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ehSaudacaoOuInicio(incoming = {}) {
  if (String(incoming.interactiveId || "").trim()) return false;
  if (String(incoming.type || "text") !== "text") return false;
  const text = normalizarIntencao(incoming.text);
  if (!text) return false;

  if (/^(oi|ola|opa|e ai|eae|bom dia|boa tarde|boa noite)(\b|$)/.test(text)) return true;
  return /^(menu|inicio|iniciar|comecar|comecar atendimento|ajuda)$/.test(text);
}

function encontrarOpcao(config, incoming) {
  const options = (Array.isArray(config?.menuOpcoes) ? config.menuOpcoes : [])
    .filter(item => item?.ativo !== false);
  const interactive = String(incoming.interactiveId || "");
  if (interactive.startsWith("cfw:")) {
    const id = interactive.slice(4);
    return options.find(item => String(item.id) === id) || null;
  }
  const text = String(incoming.text || "").trim().toLocaleLowerCase("pt-BR");
  if (/^\d{1,2}$/.test(text)) {
    const index = Number(text) - 1;
    if (index >= 0 && index < options.length) return options[index];
  }
  return options.find(item => String(item.titulo || "").trim().toLocaleLowerCase("pt-BR") === text) || null;
}

async function executarOpcao({ config, conversa, option, correlationId }) {
  const resposta = String(option?.resposta || "").trim();
  switch (option?.acao) {
    case "status_pedido": {
      const pedido = await buscarPedidoRecente(config.estabelecimentoId, conversa.clienteWaId);
      const text = pedido
        ? montarStatusPedido(pedido)
        : (config.mensagemPedidoNaoEncontrado || "Não encontrei um pedido recente para este WhatsApp.");
      return enviarTextoRegistrado({ config, conversa, text, correlationId });
    }
    case "falar_atendente": {
      conversa.modo = "atendente";
      conversa.atendenteSolicitadoEm = new Date();
      conversa.naoLidas = 0;
      await conversa.save();
      return enviarTextoRegistrado({
        config,
        conversa,
        text: resposta || "Certo! O atendimento automático foi pausado. Um atendente continuará a conversa por aqui. 👤",
        correlationId,
      });
    }
    case "abrir_cardapio": {
      const estabelecimento = await Configuracao.findOne({ estabelecimentoId: config.estabelecimentoId })
        .select("slug")
        .lean();
      const link = montarLinkCatalogo(estabelecimento?.slug);
      return enviarTextoRegistrado({
        config,
        conversa,
        text: resposta || (link ? `Veja nosso cardápio: ${link}` : "Nosso cardápio está indisponível no momento."),
        correlationId,
      });
    }
    case "resposta_personalizada":
    default:
      return enviarTextoRegistrado({
        config,
        conversa,
        text: resposta || config.mensagemFallback || "Como podemos ajudar?",
        correlationId,
      });
  }
}

async function processarMensagem(incoming, correlationId) {
  const idHash = phoneNumberIdHash(incoming.phoneNumberId);
  const config = await WhatsAppConfiguracao.findOne({
    phoneNumberIdHash: idHash,
    ativo: true,
  });
  if (!config) {
    logger.info("whatsapp_message_ignored_unbound_number", {
      correlationId,
      phoneNumberIdSuffix: incoming.phoneNumberId.slice(-8),
    });
    return;
  }

  // No estágio atual, credenciais de envio são globais no Render. O hash
  // associa o número a exatamente uma loja; credenciais por loja virão no Embedded Signup.
  const runtimeConfig = {
    ...config.toObject(),
    phoneNumberId: incoming.phoneNumberId,
  };

  const existingMessage = await WhatsAppMensagem.findOne({
    metaMessageIdHash: messageIdHash(incoming.messageId),
  }).select("_id").lean();
  if (existingMessage) return;

  const setConversa = {
    ultimaEntradaEm: new Date(),
    ultimaMensagemPreview: String(incoming.text || `[${incoming.type}]`).slice(0, 250),
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  };
  if (incoming.profileName) setConversa.clienteNome = incoming.profileName;
  const conversa = await WhatsAppConversa.findOneAndUpdate(
    {
      estabelecimentoId: config.estabelecimentoId,
      clienteWaId: incoming.from,
    },
    {
      $set: setConversa,
      $inc: { naoLidas: 1 },
      $setOnInsert: { modo: "bot" },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

  await registrarMensagem({
    conversa,
    direcao: "entrada",
    texto: incoming.text,
    tipo: incoming.type,
    metaMessageId: incoming.messageId,
    status: "received",
  });

  if (conversa.modo === "atendente") {
    logger.info("whatsapp_message_waiting_human", {
      correlationId,
      estabelecimentoIdSuffix: String(config.estabelecimentoId).slice(-8),
      conversationIdSuffix: String(conversa._id).slice(-8),
    });
    return;
  }

  if (ehSaudacaoOuInicio(incoming)) {
    await enviarMenuConfigurado({
      config: runtimeConfig,
      conversa,
      correlationId,
      prefixText: "",
    });
    return;
  }

  const option = encontrarOpcao(runtimeConfig, incoming);
  if (option) {
    await executarOpcao({ config: runtimeConfig, conversa, option, correlationId });
    return;
  }

  await enviarMenuConfigurado({
    config: runtimeConfig,
    conversa,
    correlationId,
    // Saudações/comandos de início já retornaram acima. Portanto, qualquer
    // texto que chegou até aqui é realmente desconhecido, inclusive na
    // primeira mensagem da conversa.
    prefixText: runtimeConfig.mensagemFallback,
  });
}

async function limparRetencaoSeNecessario() {
  const now = Date.now();
  if (now - lastRetentionCleanupAt < 60 * 60 * 1000) return;
  lastRetentionCleanupAt = now;
  const current = new Date(now);
  await Promise.all([
    WhatsAppMensagem.deleteMany({ expiresAt: { $lte: current } }),
    WhatsAppConversa.deleteMany({ expiresAt: { $lte: current } }),
  ]).catch(error => {
    logger.warn("whatsapp_retention_cleanup_failed", {
      code: error?.code || "WHATSAPP_RETENTION_CLEANUP_FAILED",
    });
  });
}

async function processarWebhook(body, { correlationId = null } = {}) {
  const statuses = extrairStatuses(body);
  const incomingMessages = extrairMensagensRecebidas(body);
  if (!statuses.length && !incomingMessages.length) {
    return { processed: 0, statuses: 0 };
  }
  await limparRetencaoSeNecessario();
  for (const item of statuses) {
    await WhatsAppMensagem.updateOne(
      { metaMessageIdHash: messageIdHash(item.id) },
      { $set: { status: item.status } },
    ).catch(error => {
      logger.warn("whatsapp_status_update_failed", {
        correlationId,
        code: error?.code || "WHATSAPP_STATUS_UPDATE_FAILED",
        messageIdSuffix: item.id.slice(-10),
      });
    });
  }

  let processed = 0;
  for (const incoming of incomingMessages) {
    if (mensagemVistaRecentemente(incoming.messageId)) continue;
    try {
      await processarMensagem(incoming, correlationId);
      processed += 1;
    } catch (error) {
      recentMessageIds.delete(messageIdHash(incoming.messageId));
      logger.error("whatsapp_automation_failed", {
        correlationId,
        code: error?.code || "WHATSAPP_AUTOMATION_FAILED",
        providerCode: error?.providerCode || null,
        retryable: Boolean(error?.retryable),
        phoneNumberIdSuffix: incoming.phoneNumberId.slice(-8),
        messageIdSuffix: incoming.messageId.slice(-10),
      });
    }
  }
  return { processed, statuses: statuses.length };
}

module.exports = {
  buscarPedidoRecente,
  extrairMensagensRecebidas,
  extrairStatuses,
  montarStatusPedido,
  phoneNumberIdHash,
  processarWebhook,
  telefonePedidoDoWaId,
  _testing: {
    ehSaudacaoOuInicio,
    encontrarOpcao,
    interactiveReplyId,
    menuOptions,
    montarLinkCatalogo,
    pagamentoTexto,
    statusPedidoTexto,
    textoDaMensagem,
  },
};
