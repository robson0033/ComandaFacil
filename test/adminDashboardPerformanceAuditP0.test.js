"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "audit-dashboard-performance.js");

function source() {
  return fs.readFileSync(SCRIPT, "utf8");
}

test("auditoria de dashboard é explicitamente somente-leitura", () => {
  const text = source();
  assert.match(text, /ALLOW_READONLY_PERF_AUDIT/);
  assert.match(text, /autoIndex:\s*false/);
  assert.match(text, /\.explain\("executionStats"\)/);
  assert.match(text, /\.listIndexes\(\)/);

  const forbidden = [
    ".insertOne(",
    ".insertMany(",
    ".updateOne(",
    ".updateMany(",
    ".replaceOne(",
    ".deleteOne(",
    ".deleteMany(",
    ".createIndex(",
    ".createIndexes(",
    ".dropIndex(",
    ".dropIndexes(",
    ".findOneAndUpdate(",
  ];

  for (const token of forbidden) {
    assert.equal(text.includes(token), false, `operação de escrita encontrada: ${token}`);
  }
});

test("auditoria não conecta ao banco quando apenas importada", () => {
  const mod = require(SCRIPT);
  assert.equal(typeof mod.assertReadonlyEnabled, "function");
  assert.equal(typeof mod.summarizeExplain, "function");
});

test("gate bloqueia execução sem autorização explícita", () => {
  const { assertReadonlyEnabled } = require(SCRIPT);
  assert.throws(
    () => assertReadonlyEnabled({}),
    error => error?.code === "READONLY_PERF_AUDIT_NOT_ALLOWED",
  );
  assert.doesNotThrow(() => assertReadonlyEnabled({ ALLOW_READONLY_PERF_AUDIT: "true" }));
});

test("resumo classifica COLLSCAN como atenção e IXSCAN como OK", () => {
  const { summarizeExplain } = require(SCRIPT);

  const collscan = summarizeExplain({
    queryPlanner: { winningPlan: { stage: "COLLSCAN" } },
    executionStats: {
      nReturned: 2,
      totalDocsExamined: 1000,
      totalKeysExamined: 0,
      executionTimeMillis: 12,
    },
  });
  assert.equal(collscan.status, "ATENCAO");

  const ixscan = summarizeExplain({
    queryPlanner: {
      winningPlan: {
        stage: "FETCH",
        inputStage: { stage: "IXSCAN", indexName: "pedido_tenant_data" },
      },
    },
    executionStats: {
      nReturned: 20,
      totalDocsExamined: 20,
      totalKeysExamined: 20,
      executionTimeMillis: 2,
    },
  });
  assert.equal(ixscan.status, "OK");
  assert.deepEqual(ixscan.indexes, ["pedido_tenant_data"]);
});
