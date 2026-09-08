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

function historicoTemPagamentoIndividualMesa(pedido = {}) {
  return Array.isArray(pedido.historicoFinanceiro)
    && pedido.historicoFinanceiro.some(item =>
      String(item?.tipo || "") === "pagamento_pedido_mesa");
}

function pedidoMesaPagoMantidoNaComanda(pedido = {}) {
  return Boolean(
    pedido
    && pedido.excluido !== true
    && String(pedido.canal || "") === "mesa"
    && objectIdString(pedido.mesaId)
    && String(pedido.pagamentoStatus || "") === "pago"
    && (
      pedido.manterNaComandaMesa === true
      || historicoTemPagamentoIndividualMesa(pedido)
    )
    && String(pedido.status || "") !== "cancelado"
  );
}

function dataValida(value) {
  if (!value) return null;
  const data = new Date(value);
  return Number.isNaN(data.getTime()) ? null : data;
}

function montarComandasMesaAbertas(pedidos = []) {
  const candidatosPorMesa = new Map();

  for (const pedido of Array.isArray(pedidos) ? pedidos : []) {
    const pendente = pedidoMesaEstaAberto(pedido);
    const pagoSeparado = pedidoMesaPagoMantidoNaComanda(pedido);
    if (!pendente && !pagoSeparado) continue;

    const mesaId = objectIdString(pedido.mesaId);
    if (!candidatosPorMesa.has(mesaId)) candidatosPorMesa.set(mesaId, []);
    candidatosPorMesa.get(mesaId).push(pedido);
  }

  const comandas = [];

  for (const [mesaId, candidatos] of candidatosPorMesa.entries()) {
    const pendentes = candidatos.filter(pedidoMesaEstaAberto);
    if (!pendentes.length) continue;

    // Compatibilidade com pedidos pagos antes desta atualização: um pedido que
    // tenha histórico de "pagamento_pedido_mesa" pode continuar na comanda se
    // ele foi pago depois que a sessão atual da mesa já possuía pedido pendente.
    // O marcador novo (manterNaComandaMesa) não depende desta heurística.
    const inicioReferencia = pendentes
      .map(item => dataValida(item.createdAt))
      .filter(Boolean)
      .sort((a, b) => a - b)[0] || null;

    const pedidosComanda = candidatos.filter(pedido => {
      if (pedidoMesaEstaAberto(pedido)) return true;
      if (pedido.manterNaComandaMesa === true) return true;
      if (!historicoTemPagamentoIndividualMesa(pedido)) return false;
      const pagoEm = dataValida(pedido.pagoIndividualMesaEm || pedido.pagoEm);
      return Boolean(pagoEm && inicioReferencia && pagoEm >= inicioReferencia);
    });

    const primeiro = pedidosComanda[0] || pendentes[0];
    const mesaNumero = primeiro?.mesaId && typeof primeiro.mesaId === "object"
      ? primeiro.mesaId.numero
      : null;
    const mesaSetor = primeiro?.mesaId && typeof primeiro.mesaId === "object"
      ? primeiro.mesaId.setor
      : "";

    const comanda = {
      mesaId,
      mesaNumero: mesaNumero ?? "",
      mesaSetor: mesaSetor || "",
      pedidos: pedidosComanda,
      pedidoIds: pedidosComanda.map(item => String(item._id)),
      quantidadePedidos: pedidosComanda.length,
      quantidadePedidosPendentes: 0,
      quantidadePedidosPagos: 0,
      total: 0,
      primeiroPedidoEm: null,
      ultimoPedidoEm: null,
    };

    for (const pedido of pedidosComanda) {
      if (pedidoMesaEstaAberto(pedido)) {
        comanda.quantidadePedidosPendentes += 1;
        // O total exibido é somente o saldo ainda não pago.
        comanda.total += Number(pedido.total || 0);
      } else {
        comanda.quantidadePedidosPagos += 1;
      }

      const criadoEm = dataValida(pedido.createdAt);
      if (criadoEm) {
        if (!comanda.primeiroPedidoEm || criadoEm < comanda.primeiroPedidoEm) {
          comanda.primeiroPedidoEm = criadoEm;
        }
        if (!comanda.ultimoPedidoEm || criadoEm > comanda.ultimoPedidoEm) {
          comanda.ultimoPedidoEm = criadoEm;
        }
      }
    }

    comanda.pedidos.sort((a, b) => {
      const aTime = dataValida(a?.createdAt)?.getTime() || 0;
      const bTime = dataValida(b?.createdAt)?.getTime() || 0;
      if (aTime !== bTime) return aTime - bTime;
      return String(a?._id || "").localeCompare(String(b?._id || ""));
    });

    comandas.push(comanda);
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
  pedidoMesaPagoMantidoNaComanda,
};
