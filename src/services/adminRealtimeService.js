"use strict";

// Barramento local e leve para avisar os painéis administrativos de que existe
// alguma alteração a consultar. Nenhum dado financeiro/pessoal do pedido é
// transmitido aqui; o navegador continua buscando os dados pela rota autenticada.
//
// Este serviço é propositalmente em memória porque a aplicação atual roda em uma
// única instância Node. O fallback periódico do frontend continua ativo para não
// depender exclusivamente deste sinal e também deixa a migração futura para um
// barramento compartilhado (ex.: Redis) segura.
const listenersByStore = new Map();

function normalizeStoreId(value) {
  return String(value || "").trim();
}

function sanitizeEvent(payload = {}) {
  return {
    timestamp: Date.now(),
    reason: String(payload.reason || "pedido_alterado").slice(0, 80),
    pedidoId: String(payload.pedidoId || "").slice(0, 80),
    mesaId: String(payload.mesaId || "").slice(0, 80),
  };
}

function subscribe(estabelecimentoId, listener) {
  const key = normalizeStoreId(estabelecimentoId);
  if (!key || typeof listener !== "function") return () => {};

  let listeners = listenersByStore.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByStore.set(key, listeners);
  }

  listeners.add(listener);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = listenersByStore.get(key);
    if (!current) return;
    current.delete(listener);
    if (!current.size) listenersByStore.delete(key);
  };
}

function publish(estabelecimentoId, payload = {}) {
  const key = normalizeStoreId(estabelecimentoId);
  const listeners = listenersByStore.get(key);
  if (!key || !listeners?.size) return 0;

  const event = sanitizeEvent(payload);
  let delivered = 0;
  for (const listener of [...listeners]) {
    try {
      listener(event);
      delivered += 1;
    } catch {
      // Um painel desconectando não pode afetar a criação/alteração do pedido.
    }
  }
  return delivered;
}

function listenerCount(estabelecimentoId) {
  return listenersByStore.get(normalizeStoreId(estabelecimentoId))?.size || 0;
}

module.exports = {
  listenerCount,
  publish,
  subscribe,
};
