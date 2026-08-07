"use strict";

const PROTOCOL_VERSION = 2;
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([PROTOCOL_VERSION]);
const MINIMUM_AGENT_VERSION = "1.2.0";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_STATUSES = new Set([
  "recebido",
  "validado",
  "aceito",
  "imprimindo",
  "enviado_impressora",
  "concluido",
  "falhou_antes_envio",
  "resultado_desconhecido",
]);

function semverParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || ""));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function negotiateAgent(handshake = {}) {
  const agentVersion = String(handshake.agentVersion || "");
  const protocolVersion = Number(handshake.protocolVersion);
  const supported = Array.isArray(handshake.supportedProtocolVersions)
    ? handshake.supportedProtocolVersions.map(Number).filter(Number.isInteger)
    : [];
  const versionComparison = compareVersions(agentVersion, MINIMUM_AGENT_VERSION);
  const compatible = protocolVersion === PROTOCOL_VERSION
    && supported.includes(PROTOCOL_VERSION)
    && versionComparison !== null
    && versionComparison >= 0;
  return {
    compatible,
    outdated: !compatible,
    agentVersion,
    protocolVersion,
    negotiatedProtocolVersion: compatible ? PROTOCOL_VERSION : null,
    code: compatible ? "AGENT_COMPATIBLE" : "AGENT_UPDATE_REQUIRED",
  };
}

function validateAgentStatus(value = {}) {
  if (!UUID_PATTERN.test(String(value.jobId || ""))) throw new Error("jobId inválido.");
  if (!UUID_PATTERN.test(String(value.leaseId || ""))) throw new Error("leaseId inválido.");
  if (Number(value.protocolVersion) !== PROTOCOL_VERSION) {
    throw new Error("protocolVersion incompatível.");
  }
  if (!AGENT_STATUSES.has(String(value.status || ""))) throw new Error("status inválido.");
  if (Number.isNaN(Date.parse(value.timestamp))) throw new Error("timestamp inválido.");
  return {
    jobId: String(value.jobId),
    leaseId: String(value.leaseId),
    protocolVersion: PROTOCOL_VERSION,
    agentVersion: String(value.agentVersion || "").slice(0, 40),
    status: String(value.status),
    timestamp: new Date(value.timestamp).toISOString(),
    impressoraId: String(value.impressoraId || "").slice(0, 200),
    message: String(value.message || "").slice(0, 1000),
  };
}

function buildJobEnvelope(job) {
  if (!UUID_PATTERN.test(String(job.jobId || ""))) throw new Error("jobId inválido.");
  if (!UUID_PATTERN.test(String(job.leaseId || ""))) throw new Error("leaseId inválido.");
  return {
    protocolVersion: PROTOCOL_VERSION,
    jobId: String(job.jobId),
    leaseId: String(job.leaseId),
    impressoraId: String(job.impressoraId || ""),
    attempt: Math.max(1, Number(job.attempt || 1)),
    deadline: String(job.deadline || ""),
    modo: job.modo,
    estabelecimento: job.estabelecimento,
    pedido: job.pedido,
    impressoras: job.impressoras,
  };
}

module.exports = {
  AGENT_STATUSES,
  MINIMUM_AGENT_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  UUID_PATTERN,
  buildJobEnvelope,
  compareVersions,
  negotiateAgent,
  validateAgentStatus,
};
