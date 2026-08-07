"use strict";

const mongoose = require("mongoose");
const {
  Estoque,
  Pedido,
  Produto,
} = require("../src/models/painelModels");

const DEFAULT_BATCH_SIZE = 200;
const MAX_EXAMPLES = 20;
const MAX_FINANCIAL_HISTORY = 500;
const MAX_STOCK_OPERATIONS = 2000;
const CONSUMPTION_STATES = new Set([
  "pendente",
  "baixado",
  "restaurado",
  "falhou",
]);
const STOCK_UNITS = new Set([
  "kg",
  "g",
  "litro",
  "l",
  "ml",
  "unidade",
  "un",
  "caixa",
  "pacote",
]);
const UNIT_GROUP = {
  kg: "massa",
  g: "massa",
  litro: "volume",
  l: "volume",
  ml: "volume",
  unidade: "unidade",
  un: "unidade",
  caixa: "caixa",
  pacote: "pacote",
};

function technicalId(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function createReport() {
  return {
    analyzed: {
      pedidos: 0,
      produtos: 0,
      estoques: 0,
      total: 0,
    },
    problems: {},
  };
}

function addProblem(report, type, document) {
  if (!report.problems[type]) {
    report.problems[type] = { count: 0, examples: [] };
    Object.defineProperty(report.problems[type], "_seen", {
      enumerable: false,
      value: new Set(),
    });
  }
  const problem = report.problems[type];
  const example = {
    id: technicalId(document?._id),
    estabelecimentoId: technicalId(document?.estabelecimentoId),
  };
  const identityKey = `${example.id}:${example.estabelecimentoId}`;
  if (problem._seen.has(identityKey)) return;

  problem._seen.add(identityKey);
  problem.count += 1;
  if (problem.examples.length < MAX_EXAMPLES) {
    problem.examples.push(example);
  }
}

function duplicateValues(values) {
  const seen = new Set();
  for (const value of values) {
    const normalized = technicalId(value);
    if (seen.has(normalized)) return true;
    seen.add(normalized);
  }
  return false;
}

function isValidPositiveNumber(value) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value > 0;
}

