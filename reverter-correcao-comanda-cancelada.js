"use strict";
const fs = require("fs");
const path = require("path");
const suffix = ".bak-comanda-cancelada";
const files = [
  "src/controllers/adminRealController.js",
  "src/views/admin-real.ejs",
  "test/mesaPedidoTrocaP0.test.js",
];
for (const rel of files) {
  const current = path.join(process.cwd(), rel);
  const backup = `${current}${suffix}`;
  if (!fs.existsSync(backup)) {
    console.log(`• sem backup: ${rel}`);
    continue;
  }
  fs.copyFileSync(backup, current);
  console.log(`✓ restaurado: ${rel}`);
}
