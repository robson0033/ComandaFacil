"use strict";

function objectIdString(value) {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function pedidoMesaEstaAberto(pedido = {}) {
  return Boolean(
    pedido
    && pedido.excluido !== true
    && String(pedido.canal || "") === "mesa"
    && objectIdString(pedido.mesaId)
    && String(pedido.pagamentoStatus || "pendente") === "pendente"
    && String(pedido.status || "novo") !== "cancelado"
  );
}

function montarComandasMesaAbertas(pedidos = []) {
  const porMesa = new Map();

  for (const pedido of Array.isArray(pedidos) ? pedidos : []) {
    if (!pedidoMesaEstaAberto(pedido)) continue;

    const mesaId = objectIdString(pedido.mesaId);
    const mesaNumero = pedido.mesaId && typeof pedido.mesaId === "object"
      ? pedido.mesaId.numero
      : null;
    const mesaSetor = pedido.mesaId && typeof pedido.mesaId === "object"
      ? pedido.mesaId.setor
      : "";

    let comanda = porMesa.get(mesaId);
    if (!comanda) {
      comanda = {
        mesaId,
        mesaNumero: mesaNumero ?? "",
        mesaSetor: mesaSetor || "",
        pedidos: [],
        pedidoIds: [],
        quantidadePedidos: 0,
        total: 0,
        primeiroPedidoEm: null,
        ultimoPedidoEm: null,
      };
      porMesa.set(mesaId, comanda);
    }

    comanda.pedidos.push(pedido);
    comanda.pedidoIds.push(String(pedido._id));
    comanda.quantidadePedidos += 1;
    comanda.total += Number(pedido.total || 0);

    const criadoEm = pedido.createdAt ? new Date(pedido.createdAt) : null;
    if (criadoEm && !Number.isNaN(criadoEm.getTime())) {
      if (!comanda.primeiroPedidoEm || criadoEm < comanda.primeiroPedidoEm) {
        comanda.primeiroPedidoEm = criadoEm;
      }
      if (!comanda.ultimoPedidoEm || criadoEm > comanda.ultimoPedidoEm) {
        comanda.ultimoPedidoEm = criadoEm;
      }
    }
  }

  const comandas = [...porMesa.values()];
  for (const comanda of comandas) {
    comanda.pedidos.sort((a, b) => {
      const aTime = new Date(a?.createdAt || 0).getTime() || 0;
      const bTime = new Date(b?.createdAt || 0).getTime() || 0;
      if (aTime !== bTime) return aTime - bTime;
      return String(a?._id || "").localeCompare(String(b?._id || ""));
    });
  }

  comandas.sort((a, b) => {
    const aTime = a.ultimoPedidoEm?.getTime?.() || 0;
    const bTime = b.ultimoPedidoEm?.getTime?.() || 0;
    if (aTime !== bTime) return bTime - aTime;
    return String(a.mesaNumero).localeCompare(String(b.mesaNumero), "pt-BR", {
      numeric: true,
      sensitivity: "base",
    });
  });

  return comandas;
}

function filtrarComandasMesaParaPainel(
  comandas = [],
  { canal = "todos", status = "todos" } = {},
) {
  const canalNormalizado = String(canal || "todos");
  const statusNormalizado = String(status || "todos");

  if (!["todos", "mesa"].includes(canalNormalizado)) return [];

  return (Array.isArray(comandas) ? comandas : []).filter(comanda => {
    if (statusNormalizado === "todos") return true;
    return (comanda.pedidos || []).some(
      pedido => String(pedido?.status || "novo") === statusNormalizado,
    );
  });
}

module.exports = {
  filtrarComandasMesaParaPainel,
  montarComandasMesaAbertas,
  pedidoMesaEstaAberto,
};