function auditOrder(report, pedido, now = new Date()) {
  const consumos = Array.isArray(pedido.estoqueConsumos)
    ? pedido.estoqueConsumos
    : [];
  const snapshotCreated = pedido.estoqueSnapshotCriado === true;
  const lowered = pedido.estoqueBaixado === true;
  const restored = pedido.estoqueRestaurado === true;

  if (lowered && !snapshotCreated) {
    addProblem(report, "pedido_baixado_sem_snapshot", pedido);
  }
  if (lowered && consumos.length === 0) {
    addProblem(report, "pedido_baixado_consumos_ausentes_ou_vazios", pedido);
  }
  if (pedido.estoqueProcessamento === "falhou") {
    addProblem(report, "pedido_processamento_falhou", pedido);
  }
  if (pedido.estoqueProcessamento === "reconciliacao_necessaria") {
    addProblem(report, "pedido_reconciliacao_necessaria", pedido);
  }
  if (lowered && restored) {
    addProblem(report, "pedido_baixado_e_restaurado", pedido);
  }
  if (restored && consumos.some(item => item?.estado === "baixado")) {
    addProblem(report, "pedido_restaurado_com_consumo_baixado", pedido);
  }
  if (lowered && consumos.some(item => item?.estado !== "baixado")) {
    addProblem(report, "pedido_baixado_com_consumo_nao_baixado", pedido);
  }
  if (!lowered && consumos.some(item => item?.estado === "baixado")) {
    addProblem(report, "pedido_nao_baixado_com_consumo_baixado", pedido);
  }
  if (pedido.estoqueProcessamento === "concluido" && !snapshotCreated) {
    addProblem(report, "pedido_concluido_sem_snapshot", pedido);
  }
  if (pedido.estoqueProcessamento === "restaurado" && !restored) {
    addProblem(report, "pedido_estado_restaurado_sem_marcador", pedido);
  }

  const lockId = String(pedido.estoqueLockId || "").trim();
  const lease = pedido.estoqueLockExpiraEm;
  const leaseDate = lease instanceof Date ? lease : lease ? new Date(lease) : null;
  const validLease = leaseDate && !Number.isNaN(leaseDate.getTime());
  if (lockId && validLease && leaseDate <= now) {
    addProblem(report, "lock_expirado_preenchido", pedido);
  }
  if (lockId && !validLease) {
    addProblem(report, "lock_sem_expiracao", pedido);
  }
  if (!lockId && lease !== undefined && lease !== null) {
    addProblem(report, "expiracao_sem_lock", pedido);
  }

  for (const consumo of consumos) {
    if (!consumo?.estoqueId) {
      addProblem(report, "snapshot_estoque_id_ausente", pedido);
    }
    if (!isValidPositiveNumber(consumo?.quantidadeNaUnidadeEstoque)) {
      addProblem(report, "snapshot_quantidade_invalida", pedido);
    }
    if (!String(consumo?.unidadeEstoque || "").trim()) {
      addProblem(report, "snapshot_unidade_vazia", pedido);
    }
    if (!String(consumo?.operationKey || "").trim()) {
      addProblem(report, "snapshot_operation_key_ausente", pedido);
    }
    if (!CONSUMPTION_STATES.has(consumo?.estado)) {
      addProblem(report, "snapshot_estado_invalido", pedido);
    }
  }
  if (duplicateValues(
    consumos
      .map(item => item?.operationKey)
      .filter(value => String(value || "").trim()),
  )) {
    addProblem(report, "snapshot_operation_key_duplicada", pedido);
  }

  const history = Array.isArray(pedido.historicoFinanceiro)
    ? pedido.historicoFinanceiro
    : [];
  if (history.length > MAX_FINANCIAL_HISTORY) {
    addProblem(report, "historico_financeiro_excessivo", pedido);
  }
  for (const entry of history) {
    if (!String(entry?.operationKey || "").trim()) {
      addProblem(report, "historico_operation_key_ausente", pedido);
    }
    if (!entry?.registradoEm) {
      addProblem(report, "historico_registrado_em_ausente", pedido);
    }
  }
  if (duplicateValues(
    history
      .map(item => item?.operationKey)
      .filter(value => String(value || "").trim()),
  )) {
    addProblem(report, "historico_operation_key_duplicada", pedido);
  }
}

function auditStock(report, estoque) {
  const operations = Array.isArray(estoque.estoqueOperacoes)
    ? estoque.estoqueOperacoes
    : [];
  if (operations.length > MAX_STOCK_OPERATIONS) {
    addProblem(report, "estoque_operacoes_excessivo", estoque);
  }
  if (duplicateValues(operations)) {
    addProblem(report, "estoque_operation_key_duplicada", estoque);
  }
  if (!Number.isFinite(estoque.quantidade) || estoque.quantidade < 0) {
    addProblem(report, "estoque_quantidade_negativa_ou_invalida", estoque);
  }
  const unidade = String(estoque.unidade || "").trim().toLowerCase();
  if (!STOCK_UNITS.has(unidade)) {
    addProblem(report, "estoque_unidade_desconhecida", estoque);
  }
}

function auditProduct(report, produto, stockById) {
  const ficha = Array.isArray(produto.fichaTecnica)
    ? produto.fichaTecnica
    : [];
  if (!ficha.length) {
    addProblem(report, "produto_sem_ficha_tecnica", produto);
  }
  if (duplicateValues(
    ficha.map(item => item?.estoqueId).filter(Boolean),
  )) {
    addProblem(report, "ficha_ingrediente_duplicado", produto);
  }
  for (const ingrediente of ficha) {
    if (!isValidPositiveNumber(ingrediente?.quantidade)) {
      addProblem(report, "ficha_quantidade_invalida", produto);
    }
    const estoque = stockById.get(technicalId(ingrediente?.estoqueId));
    if (!estoque) {
      addProblem(report, "ficha_ingrediente_inexistente", produto);
      continue;
    }
    if (technicalId(estoque.estabelecimentoId)
      !== technicalId(produto.estabelecimentoId)) {
      addProblem(report, "ficha_ingrediente_de_outro_estabelecimento", produto);
    }
    const unidadeFicha = String(ingrediente?.unidade || "").toLowerCase();
    const unidadeEstoque = String(estoque.unidade || "").toLowerCase();
    if (!UNIT_GROUP[unidadeFicha]
      || !UNIT_GROUP[unidadeEstoque]
      || UNIT_GROUP[unidadeFicha] !== UNIT_GROUP[unidadeEstoque]) {
      addProblem(report, "ficha_unidade_incompativel", produto);
    }
  }
}

