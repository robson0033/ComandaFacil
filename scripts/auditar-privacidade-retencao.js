"use strict";

const {
  DATA_CLASSES,
  cutoffDate,
  resolveAuditThresholds,
} = require("../src/services/privacyRetentionPolicy");

function createStaticReport() {
  const entries = Object.entries(DATA_CLASSES);
  const automatic = entries.filter(([, item]) => item.automaticExpiry);
  const manual = entries.filter(([, item]) => !item.automaticExpiry);
  const highRisk = entries.filter(([, item]) => item.risk === "alto");
  return {
    dataClasses: entries.length,
    automaticExpiryClasses: automatic.length,
    manualRetentionClasses: manual.length,
    highRiskClasses: highRisk.length,
    automaticExpiryNames: automatic.map(([name]) => name),
    manualRetentionNames: manual.map(([name]) => name),
    highRiskNames: highRisk.map(([name]) => name),
  };
}

async function createDatabaseReport({
  models,
  thresholds,
  now = new Date(),
} = {}) {
  const {
    Pedido,
    PrintJob,
    AuditoriaEvento,
    Funcionario,
  } = models;

  const [
    activeOrdersBeyondThreshold,
    archivedOrdersBeyondThreshold,
    printJobsBeyondThreshold,
    auditEventsBeyondThreshold,
    inactiveEmployeesBeyondThreshold,
  ] = await Promise.all([
    Pedido.countDocuments({
      excluido: { $ne: true },
      createdAt: { $lt: cutoffDate(thresholds.activeOrders, now) },
    }),
    Pedido.countDocuments({
      excluido: true,
      excluidoEm: { $lt: cutoffDate(thresholds.archivedOrders, now) },
    }),
    PrintJob.countDocuments({
      createdAt: { $lt: cutoffDate(thresholds.printJobs, now) },
    }),
    AuditoriaEvento.countDocuments({
      registradoEm: { $lt: cutoffDate(thresholds.auditEvents, now) },
    }),
    Funcionario.countDocuments({
      ativo: false,
      updatedAt: { $lt: cutoffDate(thresholds.inactiveEmployees, now) },
    }),
  ]);

  return {
    thresholds,
    counts: {
      activeOrdersBeyondThreshold,
      archivedOrdersBeyondThreshold,
      printJobsBeyondThreshold,
      auditEventsBeyondThreshold,
      inactiveEmployeesBeyondThreshold,
    },
  };
}

function printReport({ logger = console, staticReport, databaseReport = null }) {
  logger.log(`CLASSES_DE_DADOS=${staticReport.dataClasses}`);
  logger.log(`CLASSES_COM_EXPIRACAO_AUTOMATICA=${staticReport.automaticExpiryClasses}`);
  logger.log(`CLASSES_COM_RETENCAO_MANUAL=${staticReport.manualRetentionClasses}`);
  logger.log(`CLASSES_DE_RISCO_ALTO=${staticReport.highRiskClasses}`);
  logger.log(`EXPIRACAO_AUTOMATICA=${staticReport.automaticExpiryNames.join(",")}`);
  logger.log(`RETENCAO_MANUAL=${staticReport.manualRetentionNames.join(",")}`);
  logger.log(`RISCO_ALTO=${staticReport.highRiskNames.join(",")}`);

  if (databaseReport) {
    const { thresholds, counts } = databaseReport;
    logger.log("AUDITORIA_BANCO=EXECUTADA");
    logger.log(`LIMITE_PEDIDOS_ATIVOS_DIAS=${thresholds.activeOrders}`);
    logger.log(`LIMITE_PEDIDOS_ARQUIVADOS_DIAS=${thresholds.archivedOrders}`);
    logger.log(`LIMITE_PRINTJOBS_DIAS=${thresholds.printJobs}`);
    logger.log(`LIMITE_AUDITORIA_DIAS=${thresholds.auditEvents}`);
    logger.log(`LIMITE_FUNCIONARIOS_INATIVOS_DIAS=${thresholds.inactiveEmployees}`);
    logger.log(`PEDIDOS_ATIVOS_ACIMA_LIMITE=${counts.activeOrdersBeyondThreshold}`);
    logger.log(`PEDIDOS_ARQUIVADOS_ACIMA_LIMITE=${counts.archivedOrdersBeyondThreshold}`);
    logger.log(`PRINTJOBS_ACIMA_LIMITE=${counts.printJobsBeyondThreshold}`);
    logger.log(`EVENTOS_AUDITORIA_ACIMA_LIMITE=${counts.auditEventsBeyondThreshold}`);
    logger.log(`FUNCIONARIOS_INATIVOS_ACIMA_LIMITE=${counts.inactiveEmployeesBeyondThreshold}`);
  } else {
    logger.log("AUDITORIA_BANCO=NAO_EXECUTADA");
    logger.log("AUDITORIA_BANCO_MOTIVO=ALLOW_READONLY_AUDIT_DIFERENTE_DE_TRUE");
  }

  logger.log("OPERACOES_DE_ESCRITA=0");
  logger.log("DADOS_PESSOAIS_EXIBIDOS=NAO");
  logger.log("RETENCAO_AUTOMATICA_DESTRUTIVA=NAO");
  logger.log("REVISAO_TECNICA_ITEM_20=CONCLUIDA");
  logger.log("VALIDACAO_JURIDICA_DOS_PRAZOS=PENDENTE");
}

async function main({
  env = process.env,
  connect = null,
  disconnect = null,
  logger = console,
  models = null,
} = {}) {
  const staticReport = createStaticReport();

  if (env.ALLOW_READONLY_AUDIT !== "true") {
    printReport({ logger, staticReport });
    return {
      exitCode: 0,
      connected: false,
      staticReport,
      databaseReport: null,
    };
  }

  const mongoose = (!connect || !disconnect) ? require("mongoose") : null;
  const connectToDatabase = connect || mongoose.connect.bind(mongoose);
  const disconnectFromDatabase = disconnect || mongoose.disconnect.bind(mongoose);

  const connectionString = String(env.CONNECTIONSTRING || "").trim();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(connectionString)) {
    logger.error("CONNECTIONSTRING não configurada ou inválida.");
    return {
      exitCode: 2,
      connected: false,
      staticReport,
      databaseReport: null,
    };
  }

  await connectToDatabase(connectionString);
  try {
    const resolvedModels = models || require("../src/models/painelModels");
    const thresholds = resolveAuditThresholds(env);
    const databaseReport = await createDatabaseReport({
      models: resolvedModels,
      thresholds,
    });
    printReport({ logger, staticReport, databaseReport });
    return {
      exitCode: 0,
      connected: true,
      staticReport,
      databaseReport,
    };
  } finally {
    await disconnectFromDatabase();
  }
}

if (require.main === module) {
  try {
    require("dotenv").config({ quiet: true });
  } catch {
    // A revisão estática não depende de dotenv.
  }
  main()
    .then(result => {
      process.exitCode = result.exitCode;
    })
    .catch(error => {
      console.error(`Auditoria de privacidade falhou: ${String(error?.message || "erro desconhecido").slice(0, 300)}`);
      process.exitCode = 1;
    });
}

module.exports = {
  createDatabaseReport,
  createStaticReport,
  main,
  printReport,
};
