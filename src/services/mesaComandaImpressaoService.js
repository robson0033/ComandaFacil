"use strict";

const crypto = require("crypto");
const { formatarNumeroPedido } = require("./pedidoNumeroService");

function idString(value) {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function numeroPedido(pedido = {}) {
  const sequencial = formatarNumeroPedido(pedido.numeroPedido);
  if (sequencial) return sequencial;
  const codigo = String(pedido.codigoPublico || "").trim();
  if (codigo) return codigo.toUpperCase();
  const id = idString(pedido._id);
  return id ? id.slice(-8).toUpperCase() : "SEM-ID";
}

function dataValida(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ordenarPedidos(pedidos = []) {
  return [...pedidos].sort((a, b) => {
    const aTime = dataValida(a?.createdAt)?.getTime() || 0;
    const bTime = dataValida(b?.createdAt)?.getTime() || 0;
    if (aTime !== bTime) return aTime - bTime;
    return idString(a?._id).localeCompare(idString(b?._id));
  });
}

function construirChaveComanda(pedidos = [], mesaId = "") {
  const estado = ordenarPedidos(pedidos).map(pedido => ({
    id: idString(pedido._id),
    atualizadoEm: dataValida(pedido.updatedAt)?.toISOString() || "",
    total: Number(pedido.total || 0),
    status: String(pedido.status || "novo"),
    itens: (pedido.itens || []).map(item => ({
      nome: String(item?.nome || ""),
      quantidade: Number(item?.quantidade || 0),
      preco: Number(item?.preco || 0),
      subtotal: Number(item?.subtotal || 0),
      observacao: String(item?.observacao || ""),
      tamanhoPizzaId: String(item?.tamanhoPizzaId || ""),
      saboresPizza: (item?.saboresPizza || []).map(sabor => ({
        produtoId: String(sabor?.produtoId || ""),
        nome: String(sabor?.nome || ""),
        preco: Number(sabor?.preco || 0),
      })),
      adicionais: (item?.adicionais || []).map(adicional => ({
        nome: String(adicional?.nome || ""),
        preco: Number(adicional?.preco || 0),
      })),
    })),
  }));

  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ mesaId: String(mesaId || ""), estado }))
    .digest("hex");
}

function montarPedidoComandaMesaParaImpressao({
  pedidos = [],
  mesa = {},
  estabelecimentoId = "",
} = {}) {
  const ordenados = ordenarPedidos(Array.isArray(pedidos) ? pedidos : []);
  if (!ordenados.length) {
    const error = new Error("A mesa não possui pedidos em aberto para imprimir.");
    error.code = "MESA_SEM_PEDIDOS_ABERTOS";
    throw error;
  }

  const mesaId = idString(mesa._id || ordenados[0]?.mesaId);
  const mesaNumero = mesa.numero ?? ordenados[0]?.mesaId?.numero ?? "";
  const mesaSetor = mesa.setor || ordenados[0]?.mesaId?.setor || "";
  const pedidoIds = ordenados.map(pedido => idString(pedido._id)).filter(Boolean);
  const totalCentavos = ordenados.reduce(
    (soma, pedido) => soma + Math.round(Number(pedido.total || 0) * 100),
    0,
  );
  const total = totalCentavos / 100;
  const itens = ordenados.flatMap(pedido => Array.isArray(pedido.itens) ? pedido.itens : []);
  const primeiraData = dataValida(ordenados[0]?.createdAt) || new Date();

  const observacoes = ordenados
    .filter(pedido => String(pedido.observacao || "").trim())
    .map(pedido => `Pedido #${numeroPedido(pedido)}: ${String(pedido.observacao).trim()}`);

  const observacaoComanda = [
    `Comanda da Mesa ${mesaNumero || "?"} com ${ordenados.length} pedido(s).`,
    ...observacoes,
  ].join("\n");

  return {
    ...ordenados[0],
    _id: ordenados[0]._id,
    estabelecimentoId: estabelecimentoId || ordenados[0].estabelecimentoId,
    canal: "mesa",
    mesaId: {
      _id: mesaId,
      numero: mesaNumero,
      setor: mesaSetor,
    },
    codigoPublico: "COMANDA",
    numeroPedido: null,
    numeroPedidoData: "",
    cliente: `Mesa ${mesaNumero || "?"} - ${ordenados.length} pedido(s)`,
    telefoneCliente: "",
    enderecoEntrega: "",
    ruaEntrega: "",
    numeroEntrega: "",
    bairroEntrega: "",
    referenciaEntrega: "",
    cidadeEntregaNome: "",
    cidadeEntregaUf: "",
    observacao: observacaoComanda,
    subtotalProdutos: total,
    taxaEntregaCentavos: 0,
    total,
    status: "aberto",
    pagamentoStatus: "pendente",
    formaPagamento: "nao_informado",
    pagamentos: [],
    pagamentoInformadoEm: null,
    pagoEm: null,
    precisaTroco: false,
    trocoPara: null,
    valorTroco: null,
    createdAt: primeiraData,
    itens,
    documentoTipo: "comanda_mesa",
    comandaMesaId: mesaId,
    comandaChave: construirChaveComanda(ordenados, mesaId),
    comandaQuantidadePedidos: ordenados.length,
    comandaPedidoIds: pedidoIds,
  };
}

module.exports = {
  construirChaveComanda,
  montarPedidoComandaMesaParaImpressao,
};
