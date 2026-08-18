"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const SUFFIX = ".bak-aprovacao-troca-mesa";
const files = [
  "route.js",
  "src/config/permissions.js",
  "src/models/painelModels.js",
  "src/controllers/adminRealController.js",
  "src/views/mesa-publica.ejs",
  "src/views/admin-real.ejs",
  "test/authAuthorizationAuditP0.test.js",
  "test/mesaPedidoTrocaP0.test.js",
];

let restored = 0;
for (const rel of files) {
  const current = path.join(ROOT, rel);
  const backup = `${current}${SUFFIX}`;
  if (!fs.existsSync(backup)) continue;
  fs.copyFileSync(backup, current);
  restored += 1;
  console.log(`Restaurado: ${rel}`);
}

if (!restored) {
  console.log("Nenhum backup desta alteração foi encontrado.");
} else {
  console.log(`\nRollback concluído: ${restored} arquivo(s) restaurado(s).`);
}
