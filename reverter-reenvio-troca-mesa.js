"use strict";
const fs = require("node:fs");
const path = require("node:path");
const ROOT = process.cwd();
const SUFFIX = ".bak-reenvio-troca-mesa";
const targets = [
  "route.js",
  "src/controllers/adminRealController.js",
  "src/views/mesa-publica.ejs",
  "src/views/admin-real.ejs",
  "test/mesaPedidoTrocaP0.test.js",
];
let restored = 0;
for (const rel of targets) {
  const dst = path.join(ROOT, rel);
  const bak = `${dst}${SUFFIX}`;
  if (!fs.existsSync(bak)) continue;
  fs.copyFileSync(bak, dst);
  restored += 1;
}
console.log(`✅ Arquivos restaurados: ${restored}`);
