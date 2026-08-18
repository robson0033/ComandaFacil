"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

function fail(message) {
  console.error(`\n[BLOQUEADO] ${message}\n`);
  process.exit(2);
}

function maskMongoUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "[URI inválida/ocultada]";
  }
}

async function main() {
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const uri = String(process.env.CONNECTIONSTRING || "").trim();

  if (nodeEnv !== "test") {
    fail(`NODE_ENV precisa ser exatamente "test". Atual: ${nodeEnv || "(vazio)"}`);
  }

  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri)) {
    fail("CONNECTIONSTRING ausente ou inválida.");
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    fail("Não foi possível interpretar CONNECTIONSTRING.");
  }

  const dbName = decodeURIComponent(String(parsed.pathname || "").replace(/^\/+/, "")).split("/")[0];
  if (!dbName) {
    fail("A CONNECTIONSTRING precisa informar explicitamente o nome do banco de teste no caminho da URL.");
  }

  const explicitAllowedName = String(process.env.CODEX_TEST_DB_NAME || "").trim();
  const looksLikeTest = /(?:^|[_-])(test|teste|testing|qa|homolog|homologacao|sandbox)(?:$|[_-])/i.test(dbName)
    || /(?:test|teste|testing|homolog|sandbox)/i.test(dbName);

  if (explicitAllowedName) {
    if (dbName !== explicitAllowedName) {
      fail(`Banco atual "${dbName}" não corresponde a CODEX_TEST_DB_NAME="${explicitAllowedName}".`);
    }
  } else if (!looksLikeTest) {
    fail(
      `O banco "${dbName}" não parece ser de teste. Renomeie para algo como comandafacil_test ` +
      `ou defina CODEX_TEST_DB_NAME com o nome EXATO do banco de teste.`,
    );
  }

  const productionUri = String(process.env.CONNECTIONSTRING_PRODUCAO || "").trim();
  if (productionUri && productionUri === uri) {
    fail("CONNECTIONSTRING é idêntica a CONNECTIONSTRING_PRODUCAO.");
  }

  console.log("[SEGURANÇA] Ambiente preliminar aprovado.");
  console.log(`[SEGURANÇA] NODE_ENV=${nodeEnv}`);
  console.log(`[SEGURANÇA] database=${dbName}`);
  console.log(`[SEGURANÇA] uri=${maskMongoUri(uri)}`);
  console.log("[SEGURANÇA] Conectando somente para confirmar o database selecionado...");

  await mongoose.connect(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10000,
  });

  const actualDb = mongoose.connection.name;
  const host = mongoose.connection.host || "(srv/indisponível)";

  if (actualDb !== dbName) {
    await mongoose.disconnect();
    fail(`MongoDB selecionou database "${actualDb}", diferente do esperado "${dbName}".`);
  }

  console.log(`[SEGURANÇA] conexão confirmada: database=${actualDb}, host=${host}`);
  console.log("[SEGURANÇA] Nenhum dado foi criado, alterado ou apagado por esta verificação.");

  await mongoose.disconnect();
}

main().catch(async error => {
  try { await mongoose.disconnect(); } catch {}
  console.error("\n[BLOQUEADO] Falha ao validar banco de teste:", error?.message || error);
  process.exit(2);
});
