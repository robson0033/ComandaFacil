"use strict";

const {
  WhatsAppConfiguracao,
  WhatsAppConversa,
  WhatsAppMensagem,
  WhatsAppWebhookEvent,
} = require("../models/painelModels");
const { logger: appLogger } = require("../utils/logger");

const INDEXES = Object.freeze([
  [WhatsAppConfiguracao, { estabelecimentoId: 1 }, { unique: true, name: "whatsapp_config_tenant_unique" }],
  [WhatsAppConfiguracao, { phoneNumberIdHash: 1 }, {
    unique: true,
    partialFilterExpression: { phoneNumberIdHash: { $type: "string", $gt: "" } },
    name: "whatsapp_phone_number_id_hash_unique",
  }],
  [WhatsAppConversa, { estabelecimentoId: 1, clienteWaId: 1 }, {
    unique: true,
    name: "whatsapp_conversa_tenant_cliente_unique",
  }],
  [WhatsAppConversa, { estabelecimentoId: 1, modo: 1, updatedAt: -1 }, {
    name: "whatsapp_conversa_tenant_modo_data",
  }],
  [WhatsAppConversa, { expiresAt: 1 }, {
    expireAfterSeconds: 0,
    name: "whatsapp_conversa_retention_ttl",
  }],
  [WhatsAppMensagem, { metaMessageIdHash: 1 }, {
    unique: true,
    partialFilterExpression: { metaMessageIdHash: { $type: "string", $gt: "" } },
    name: "whatsapp_message_meta_id_unique",
  }],
  [WhatsAppMensagem, { conversaId: 1, createdAt: -1 }, {
    name: "whatsapp_message_conversation_data",
  }],
  [WhatsAppMensagem, { expiresAt: 1 }, {
    expireAfterSeconds: 0,
    name: "whatsapp_message_retention_ttl",
  }],
  [WhatsAppWebhookEvent, { eventKey: 1 }, {
    unique: true,
    name: "whatsapp_webhook_event_key_unique",
  }],
  [WhatsAppWebhookEvent, { status: 1, nextRetryAt: 1, createdAt: 1 }, {
    name: "whatsapp_webhook_event_queue",
  }],
  [WhatsAppWebhookEvent, { expiresAt: 1 }, {
    expireAfterSeconds: 0,
    name: "whatsapp_webhook_event_retention_ttl",
  }],
]);

async function ensureWhatsAppIndexes({ logger = appLogger } = {}) {
  for (const [model, key, options] of INDEXES) {
    try {
      await model.collection.createIndex(key, options);
    } catch (error) {
      logger.error("whatsapp_index_creation_failed", {
        collection: model.collection.collectionName,
        index: options.name,
        code: error?.code || error?.codeName || "WHATSAPP_INDEX_CREATION_FAILED",
      });
      throw error;
    }
  }
  logger.info("whatsapp_indexes_ready", { count: INDEXES.length });
  return { ok: true, count: INDEXES.length };
}

module.exports = {
  INDEXES,
  ensureWhatsAppIndexes,
};
