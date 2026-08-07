'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const arquivos = [
  'src/views/catalogo-publico.ejs',
  'src/views/mesa-publica.ejs',
];

let houveErro = false;

for (const relativo of arquivos) {
  const arquivo = path.join(ROOT, relativo);
  const backup = `${arquivo}.backup-antes-cards-mobile-v2`;

  if (!fs.existsSync(backup)) {
    console.error(`Backup não encontrado: ${path.relative(ROOT, backup)}`);
    houveErro = true;
    continue;
  }

  fs.copyFileSync(backup, arquivo);
  console.log(`Restaurado: ${relativo}`);
}

if (houveErro) process.exitCode = 1;
