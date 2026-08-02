"use strict";

const crypto = require("crypto");

const PUBLIC_ORDER_LIMITS = Object.freeze({
  maxItems: 50,
  maxTotalQuantity: 200,
  maxAdditionsPerItem: 20,
  client: 120,
  phone: 30,
  email: 254,
  street: 180,
  number: 40,
  neighborhood: 120,
  reference: 240,
  orderNote: 500,
  itemNote: 300,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function hasExcessLength(value, maxLength) {
  return String(value ?? "").trim().length > maxLength;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return UUID_PATTERN.test(key) ? key : "";
}

function hashPublicIdentity(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function validateItemsShape(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { valid: false, message: "O carrinho está vazio." };
  }
  if (items.length > PUBLIC_ORDER_LIMITS.maxItems) {
    return {
      valid: false,
      message: `O pedido pode ter no máximo ${PUBLIC_ORDER_LIMITS.maxItems} itens.`,
    };
  }

  let totalQuantity = 0;
  for (const item of items) {
    const quantity = Number(item?.quantidade);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return { valid: false, message: "Quantidade de produto inválida." };
    }
    totalQuantity += quantity;
    if (totalQuantity > PUBLIC_ORDER_LIMITS.maxTotalQuantity) {
      return {
        valid: false,
        message: `O pedido pode ter no máximo ${PUBLIC_ORDER_LIMITS.maxTotalQuantity} unidades.`,
      };
    }
    if (hasExcessLength(item?.observacao, PUBLIC_ORDER_LIMITS.itemNote)) {
      return { valid: false, message: "A observação de um item está muito longa." };
    }
    if (
      Array.isArray(item?.adicionais)
      && item.adicionais.length > PUBLIC_ORDER_LIMITS.maxAdditionsPerItem
    ) {
      return {
        valid: false,
        message: `Cada item pode ter no máximo ${PUBLIC_ORDER_LIMITS.maxAdditionsPerItem} adicionais.`,
      };
    }
  }

  return { valid: true, totalQuantity };
}

function validatePublicOrderBase(body = {}, { mesa = false } = {}) {
  const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey);
  if (!idempotencyKey) {
    return {
      valid: false,
      code: "IDEMPOTENCY_KEY_INVALID",
      message: "Atualize a página e tente enviar o pedido novamente.",
    };
  }

  const lengthChecks = mesa
    ? [
        [body.cliente, PUBLIC_ORDER_LIMITS.client, "O nome do cliente está muito longo."],
        [body.observacao, PUBLIC_ORDER_LIMITS.orderNote, "A observação do pedido está muito longa."],
      ]
    : [
        [body.cliente, PUBLIC_ORDER_LIMITS.client, "O nome do cliente está muito longo."],
        [body.telefone, PUBLIC_ORDER_LIMITS.phone, "O telefone está muito longo."],
        [body.emailCliente || body.email, PUBLIC_ORDER_LIMITS.email, "O e-mail está muito longo."],
        [body.ruaEntrega, PUBLIC_ORDER_LIMITS.street, "A rua está muito longa."],
        [body.numeroEntrega, PUBLIC_ORDER_LIMITS.number, "O número do endereço está muito longo."],
        [body.bairroEntrega, PUBLIC_ORDER_LIMITS.neighborhood, "O bairro está muito longo."],
        [body.referenciaEntrega, PUBLIC_ORDER_LIMITS.reference, "A referência está muito longa."],
        [body.observacao, PUBLIC_ORDER_LIMITS.orderNote, "A observação do pedido está muito longa."],
      ];

  for (const [value, maxLength, message] of lengthChecks) {
    if (hasExcessLength(value, maxLength)) return { valid: false, message };
  }

  const itemsResult = validateItemsShape(body.itens);
  if (!itemsResult.valid) return itemsResult;

  return {
    valid: true,
    idempotencyKey,
    totalQuantity: itemsResult.totalQuantity,
  };
}

module.exports = {
  PUBLIC_ORDER_LIMITS,
  UUID_PATTERN,
  hashPublicIdentity,
  normalizeIdempotencyKey,
  text,
  validateItemsShape,
  validatePublicOrderBase,
};
