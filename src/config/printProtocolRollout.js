"use strict";

const mongoose = require("mongoose");

function parseBoolean(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (!["true", "false", "1", "0"].includes(normalized)) {
    throw new Error(`${name} deve ser true ou false.`);
  }
  return normalized === "true" || normalized === "1";
}

function parsePilotIds(value) {
  const ids = [...new Set(
    String(value || "").split(",").map(item => item.trim()).filter(Boolean),
  )];
  if (ids.some(id => !mongoose.isObjectIdOrHexString(id))) {
    throw new Error("PRINT_PROTOCOL_V2_PILOT_ESTABLISHMENT_IDS contém ID inválido.");
  }
  return ids;
}

function validatePrintProtocolRollout(env = process.env) {
  const enabled = parseBoolean(
    env.PRINT_PROTOCOL_V2_ENABLED,
    "PRINT_PROTOCOL_V2_ENABLED",
  );
  const pilotEstablishmentIds = parsePilotIds(
    env.PRINT_PROTOCOL_V2_PILOT_ESTABLISHMENT_IDS,
  );
  return Object.freeze({
    enabled,
    pilotEstablishmentIds: Object.freeze(pilotEstablishmentIds),
    pilotSet: new Set(pilotEstablishmentIds.map(String)),
  });
}

function isPrintProtocolV2EnabledFor(estabelecimentoId, env = process.env) {
  if (
    env.PRINT_PROTOCOL_V2_ENABLED === undefined
    && String(env.NODE_ENV || "").toLowerCase() !== "production"
  ) {
    return true;
  }
  const rollout = validatePrintProtocolRollout(env);
  return rollout.enabled && (
    rollout.pilotSet.size === 0
    || rollout.pilotSet.has(String(estabelecimentoId))
  );
}

module.exports = {
  isPrintProtocolV2EnabledFor,
  parsePilotIds,
  validatePrintProtocolRollout,
};
