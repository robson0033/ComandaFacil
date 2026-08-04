"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  isPrintProtocolV2EnabledFor,
  validatePrintProtocolRollout,
} = require("../src/config/printProtocolRollout");
const {
  AGENT_VERSION,
  INSTALLER_NAME,
  resolveValidatedArtifact,
} = require("../src/services/agentDownloadService");

const STORE_A = "507f1f77bcf86cd799439011";
const STORE_B = "507f191e810c19729de860ea";

test("flag desativada preserva fila e piloto isola estabelecimentos", () => {
  assert.equal(isPrintProtocolV2EnabledFor(STORE_A, {
    NODE_ENV: "production",
    PRINT_PROTOCOL_V2_ENABLED: "false",
  }), false);
  const pilotEnv = {
    NODE_ENV: "production",
    PRINT_PROTOCOL_V2_ENABLED: "true",
    PRINT_PROTOCOL_V2_PILOT_ESTABLISHMENT_IDS: STORE_A,
  };
  assert.equal(isPrintProtocolV2EnabledFor(STORE_A, pilotEnv), true);
  assert.equal(isPrintProtocolV2EnabledFor(STORE_B, pilotEnv), false);
  assert.throws(
    () => validatePrintProtocolRollout({
      PRINT_PROTOCOL_V2_ENABLED: "true",
      PRINT_PROTOCOL_V2_PILOT_ESTABLISHMENT_IDS: "../../outra-loja",
    }),
    /ID inválido/,
  );
});

test("agente 1.1.1 não recebe protocolo v2", async () => {
  const negotiation = require("../src/services/printAgentProtocol").negotiateAgent({
    agentVersion: "1.1.1",
    protocolVersion: 1,
    supportedProtocolVersions: [1],
  });
  assert.equal(negotiation.compatible, false);
  assert.equal(negotiation.outdated, true);
});

test("download exige flag, nome fixo, checksum e homologação Windows", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-download-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = Buffer.from("MZ-install-fixture");
  const digest = crypto.createHash("sha256").update(installer).digest("hex");
  fs.writeFileSync(path.join(root, INSTALLER_NAME), installer);
  fs.writeFileSync(
    path.join(root, `checksums-${AGENT_VERSION}.txt`),
    `${digest}  ${INSTALLER_NAME}\n`,
  );
  fs.writeFileSync(
    path.join(root, `homologacao-${AGENT_VERSION}.json`),
    JSON.stringify({
      version: AGENT_VERSION,
      platform: "win32",
      physicalHomologationApproved: true,
      buildVerificationApproved: true,
    }),
  );
  assert.throws(() => resolveValidatedArtifact({
    PRINT_AGENT_DOWNLOAD_1_2_0_ENABLED: "false",
    PRINT_AGENT_ARTIFACT_DIRECTORY: root,
  }), /não liberado/);
  const artifact = resolveValidatedArtifact({
    PRINT_AGENT_DOWNLOAD_1_2_0_ENABLED: "true",
    PRINT_AGENT_ARTIFACT_DIRECTORY: root,
  });
  assert.equal(artifact.fileName, INSTALLER_NAME);
  assert.equal(artifact.checksum, digest);
});

test("rota é fixa, autenticada e aponta para o release atual do agente", () => {
  const route = fs.readFileSync(path.resolve(__dirname, "../route.js"), "utf8");
  const view = fs.readFileSync(
    path.resolve(__dirname, "../src/views/admin-real.ejs"),
    "utf8",
  );
  assert.match(route, /\/admin\/agente\/download\/1\.2\.0/);
  assert.match(route, /download\/1\.2\.0'.*loginRequired/);
  assert.doesNotMatch(route, /download\/:.*path|download\/\*/);
  assert.match(view, /releases\/latest\/download\/agente\.7z/);
  assert.match(view, /data-staged-agent-version="1\.2\.0"/);
});
