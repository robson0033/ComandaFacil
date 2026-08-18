"use strict";

const PERMISSIONS = Object.freeze({
  DASHBOARD: "dashboard",
  PEDIDOS: "pedidos",
  RELATORIOS: "relatorios",
  ESTOQUE: "estoque",
  CATALOGO: "catalogo",
  MESAS: "mesas",
  FUNCIONARIOS: "funcionarios",
  CONFIGURACOES: "configuracoes",
  IMPRIMIR_PEDIDOS: "imprimir_pedidos",
  CONFIGURAR_IMPRESSORAS: "configurar_impressoras",
  ARQUIVAR_PEDIDOS: "arquivar_pedidos",
});

const ALL_PERMISSIONS = new Set(Object.values(PERMISSIONS));
const CRITICAL_PERMISSIONS = new Set([
  PERMISSIONS.FUNCIONARIOS,
  PERMISSIONS.CONFIGURACOES,
  PERMISSIONS.CONFIGURAR_IMPRESSORAS,
  PERMISSIONS.ARQUIVAR_PEDIDOS,
]);

function assertKnownPermission(permission) {
  if (!ALL_PERMISSIONS.has(permission)) {
    throw new Error(`Permissão desconhecida: ${String(permission)}`);
  }
  return permission;
}

module.exports = {
  ALL_PERMISSIONS,
  CRITICAL_PERMISSIONS,
  PERMISSIONS,
  assertKnownPermission,
};
