"use strict";

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const patchRoot = path.join(__dirname, "patch-files");
const suffix = ".bak-pix-duplo-mesa";

const files = [
  "src/models/painelModels.js",
  "src/services/mesaPixPaymentService.js",
  "src/controllers/mesaPixController.js",
  "src/views/admin-real.ejs",
  "test/mesaPixPagamentoP0.test.js",
];

function fail(message) {
  console.error(`\nERRO: ${message}`);
  process.exitCode = 1;
}

for (const rel of files) {
  const source = path.join(patchRoot, rel);
  if (!fs.existsSync(source)) {
    fail(`Arquivo do patch ausente: ${rel}`);
    return;
  }
}

for (const rel of files) {
  const target = path.join(root, rel);
  if (!fs.existsSync(target)) {
    fail(`Arquivo do projeto ausente: ${rel}`);
    return;
  }
}

const changed = [];
try {
  for (const rel of files) {
    const source = path.join(patchRoot, rel);
    const target = path.join(root, rel);
    const backup = `${target}${suffix}`;
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
    fs.copyFileSync(source, target);
    changed.push(rel);
  }
} catch (error) {
  console.error("\nFalha durante a aplicação. Restaurando arquivos já alterados...");
  for (const rel of changed.reverse()) {
    const target = path.join(root, rel);
    const backup = `${target}${suffix}`;
    if (fs.existsSync(backup)) fs.copyFileSync(backup, target);
  }
  throw error;
}

console.log("\nPix combinado da mesa aplicado com sucesso.");
console.log("\nO que mudou:");
console.log(" - Pix pode ser o 1º ou o 2º meio em 'Combinar 2 pagamentos'.");
console.log(" - O QR Code cobra somente a parte destinada ao Pix.");
console.log(" - A taxa da plataforma é calculada somente sobre a parte Pix.");
console.log(" - O total e a divisão ficam travados enquanto o Pix estiver ativo.");
console.log(" - Depois do Mercado Pago aprovar o Pix, os dois meios são registrados e a mesa é liberada.");
console.log(" - Dinheiro/Cartão continuam dependendo da confirmação do operador no momento de iniciar o combinado.");
console.log(`\nBackups usam o sufixo ${suffix}.`);
console.log("\nRode os testes:");
console.log("NODE_ENV=test node --test test/mesaPagamentoDivididoP0.test.js test/mesaPixPagamentoP0.test.js");