async function scanInBatches(source, onBatch, batchSize = DEFAULT_BATCH_SIZE) {
  let afterId = null;
  let total = 0;
  while (true) {
    const batch = await source.fetchPage({ afterId, limit: batchSize });
    if (!Array.isArray(batch) || batch.length === 0) break;
    await onBatch(batch);
    total += batch.length;
    afterId = batch[batch.length - 1]._id;
    if (batch.length < batchSize) break;
  }
  return total;
}

function modelSource(model, projection) {
  return {
    async fetchPage({ afterId, limit }) {
      const filter = afterId ? { _id: { $gt: afterId } } : {};
      return model.find(filter)
        .select(projection)
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
    },
    async findByIds(ids) {
      if (!ids.length) return [];
      return model.find({ _id: { $in: ids } })
        .select("_id estabelecimentoId unidade")
        .lean();
    },
  };
}

async function runAudit({
  pedidoSource,
  produtoSource,
  estoqueSource,
  batchSize = DEFAULT_BATCH_SIZE,
  now = new Date(),
}) {
  const report = createReport();
  report.analyzed.pedidos = await scanInBatches(
    pedidoSource,
    async batch => batch.forEach(item => auditOrder(report, item, now)),
    batchSize,
  );
  report.analyzed.estoques = await scanInBatches(
    estoqueSource,
    async batch => batch.forEach(item => auditStock(report, item)),
    batchSize,
  );
  report.analyzed.produtos = await scanInBatches(
    produtoSource,
    async batch => {
      const ids = [...new Set(batch.flatMap(produto =>
        (Array.isArray(produto.fichaTecnica) ? produto.fichaTecnica : [])
          .map(item => technicalId(item?.estoqueId))
          .filter(Boolean)))];
      const relatedStocks = await estoqueSource.findByIds(ids);
      const stockById = new Map(
        relatedStocks.map(item => [technicalId(item._id), item]),
      );
      batch.forEach(item => auditProduct(report, item, stockById));
    },
    batchSize,
  );
  report.analyzed.total =
    report.analyzed.pedidos
    + report.analyzed.produtos
    + report.analyzed.estoques;
  return report;
}

async function main({
  env = process.env,
  connect = (...args) => mongoose.connect(...args),
  disconnect = () => mongoose.disconnect(),
  output = console,
} = {}) {
  if (env.ALLOW_READONLY_AUDIT !== "true") {
    output.error(
      "Auditoria bloqueada. Defina ALLOW_READONLY_AUDIT=true explicitamente.",
    );
    return { skipped: true };
  }
  if (env === process.env) {
    require("dotenv").config();
  }
  if (!env.CONNECTIONSTRING) {
    throw new Error("CONNECTIONSTRING não configurada.");
  }
  await connect(env.CONNECTIONSTRING, { autoIndex: false });
  try {
    const report = await runAudit({
      pedidoSource: modelSource(
        Pedido,
        "_id estabelecimentoId estoqueBaixado estoqueRestaurado "
          + "estoqueSnapshotCriado estoqueConsumos estoqueProcessamento "
          + "estoqueLockId estoqueLockExpiraEm historicoFinanceiro",
      ),
      produtoSource: modelSource(
        Produto,
        "_id estabelecimentoId fichaTecnica",
      ),
      estoqueSource: modelSource(
        Estoque,
        "_id estabelecimentoId quantidade unidade +estoqueOperacoes",
      ),
    });
    output.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("Falha na auditoria somente-leitura:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_EXAMPLES,
  addProblem,
  auditOrder,
  auditProduct,
  auditStock,
  createReport,
  main,
  modelSource,
  runAudit,
  scanInBatches,
};
