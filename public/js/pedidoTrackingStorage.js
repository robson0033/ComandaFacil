"use strict";

(function carregarPedidoTrackingStorage(globalScope) {
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
  const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const MAX_ITEMS = 50;

  function normalizar(registros, agora = Date.now()) {
    const agoraMs = agora instanceof Date ? agora.getTime() : Number(agora);
    const tokens = new Set();
    const codigos = new Set();
    return (Array.isArray(registros) ? registros : [])
      .filter(item => {
        if (!item
            || typeof item.codigoPublico !== "string"
            || typeof item.token !== "string"
            || typeof item.criadoEm !== "string") return false;
        const criadoEm = Date.parse(item.criadoEm);
        if (!Number.isFinite(criadoEm)
            || !Number.isFinite(agoraMs)
            || criadoEm > agoraMs
            || agoraMs - criadoEm > MAX_AGE_MS
            || !TOKEN_PATTERN.test(item.token)) return false;
        if (tokens.has(item.token) || codigos.has(item.codigoPublico)) {
          return false;
        }
        tokens.add(item.token);
        codigos.add(item.codigoPublico);
        return true;
      })
      .slice(0, MAX_ITEMS)
      .map(item => ({
        codigoPublico: item.codigoPublico,
        token: item.token,
        criadoEm: item.criadoEm,
      }));
  }

  const api = { MAX_AGE_MS, MAX_ITEMS, normalizar };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalScope) globalScope.PedidoTrackingStorage = api;
}(typeof window !== "undefined" ? window : null));
