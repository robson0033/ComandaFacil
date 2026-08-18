"use strict";

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const suffix = ".bak-pix-duplo-mesa";
const files = [
  "src/models/painelModels.js",
  "src/services/mesaPixPaymentService.js",
  "src/controllers/mesaPixController.js",
  "src/views/admin-real.ejs",
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

if (!restored) {
  console.log(`Nenhum backup ${suffix} foi encontrado.`);
} else {
  console.log(`\nReversão concluída: ${restored} arquivo(s) restaurado(s).`);
}
