"use strict";

const crypto = require("crypto");

const PUBLIC_ORDER_LIMITS = Object.freeze({
  maxItems: 50,
  maxTotalQuantity: 200,
  maxAdditionsPerItem: 20,
  maxProductIdLength: 64,
  maxPizzaSizeIdLength: 64,
  maxVariationIdLength: 64,
  maxAdditionIdLength: 64,
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


function publicIdentifier(value, maxLength) {
  const candidate = value && typeof value === "object"
    ? value._id ?? value.id ?? ""
    : value;
  const identifier = String(candidate ?? "").trim();
  return identifier && identifier.length <= maxLength ? identifier : "";
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
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { valid: false, message: "Item do pedido inválido." };
    }

    if (!publicIdentifier(item.produtoId, PUBLIC_ORDER_LIMITS.maxProductIdLength)) {
      return { valid: false, message: "Produto do pedido inválido." };
    }

    const tamanhoPizzaInformado = String(
      item.tamanhoPizzaId
        ?? item.tamanhoId
        ?? item.tamanhoPizza?._id
        ?? item.tamanhoPizza?.id
        ?? "",
    ).trim();
    if (
      tamanhoPizzaInformado
      && !publicIdentifier(tamanhoPizzaInformado, PUBLIC_ORDER_LIMITS.maxPizzaSizeIdLength)
    ) {
      return { valid: false, message: "Tamanho de pizza inválido." };
    }

    const variacaoInformada = String(
      item.variacaoId
        ?? item.opcaoId
        ?? item.variacao?._id
        ?? item.variacao?.id
        ?? "",
    ).trim();
    if (
      variacaoInformada
      && !publicIdentifier(variacaoInformada, PUBLIC_ORDER_LIMITS.maxVariationIdLength)
    ) {
      return { valid: false, message: "Opção do produto inválida." };
    }

    const pizzaMeioAMeio = item.pizzaMeioAMeio === true
      || String(item.pizzaMeioAMeio || "").toLowerCase() === "true";
    if (pizzaMeioAMeio) {
      const sabores = Array.isArray(item.saboresPizza)
        ? item.saboresPizza
        : Array.isArray(item.sabores)
          ? item.sabores
          : [];
      if (sabores.length < 2 || sabores.length > 3) {
        return { valid: false, message: "Escolha dois ou três sabores para a pizza." };
      }
      const idsSabores = sabores.map(sabor =>
        publicIdentifier(sabor?.produtoId ?? sabor, PUBLIC_ORDER_LIMITS.maxProductIdLength),
      );
      if (idsSabores.some(id => !id) || new Set(idsSabores).size !== idsSabores.length) {
        return { valid: false, message: "Escolha sabores diferentes e válidos." };
      }
    }

    const quantity = Number(item.quantidade);
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
    if (hasExcessLength(item.observacao, PUBLIC_ORDER_LIMITS.itemNote)) {
      return { valid: false, message: "A observação de um item está muito longa." };
    }

    if (item.adicionais != null && !Array.isArray(item.adicionais)) {
      return { valid: false, message: "Os adicionais de um item são inválidos." };
    }

    const additions = item.adicionais || [];
    if (additions.length > PUBLIC_ORDER_LIMITS.maxAdditionsPerItem) {
      return {
        valid: false,
        message: `Cada item pode ter no máximo ${PUBLIC_ORDER_LIMITS.maxAdditionsPerItem} adicionais.`,
      };
    }

    const additionIds = new Set();
    for (const addition of additions) {
      const additionId = publicIdentifier(
        addition,
        PUBLIC_ORDER_LIMITS.maxAdditionIdLength,
      );
      if (!additionId) {
        return { valid: false, message: "Adicional do pedido inválido." };
      }
      if (additionIds.has(additionId)) {
        return { valid: false, message: "Não repita o mesmo adicional em um item." };
      }
      additionIds.add(additionId);
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
  publicIdentifier,
  text,
  validateItemsShape,
  validatePublicOrderBase,
};
