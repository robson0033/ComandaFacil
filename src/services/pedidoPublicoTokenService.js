"use strict";

const crypto = require("crypto");
const VALIDADE_TOKEN_MS = 90 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function gerarTokenAcompanhamento(agora = new Date()) {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    hash: hashToken(token),
    criadoEm: new Date(agora),
    expiraEm: new Date(new Date(agora).getTime() + VALIDADE_TOKEN_MS),
  };
}


function gerarTokenAcompanhamentoIdempotente({
  estabelecimentoId,
  canal,
  idempotencyKey,
  agora = new Date(),
  secret = process.env.SESSION_SECRET,
} = {}) {
  const segredo = String(secret || "");
  if (segredo.length < 32) {
    throw new Error("SESSION_SECRET não configurada para idempotência.");
  }
  const material = [
    "public-order-v1",
    String(estabelecimentoId || ""),
    String(canal || ""),
    String(idempotencyKey || ""),
  ].join(":");
  const token = crypto.createHmac("sha256", segredo)
    .update(material)
    .digest("base64url");
  return {
    token,
    hash: hashToken(token),
    criadoEm: new Date(agora),
    expiraEm: new Date(new Date(agora).getTime() + VALIDADE_TOKEN_MS),
  };
}

function tokenTemFormatoValido(token) {
  return TOKEN_PATTERN.test(String(token || ""));
}

function extrairBearerToken(req) {
  const authorization = req?.get?.("authorization")
    ?? req?.headers?.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  return match ? match[1] : null;
}

async function buscarPedidoPorToken({
  estabelecimentoId,
  token,
  agora = new Date(),
  lean = true,
} = {}) {
  if (!estabelecimentoId || !tokenTemFormatoValido(token)) return null;
  const { Pedido } = require("../models/painelModels");
  const query = Pedido.findOne({
    estabelecimentoId,
    acompanhamentoTokenHash: hashToken(token),
    acompanhamentoTokenExpiraEm: { $gt: agora },
    excluido: { $ne: true },
    excluidoEm: null,
  });
  return lean
    ? query
      .select(
        "_id createdAt status pagamentoStatus canal itens.produtoId itens.nome "
        + "itens.quantidade total previsaoEntrega",
      )
      .lean()
    : query;
}

function codigoPublico(pedido) {
  return String(pedido?.codigoPublico || "").toUpperCase();
}

function statusPagamentoPublico(status) {
  return {
    pago: "pago",
    cancelado: "cancelado",
    expirado: "expirado",
    pendente: "pendente",
  }[String(status)] || "pendente";
}

function mensagemPublica(status) {
  return {
    novo: "Pedido recebido.",
    preparo: "Pedido em preparo.",
    pronto: "Pedido pronto.",
    entregue: "Pedido entregue.",
    finalizado: "Pedido finalizado.",
    cancelado: "Pedido cancelado.",
  }[String(status)] || "Acompanhe o andamento do pedido.";
}

function serializarPedidoPublico(pedido) {
  return {
    codigoPublico: codigoPublico(pedido),
    data: pedido.createdAt,
    status: pedido.status,
    pagamentoStatus: statusPagamentoPublico(pedido.pagamentoStatus),
    formaEntrega: pedido.canal,
    itens: (pedido.itens || []).slice(0, 100).map(item => ({
      produtoId: String(item.produtoId || ""),
      nome: String(item.nome || "Item").slice(0, 160),
      quantidade: Number(item.quantidade || 0),
    })),
    subtotalProdutos: Number(
      pedido.subtotalProdutos
      || Math.max(0, Number(pedido.total || 0) - Number(pedido.taxaEntregaCentavos || 0) / 100),
    ),
    taxaEntregaCentavos: Number(pedido.taxaEntregaCentavos || 0),
    total: Number(pedido.total || 0),
    previsao: pedido.previsaoEntrega || null,
    mensagem: mensagemPublica(pedido.status),
  };
}

module.exports = {
  VALIDADE_TOKEN_MS,
  buscarPedidoPorToken,
  codigoPublico,
  extrairBearerToken,
  gerarTokenAcompanhamento,
  gerarTokenAcompanhamentoIdempotente,
  hashToken,
  serializarPedidoPublico,
  tokenTemFormatoValido,
};
