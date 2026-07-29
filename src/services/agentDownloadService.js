"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const AGENT_VERSION = "1.2.0";
const INSTALLER_NAME = `ComandaFacil-Agente-Instalador-${AGENT_VERSION}.exe`;

function enabled(env = process.env) {
  return String(env.PRINT_AGENT_DOWNLOAD_1_2_0_ENABLED || "").toLowerCase() === "true";
}

function sha256(filePath, fsImpl = fs) {
  const hash = crypto.createHash("sha256");
  hash.update(fsImpl.readFileSync(filePath));
  return hash.digest("hex");
}

function resolveValidatedArtifact(env = process.env, fsImpl = fs) {
  if (!enabled(env)) {
    const error = new Error("Instalador 1.2.0 ainda não liberado.");
    error.statusCode = 404;
    throw error;
  }
  const configuredRoot = String(env.PRINT_AGENT_ARTIFACT_DIRECTORY || "").trim();
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new Error("Diretório seguro do instalador não configurado.");
  }
  const root = path.resolve(configuredRoot);
  const installer = path.resolve(root, INSTALLER_NAME);
  const checksumFile = path.resolve(root, `checksums-${AGENT_VERSION}.txt`);
  const approvalFile = path.resolve(root, `homologacao-${AGENT_VERSION}.json`);
  for (const target of [installer, checksumFile, approvalFile]) {
    if (path.dirname(target) !== root) throw new Error("Caminho de artefato inválido.");
    if (!fsImpl.existsSync(target) || !fsImpl.statSync(target).isFile()) {
      const error = new Error("Instalador validado não encontrado.");
      error.statusCode = 404;
      throw error;
    }
  }
  const approval = JSON.parse(fsImpl.readFileSync(approvalFile, "utf8"));
  if (
    approval.version !== AGENT_VERSION
    || approval.platform !== "win32"
    || approval.physicalHomologationApproved !== true
    || approval.buildVerificationApproved !== true
  ) {
    throw new Error("Instalador ainda não possui homologação física aprovada.");
  }
  const expected = fsImpl.readFileSync(checksumFile, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.endsWith(`  ${INSTALLER_NAME}`))
    ?.split(/\s+/)[0]
    ?.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected || "") || sha256(installer, fsImpl) !== expected) {
    throw new Error("Checksum do instalador inválido.");
  }
  return {
    filePath: installer,
    fileName: INSTALLER_NAME,
    checksum: expected,
    size: fsImpl.statSync(installer).size,
    version: AGENT_VERSION,
  };
}

module.exports = {
  AGENT_VERSION,
  INSTALLER_NAME,
  enabled,
  resolveValidatedArtifact,
  sha256,
};
