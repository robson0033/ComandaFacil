"use strict";

const DATA_CLASSES = Object.freeze({
  ownerAccount: Object.freeze({
    collection: "registros",
    fields: ["nome", "email", "telefone", "cpfCnpj", "aceiteLegal"],
    purpose: "conta, contrato, segurança e cobrança",
    currentRetention: "sem expiração automática; depende do ciclo da conta e de obrigação aplicável",
    automaticExpiry: false,
    risk: "alto",
  }),
  employees: Object.freeze({
    collection: "funcionarios",
    fields: ["nome", "email", "cpf", "telefone", "endereco", "salario", "foto"],
    purpose: "gestão de acesso e equipe pelo estabelecimento",
    currentRetention: "exclusão manual; sem janela central de retenção",
    automaticExpiry: false,
    risk: "alto",
  }),
  customerOrders: Object.freeze({
    collection: "pedidos",
    fields: [
      "cliente",
      "telefoneCliente",
      "emailCliente",
      "enderecoEntrega",
      "ruaEntrega",
      "numeroEntrega",
      "bairroEntrega",
      "referenciaEntrega",
    ],
    purpose: "execução, entrega, suporte, conciliação e histórico do pedido",
    currentRetention: "arquivamento lógico preserva os dados; sem anonimização automática",
    automaticExpiry: false,
    risk: "alto",
  }),
  printQueue: Object.freeze({
    collection: "printjobs",
    fields: ["snapshot"],
    purpose: "entrega e reconciliação da impressão",
    currentRetention: "sem TTL central; snapshot pode conter telefone e endereço",
    automaticExpiry: false,
    risk: "alto",
  }),
  auditEvents: Object.freeze({
    collection: "auditoriaeventos",
    fields: ["usuarioId", "entidadeId", "dadosResumidos", "registradoEm"],
    purpose: "segurança, rastreabilidade e exercício de direitos",
    currentRetention: "sem TTL; resumo usa lista permitida",
    automaticExpiry: false,
    risk: "medio",
  }),
  sessions: Object.freeze({
    collection: "sessions",
    fields: ["session", "expires"],
    purpose: "autenticação",
    currentRetention: "TTL do armazenamento de sessão",
    automaticExpiry: true,
    risk: "controlado",
  }),
  oauthStates: Object.freeze({
    collection: "oauthstates",
    fields: ["stateHash", "expiresAt"],
    purpose: "proteção temporária do OAuth",
    currentRetention: "TTL em expiresAt",
    automaticExpiry: true,
    risk: "controlado",
  }),
  passwordRecovery: Object.freeze({
    collection: "recuperacoes_senha",
    fields: ["usuario", "tipoUsuario", "codigoHash", "expiresAt"],
    purpose: "recuperação temporária de acesso",
    currentRetention: "TTL em expiresAt",
    automaticExpiry: true,
    risk: "controlado",
  }),
  publicOrderTracking: Object.freeze({
    collection: "pedidos",
    fields: ["acompanhamentoTokenHash", "acompanhamentoTokenExpiraEm"],
    purpose: "acompanhamento público seguro",
    currentRetention: "token em hash com validade limitada; pedido permanece",
    automaticExpiry: false,
    risk: "controlado",
  }),
  backups: Object.freeze({
    collection: "fora do MongoDB",
    fields: ["arquivo de backup e relatórios"],
    purpose: "recuperação de desastre",
    currentRetention: "manual; deve existir calendário e descarte seguro",
    automaticExpiry: false,
    risk: "alto",
  }),
});

const DEFAULT_AUDIT_THRESHOLDS_DAYS = Object.freeze({
  activeOrders: 365,
  archivedOrders: 90,
  printJobs: 90,
  auditEvents: 365,
  inactiveEmployees: 90,
});

function positiveInteger(value, fallback, { min = 1, max = 3650 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function resolveAuditThresholds(env = process.env) {
  return Object.freeze({
    activeOrders: positiveInteger(
      env.PRIVACY_AUDIT_ACTIVE_ORDER_DAYS,
      DEFAULT_AUDIT_THRESHOLDS_DAYS.activeOrders,
    ),
    archivedOrders: positiveInteger(
      env.PRIVACY_AUDIT_ARCHIVED_ORDER_DAYS,
      DEFAULT_AUDIT_THRESHOLDS_DAYS.archivedOrders,
    ),
    printJobs: positiveInteger(
      env.PRIVACY_AUDIT_PRINT_JOB_DAYS,
      DEFAULT_AUDIT_THRESHOLDS_DAYS.printJobs,
    ),
    auditEvents: positiveInteger(
      env.PRIVACY_AUDIT_EVENT_DAYS,
      DEFAULT_AUDIT_THRESHOLDS_DAYS.auditEvents,
    ),
    inactiveEmployees: positiveInteger(
      env.PRIVACY_AUDIT_INACTIVE_EMPLOYEE_DAYS,
      DEFAULT_AUDIT_THRESHOLDS_DAYS.inactiveEmployees,
    ),
  });
}

function cutoffDate(days, now = new Date()) {
  return new Date(now.getTime() - Number(days) * 24 * 60 * 60 * 1000);
}

module.exports = {
  DATA_CLASSES,
  DEFAULT_AUDIT_THRESHOLDS_DAYS,
  cutoffDate,
  resolveAuditThresholds,
};
