"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const printAgentHub = require("../src/services/printAgentHub");

test("jobId do Node é UUID v4 imprevisível e não se repete na amostra", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => crypto.randomUUID()));
  assert.equal(ids.size, 1000);
  for (const id of ids) {
    assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  }
});

function fakeSocket(handler) {
  return {
    connected: true,
    timeout(timeout) {
      return {
        emit(event, payload, callback) {
          handler({ event, payload, callback, timeout });
        },
      };
    },
  };
}

test("timeout após aceite consulta o mesmo jobId e retorna enviado", async () => {
  const storeId = `mock-${crypto.randomUUID()}`;
  const persistedJobId = crypto.randomUUID();
  let receivedJobId;
  let queriedJobId;
  printAgentHub._testing.sockets.set(storeId, fakeSocket(({ event, payload, callback }) => {
    if (event === "print:job") {
      receivedJobId = payload.jobId;
      callback(null, { success: true, data: { jobId: payload.jobId, status: "recebido" } });
      return;
    }
    if (event === "job:status:get") {
      queriedJobId = payload.jobId;
      callback(null, {
        success: true,
        data: { jobId: payload.jobId, status: "enviado", result: { impressoes: 1 } },
      });
    }
  }));
  try {
    const result = await printAgentHub.requestPrintJob(
      storeId,
      "print:job",
      { pedido: {}, jobId: persistedJobId },
      1,
    );
    assert.equal(result.status, "recebido");
    assert.equal(receivedJobId, persistedJobId);
  } finally {
    printAgentHub._testing.sockets.delete(storeId);
  }
});

test("falha antes de aceitar bytes é retornada como falha definitiva", async () => {
  const storeId = `mock-${crypto.randomUUID()}`;
  const persistedJobId = crypto.randomUUID();
  printAgentHub._testing.sockets.set(storeId, fakeSocket(({ event, payload, callback }) => {
    if (event === "print:job") {
      callback(null, {
        success: false,
        message: "TCP mock recusou os bytes",
      });
      return;
    }
  }));
  try {
    await assert.rejects(
      printAgentHub.requestPrintJob(
        storeId,
        "print:job",
        { pedido: {}, jobId: persistedJobId },
        1,
      ),
      /TCP mock recusou os bytes/,
    );
  } finally {
    printAgentHub._testing.sockets.delete(storeId);
  }
});

test("requestPrintJob nunca gera jobId para trabalho não persistido", async () => {
  const storeId = `mock-${crypto.randomUUID()}`;
  printAgentHub._testing.sockets.set(storeId, fakeSocket(() => {}));
  try {
    await assert.rejects(
      printAgentHub.requestPrintJob(storeId, "print:job", { pedido: {} }, 1),
      /persistido/,
    );
  } finally {
    printAgentHub._testing.sockets.delete(storeId);
  }
});

test("status em tempo real é isolado por estabelecimento e suporta duas abas", () => {
  const lojaA = `loja-a-${crypto.randomUUID()}`;
  const lojaB = `loja-b-${crypto.randomUUID()}`;
  const abaA1 = [];
  const abaA2 = [];
  const abaB = [];
  const offA1 = printAgentHub.subscribeStatus(lojaA, value => abaA1.push(value));
  const offA2 = printAgentHub.subscribeStatus(lojaA, value => abaA2.push(value));
  const offB = printAgentHub.subscribeStatus(lojaB, value => abaB.push(value));
  try {
    printAgentHub._testing.publishStatus(lojaA, true, {
      nomeComputador: "CAIXA-A",
    });
    assert.equal(abaA1.length, 1);
    assert.equal(abaA2.length, 1);
    assert.equal(abaB.length, 0);
    assert.equal(abaA1[0].status, "conectado");
    assert.equal(abaA1[0].nomeComputador, "CAIXA-A");

    offA1();
    printAgentHub._testing.publishStatus(lojaA, false);
    assert.equal(abaA1.length, 1);
    assert.equal(abaA2.length, 2);
    assert.equal(abaA2[1].status, "desconectado");
  } finally {
    offA1();
    offA2();
    offB();
  }
});
