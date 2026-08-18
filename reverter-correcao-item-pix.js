"use strict";

const fs = require("fs");
const path = require("path");
const root = process.cwd();
const suffix = ".bak-correcao-item-pix";
const files = [
  "src/models/painelModels.js",
  "src/controllers/adminRealController.js",
  "src/views/mesa-publica.ejs",
  "src/views/admin-real.ejs",
  "test/mesaPedidoTrocaP0.test.js",
  "test/mesaPixPagamentoP0.test.js",
];
let restored = 0;
for (const rel of files) {
  const target = path.join(root, rel);
  const backup = `${target}${suffix}`;
  if (!fs.existsSync(backup)) continue;
  fs.copyFileSync(backup, target);
  restored += 1;
  console.log(`Restaurado: ${rel}`);
}
console.log(`\n${restored} arquivo(s) restaurado(s).`);
