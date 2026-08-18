"use strict";

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const relative = "src/views/catalogo-publico.ejs";
const target = path.join(root, relative);
const backup = `${target}.bak-catalogo-texto-completo`;
const marker = "COMANDAFACIL: CATALOGO TEXTO COMPLETO v1";

function fail(message) {
  console.error(`\nERRO: ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(target)) {
  fail(`Arquivo não encontrado: ${relative}`);
  return;
}

let source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) {
  console.log("Catálogo já possui a correção de texto completo. Nenhuma alteração necessária.");
  return;
}

const oldName = `      .grid > .product-card .product-name {
        margin: 3px 0 0 !important;
        overflow: hidden !important;
        font-size: 12px !important;
        line-height: 1.15 !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }`;

const newName = `      /* ${marker} - nome */
      .grid > .product-card .product-name {
        margin: 3px 0 0 !important;
        overflow: visible !important;
        font-size: 12px !important;
        line-height: 1.15 !important;
        text-overflow: clip !important;
        white-space: normal !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }`;

const oldDesc = `      .grid > .product-card .product-desc {
        min-height: 23px !important;
        max-height: 23px !important;
        margin: 3px 0 0 !important;
        display: -webkit-box !important;
        overflow: hidden !important;
        -webkit-box-orient: vertical !important;
        -webkit-line-clamp: 2 !important;
        font-size: 8px !important;
        line-height: 1.4 !important;
      }`;

const newDesc = `      /* ${marker} - ingredientes/descrição */
      .grid > .product-card .product-desc {
        min-height: 0 !important;
        max-height: none !important;
        margin: 3px 0 0 !important;
        display: block !important;
        overflow: visible !important;
        -webkit-box-orient: initial !important;
        -webkit-line-clamp: unset !important;
        font-size: 8px !important;
        line-height: 1.4 !important;
        white-space: normal !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }`;

const oldNarrowDesc = `      .grid > .product-card .product-desc {
        min-height: 21px !important;
        max-height: 21px !important;
        font-size: 7.5px !important;
      }`;

const newNarrowDesc = `      .grid > .product-card .product-desc {
        min-height: 0 !important;
        max-height: none !important;
        font-size: 7.5px !important;
      }`;

const replacements = [
  [oldName, newName, "regra mobile do nome do produto"],
  [oldDesc, newDesc, "regra mobile da descrição/ingredientes"],
  [oldNarrowDesc, newNarrowDesc, "regra para celulares estreitos"],
];

for (const [from, , label] of replacements) {
  if (!source.includes(from)) {
    fail(`Não encontrei a ${label}. O arquivo pode estar em uma versão diferente; nenhuma alteração foi gravada.`);
    return;
  }
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(target, backup);
}

for (const [from, to] of replacements) {
  source = source.replace(from, to);
}

fs.writeFileSync(target, source, "utf8");

console.log("\nCorreção aplicada com sucesso SOMENTE no catálogo público.");
console.log(`Arquivo alterado: ${relative}`);
console.log("Agora o nome e a descrição/ingredientes podem crescer em várias linhas no mobile, sem reticências nem corte.");
console.log(`Backup: ${relative}.bak-catalogo-texto-completo`);
