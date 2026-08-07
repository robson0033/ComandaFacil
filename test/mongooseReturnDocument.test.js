"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const models = require("../src/models/painelModels");
const estoqueService = require("../src/services/estoqueService");

function arquivosJavaScript(diretorio) {
  return fs.readdirSync(diretorio, { withFileTypes: true }).flatMap(entry => {
    const caminho = path.join(diretorio, entry.name);
    if (entry.isDirectory()) return arquivosJavaScript(caminho);
    return entry.isFile() && caminho.endsWith(".js") ? [caminho] : [];
  });
}

test("não restam opções Mongoose new ou returnOriginal no código do projeto", () => {
  const arquivos = [
    ...arquivosJavaScript("src"),
    ...arquivosJavaScript("scripts"),
    "route.js",
  ];
  const ocorrencias = arquivos.flatMap(arquivo => {
    const conteudo = fs.readFileSync(arquivo, "utf8");
    return /\b(?:new|returnOriginal)\s*:\s*(?:true|false)\b/.test(conteudo)
      ? [arquivo]
      : [];
  });
  assert.deepEqual(ocorrencias, []);
});

test("aquisição de lock solicita o documento posterior à atualização", async () => {
  const original = models.Pedido.findOneAndUpdate;
  let options;
  models.Pedido.findOneAndUpdate = async (filter, update, receivedOptions) => {
    options = receivedOptions;
    return { _id: "pedido", ...update.$set };
  };
  try {
    const resultado = await estoqueService._testing.adquirirLock(
      "507f191e810c19729de860ea",
      "baixa",
    );
    assert.equal(options.returnDocument, "after");
    assert.ok(resultado.pedido.estoqueLockId);
  } finally {
    models.Pedido.findOneAndUpdate = original;
  }
});

test("desativação de ingrediente solicita o documento atualizado", () => {
  const source = fs.readFileSync("src/controllers/adminRealController.js", "utf8");
  assert.match(
    source,
    /Estoque\.findOneAndUpdate\([\s\S]*?returnDocument:\s*"after"[\s\S]*?runValidators:\s*true/,
  );
});

