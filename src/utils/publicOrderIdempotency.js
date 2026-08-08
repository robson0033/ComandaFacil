"use strict";

const crypto = require("crypto");

function hashPublicOrderPayload(data = {}) {
  const payload = {
    estabelecimentoId: String(data.estabelecimentoId || ""),
    mesaId: String(data.mesaId || ""),
    cliente: String(data.cliente || ""),
    telefoneCliente: String(data.telefoneCliente || ""),
    telefoneNormalizado: String(data.telefoneNormalizado || ""),
    emailCliente: String(data.emailCliente || ""),
    canal: String(data.canal || ""),
    enderecoEntrega: String(data.enderecoEntrega || ""),
    ruaEntrega: String(data.ruaEntrega || ""),
    numeroEntrega: String(data.numeroEntrega || ""),
    bairroEntrega: String(data.bairroEntrega || ""),
    referenciaEntrega: String(data.referenciaEntrega || ""),
    cidadeEntregaId: String(data.cidadeEntregaId || ""),
    cidadeEntregaNome: String(data.cidadeEntregaNome || ""),
    cidadeEntregaUf: String(data.cidadeEntregaUf || ""),
    observacao: String(data.observacao || ""),
    subtotalProdutos: Number(data.subtotalProdutos || 0),
    taxaEntregaCentavos: Number(data.taxaEntregaCentavos || 0),
    total: Number(data.total || 0),
    custo: Number(data.custo || 0),
    formaPagamento: String(data.formaPagamento || ""),
    pagamentos: (data.pagamentos || []).map(item => ({
      formaPagamento: String(item?.formaPagamento || ""),
      valorCentavos: Number(item?.valorCentavos || 0),
    })),
    precisaTroco: Boolean(data.precisaTroco),
    trocoPara: data.trocoPara == null ? null : Number(data.trocoPara),
    valorTroco: data.valorTroco == null ? null : Number(data.valorTroco),
    itens: (data.itens || []).map(item => ({
      produtoId: String(item.produtoId || ""),
      nome: String(item.nome || ""),
      quantidade: Number(item.quantidade || 0),
      preco: Number(item.preco || 0),
      subtotal: Number(item.subtotal || 0),
      observacao: String(item.observacao || ""),
      pizzaMeioAMeio: Boolean(item.pizzaMeioAMeio),
      regraPrecoPizza: String(item.regraPrecoPizza || ""),
      precoBasePizza: item.precoBasePizza == null
        ? null
        : Number(item.precoBasePizza),
      tamanhoPizzaId: String(item.tamanhoPizzaId || ""),
      tamanhoPizzaNome: String(item.tamanhoPizzaNome || ""),
      variacaoId: String(item.variacaoId || ""),
      variacaoNome: String(item.variacaoNome || ""),
      precoBaseVariacao: item.precoBaseVariacao == null
        ? null
        : Number(item.precoBaseVariacao),
      saboresPizza: (item.saboresPizza || []).map(sabor => ({
        produtoId: String(sabor?.produtoId || ""),
        nome: String(sabor?.nome || ""),
        preco: Number(sabor?.preco || 0),
        fracao: Number(sabor?.fracao || 0),
      })),
      adicionais: (item.adicionais || []).map(additional => ({
        nome: String(additional.nome || ""),
        preco: Number(additional.preco || 0),
      })),
    })),
  };

  return crypto.createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function createIdempotencyConflictError() {
  const error = new Error("A chave de idempotência já foi usada com outro pedido.");
  error.name = "IdempotencyConflictError";
  error.code = "IDEMPOTENCY_CONFLICT";
  error.statusCode = 409;
  return error;
}

module.exports = {
  createIdempotencyConflictError,
  hashPublicOrderPayload,
};
