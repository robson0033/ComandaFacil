"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const queue = require("../src/services/printQueueService");

test("snapshot de impressão preserva endereço estruturado e ponto de referência", async () => {
  const snapshot = await queue.montarSnapshotValidado({
    pedido: {
      _id: "507f1f77bcf86cd799439011",
      codigoPublico: "E6AC48CC",
      canal: "delivery",
      cliente: "Cliente",
      telefoneCliente: "98970067117",
      enderecoEntrega: "rua nova, 03, vila garimpeira",
      ruaEntrega: "rua nova",
      numeroEntrega: "03",
      bairroEntrega: "vila garimpeira",
      referenciaEntrega: "ao lado da casa do cara legal",
      itens: [{
        nome: "Xburguer",
        quantidade: 2,
        preco: 1,
        subtotal: 2,
        adicionais: [],
      }],
      total: 2,
      status: "novo",
      pagamentoStatus: "pendente",
      formaPagamento: "cartao",
      createdAt: new Date("2026-08-03T19:53:09.000Z"),
    },
    configuracao: {
      nomeEstabelecimento: "Mercadinho Moises",
      telefone: "(98) 97006-7117",
      endereco: "rua nova, 03",
      fotoPerfil: "",
    },
    dono: { cpfCnpj: "60596622341" },
    impressora: {
      nome: "EPSON TM-T20X Receipt",
      tipoConexao: "usb",
      deviceName: "EPSON TM-T20X Receipt",
      papel: "80mm",
      modo: "manual_automatica",
      copias: 1,
    },
  });

  assert.equal(snapshot.pedido.endereco, "rua nova, 03, vila garimpeira");
  assert.equal(snapshot.pedido.rua, "rua nova");
  assert.equal(snapshot.pedido.numeroEndereco, "03");
  assert.equal(snapshot.pedido.bairro, "vila garimpeira");
  assert.equal(snapshot.pedido.referencia, "ao lado da casa do cara legal");

  // O protocolo do agente recebe os nomes sanitizados, não os campos internos do model.
  assert.equal(snapshot.pedido.ruaEntrega, undefined);
  assert.equal(snapshot.pedido.numeroEntrega, undefined);
  assert.equal(snapshot.pedido.bairroEntrega, undefined);
  assert.equal(snapshot.pedido.referenciaEntrega, undefined);
});
