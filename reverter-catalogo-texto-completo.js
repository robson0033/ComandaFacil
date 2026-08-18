"use strict";

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const relative = "src/views/catalogo-publico.ejs";
const target = path.join(root, relative);
const backup = `${target}.bak-catalogo-texto-completo`;

if (!fs.existsSync(backup)) {
  console.error(`ERRO: Backup não encontrado: ${relative}.bak-catalogo-texto-completo`);
  process.exitCode = 1;
} else {
  fs.copyFileSync(backup, target);
  console.log(`Catálogo restaurado a partir de ${relative}.bak-catalogo-texto-completo`);
}
