"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  MINIMUM_AGENT_VERSION,
  PROTOCOL_VERSION,
  buildJobEnvelope,
  negotiateAgent,
  validateAgentStatus,
} = require("../src/services/printAgentProtocol");

test("handshake aceita agente 1.2.0 com protocolo 2", () => {
  const result = negotiateAgent({
    agentVersion: "1.2.0",
    protocolVersion: PROTOCOL_VERSION,
    supportedProtocolVersions: [PROTOCOL_VERSION],
  });
  assert.equal(result.compatible, true);
  assert.equal(result.negotiatedProtocolVersion, PROTOCOL_VERSION);
});

test("agente antigo, sem lease/protocolo ou versão incompatível exige atualização", () => {
  for (const handshake of [
    { agentVersion: "1.1.1" },
    { agentVersion: MINIMUM_AGENT_VERSION, protocolVersion: 1, supportedProtocolVersions: [1] },
    { agentVersion: "inválida", protocolVersion: 2, supportedProtocolVersions: [2] },
  ]) {
    const result = negotiateAgent(handshake);
    assert.equal(result.compatible, false);
    assert.equal(result.code, "AGENT_UPDATE_REQUIRED");
  }
});

test("envelope exige UUIDs e inclui lease, tentativa, prazo e impressora", () => {
  const jobId = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  const result = buildJobEnvelope({
    jobId,
    leaseId,
    impressoraId: "usb:cozinha",
    attempt: 2,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    modo: "automatica",
    estabelecimento: {},
    pedido: {},
    impressoras: [{}],
  });
  assert.equal(result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(result.jobId, jobId);
  assert.equal(result.leaseId, leaseId);
  assert.equal(result.impressoraId, "usb:cozinha");
});

test("ACK exige lease, protocolo, estado e timestamp válidos", () => {
  const valid = {
    jobId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    protocolVersion: PROTOCOL_VERSION,
    agentVersion: "1.2.0",
    status: "resultado_desconhecido",
    timestamp: new Date().toISOString(),
    impressoraId: "usb:cozinha",
  };
  assert.equal(validateAgentStatus(valid).status, "resultado_desconhecido");
  for (const change of [
    { leaseId: "" },
    { protocolVersion: 1 },
    { status: "falhou" },
    { timestamp: "inválido" },
  ]) {
    assert.throws(() => validateAgentStatus({ ...valid, ...change }));
  }
});
