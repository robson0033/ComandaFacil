const crypto = require("crypto");
const { PrintAgent } = require("../models/painelModels");
const printQueueService = require("./printQueueService");
const {
  MINIMUM_AGENT_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  UUID_PATTERN,
  negotiateAgent,
} = require("./printAgentProtocol");
const {
  isPrintProtocolV2EnabledFor,
} = require("../config/printProtocolRollout");

const sockets = new Map();
const statusListeners = new Map();
let sweepTimer = null;
let shuttingDown = false;

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
}

function normalizarCodigo(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .slice(0, 6);
}

function statusPayload(estabelecimentoId, connected, details = {}) {
  const outdated = Boolean(details.outdated);
  const rolloutEnabled = isPrintProtocolV2EnabledFor(estabelecimentoId);
  return {
    type: "print-agent-status",
    connected: Boolean(connected) && !outdated,
    status: outdated
      ? "desatualizado"
      : (connected
          ? (rolloutEnabled ? "conectado" : "aguardando_ativacao")
          : "desconectado"),
    outdated,
    rolloutEnabled,
    minimumAgentVersion: outdated ? MINIMUM_AGENT_VERSION : "",
    updatedAt: new Date().toISOString(),
    nomeComputador: connected
      ? String(details.nomeComputador || "").trim()
      : "",
  };
}

function publishStatus(estabelecimentoId, connected, details) {
  const lojaId = String(estabelecimentoId);
  const payload = statusPayload(lojaId, connected, details);
  for (const listener of statusListeners.get(lojaId) || []) {
    try {
      listener(payload);
    } catch (error) {
      console.error("Erro ao publicar status do agente:", error);
    }
  }
  return payload;
}

function subscribeStatus(estabelecimentoId, listener) {
  const lojaId = String(estabelecimentoId);
  const listeners = statusListeners.get(lojaId) || new Set();
  listeners.add(listener);
  statusListeners.set(lojaId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) statusListeners.delete(lojaId);
  };
}

function init(io) {
  shuttingDown = false;
  printQueueService.setShuttingDown(false);
  const namespace = io.of("/print-agent");
  printQueueService.setTransport({
    deliver: (socket, payload) =>
      emitWithAck(socket, "print:job", payload, 5000),
    query: (socket, jobId, leaseId) =>
      queryJobStatus(socket, jobId, leaseId),
    wake(estabelecimentoId) {
      const socket = sockets.get(String(estabelecimentoId));
      if (socket?.connected && socket.data?.ready) {
        void printQueueService.drenarFilaDoEstabelecimento(
          estabelecimentoId,
          socket,
        );
      }
    },
  });

  namespace.use(async (socket, next) => {
    if (shuttingDown) return next(new Error("Servidor em encerramento."));
    try {
      const token = String(socket.handshake.auth?.token || "").trim();
      const codigo = normalizarCodigo(socket.handshake.auth?.code);
      const compatibility = negotiateAgent(socket.handshake.auth);
      socket.data.compatibility = compatibility;

      let agente = null;

      if (token) {
        agente = await PrintAgent.findOne({
          tokenHash: hash(token),
          ativo: true,
        });
      }

      if (!agente && codigo.length === 6 && compatibility.compatible) {
        const novoToken = crypto.randomBytes(32).toString("hex");

        // A validação e o consumo do código acontecem na mesma operação.
        // Assim, o mesmo código não pode ser usado por dois computadores.
        agente = await PrintAgent.findOneAndUpdate(
          {
            codigoVinculacao: codigo,
            codigoExpiraEm: { $gt: new Date() },
            ativo: true,
          },
          {
            $set: {
              tokenHash: hash(novoToken),
              codigoVinculacao: "",
              codigoExpiraEm: null,
            },
          },
          {
            returnDocument: "after",
            runValidators: true,
          },
        );

        if (agente) {
          socket.data.newToken = novoToken;
        } else {
          await PrintAgent.updateMany(
            {
              codigoVinculacao: codigo,
              codigoExpiraEm: { $lte: new Date() },
            },
            {
              $set: {
                codigoVinculacao: "",
                codigoExpiraEm: null,
              },
            },
          );
        }
      }

      if (!agente) {
        if (!compatibility.compatible) {
          return next(new Error(
            `Agente desatualizado. Instale a versão ${MINIMUM_AGENT_VERSION} ou superior.`,
          ));
        }
        return next(
          new Error(
            "Código inválido, expirado ou já utilizado. Gere um novo código no painel.",
          ),
        );
      }

      socket.data.agent = agente;
      return next();
    } catch (error) {
      console.error("Erro ao autenticar agente de impressão:", error);
      return next(new Error("Falha ao autenticar agente de impressão."));
    }
  });

  namespace.on("connection", async socket => {
    const agente = socket.data.agent;
    const lojaId = String(agente.estabelecimentoId);
    const compatibility = socket.data.compatibility;

    try {
      agente.nomeComputador = String(
        socket.handshake.auth?.computerName || "",
      ).trim();
      agente.agentVersion = compatibility?.agentVersion || "";
      agente.protocolVersion = compatibility?.protocolVersion || 0;
      agente.protocolCompativel = Boolean(compatibility?.compatible);
      agente.capacidades = Array.isArray(socket.handshake.auth?.capabilities)
        ? socket.handshake.auth.capabilities.map(value => String(value).slice(0, 60)).slice(0, 20)
        : [];
      agente.ultimaConexao = new Date();
      await agente.save();

      const previousSocket = sockets.get(lojaId);
      sockets.set(lojaId, socket);
      if (previousSocket && previousSocket.id !== socket.id) {
        previousSocket.disconnect(true);
      }

      // O token precisa ser enviado antes do ready. O Electron só considera
      // a vinculação concluída depois de receber os dois eventos.
      if (socket.data.newToken) {
        socket.emit("agent:token", {
          token: socket.data.newToken,
        });
      }

      if (!compatibility?.compatible) {
        socket.data.ready = false;
        socket.emit("agent:error", {
          code: "AGENT_UPDATE_REQUIRED",
          message: `Atualização obrigatória: instale o agente ${MINIMUM_AGENT_VERSION} ou superior.`,
        });
        publishStatus(lojaId, false, {
          nomeComputador: agente.nomeComputador,
          outdated: true,
        });
        socket.on("disconnect", () => {
          if (sockets.get(lojaId)?.id === socket.id) {
            sockets.delete(lojaId);
            publishStatus(lojaId, false);
          }
        });
        return;
      }

      socket.on("print:reconcile", async (summary, ack) => {
        try {
          if (sockets.get(lojaId)?.id !== socket.id || !socket.data.ready) {
            return ack({ success: false, message: "Socket do agente não está ativo." });
          }
          const decisions = await printQueueService.reconciliarResumoDoAgente(
            lojaId,
            summary,
          );
          ack({
            success: true,
            data: {
              protocolVersion: PROTOCOL_VERSION,
              decisions,
              timestamp: new Date().toISOString(),
            },
          });
        } catch {
          ack({ success: false, message: "Falha ao reconciliar trabalhos." });
        }
      });

      const ready = await emitWithAck(socket, "agent:ready", {
        protocolVersion: PROTOCOL_VERSION,
        supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        minimumAgentVersion: MINIMUM_AGENT_VERSION,
      }, 5000);
      if (
        Number(ready?.protocolVersion) !== PROTOCOL_VERSION
        || String(ready?.agentVersion || "") !== compatibility.agentVersion
      ) {
        throw new Error("Handshake do agente inválido.");
      }
      socket.data.ready = true;
      publishStatus(lojaId, true, {
        nomeComputador: agente.nomeComputador,
      });
      void printQueueService.drenarFilaDoEstabelecimento(lojaId, socket);
    } catch (error) {
      console.error("Erro ao finalizar conexão do agente:", error);
      socket.disconnect(true);
      return;
    }

    socket.on("agent:printers", async printers => {
      try {
        agente.impressoras = Array.isArray(printers) ? printers : [];
        agente.ultimaConexao = new Date();
        await agente.save();
      } catch (error) {
        console.error("Erro ao salvar impressoras do agente:", error);
      }
    });

    socket.on("job:status", async status => {
      try {
        if (sockets.get(lojaId)?.id !== socket.id || !socket.data.ready) return;
        await printQueueService.atualizarStatusDoAgente(lojaId, status);
        if (["concluido", "falhou_antes_envio"].includes(String(status?.status || ""))) {
          void printQueueService.drenarFilaDoEstabelecimento(lojaId, socket);
        }
      } catch (error) {
        console.error("Erro ao persistir status do trabalho:", error);
      }
    });

    socket.on("disconnect", () => {
      if (sockets.get(lojaId)?.id === socket.id) {
        sockets.delete(lojaId);
        publishStatus(lojaId, false);
      }
    });
  });

  if (!sweepTimer) {
    sweepTimer = setInterval(async () => {
      try {
        await printQueueService.recuperarLeasesExpirados();
        for (const [lojaId, socket] of sockets) {
          if (socket.connected && socket.data?.ready) {
            void printQueueService.drenarFilaDoEstabelecimento(lojaId, socket);
          }
        }
      } catch (error) {
        console.error("Erro no sweep da fila de impressão:", error);
      }
    }, 15000);
    sweepTimer.unref?.();
  }
}

function emitWithAck(socket, event, payload, timeout) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (error, result) => {
      if (error) return reject(new Error("O agente não respondeu a tempo."));
      if (result?.success === false) {
        return reject(new Error(result.message || "Falha no agente."));
      }
      return resolve(result?.data ?? result ?? {});
    });
  });
}

async function queryJobStatus(socket, jobId, leaseId) {
  try {
    return await emitWithAck(socket, "job:status:get", { jobId, leaseId }, 5000);
  } catch (error) {
    if (/não encontrado/i.test(error.message)) {
      return { jobId, status: "nao_encontrado" };
    }
    throw error;
  }
}

async function requestPrintJob(
  estabelecimentoId,
  event,
  payload,
  timeout = 30000,
) {
  if (shuttingDown) throw new Error("Servidor em encerramento.");
  if (!isPrintProtocolV2EnabledFor(estabelecimentoId)) {
    throw new Error("Protocolo de impressão v2 ainda não habilitado para esta loja.");
  }
  const socket = sockets.get(String(estabelecimentoId));
  if (!socket?.connected || !socket.data?.ready) {
    throw new Error("Agente de impressão desconectado ou incompatível.");
  }

  if (
    !UUID_PATTERN.test(String(payload?.jobId || ""))
    || !UUID_PATTERN.test(String(payload?.leaseId || ""))
    || Number(payload?.protocolVersion) !== PROTOCOL_VERSION
  ) {
    throw new Error("O trabalho precisa possuir jobId, leaseId e protocolo válidos.");
  }
  return emitWithAck(socket, event, payload, Math.min(timeout, 5000));
}

function isOnline(estabelecimentoId) {
  const socket = sockets.get(String(estabelecimentoId));
  return Boolean(socket?.connected && socket.data?.ready);
}

function currentStatus(estabelecimentoId) {
  const socket = sockets.get(String(estabelecimentoId));
  return statusPayload(estabelecimentoId, Boolean(socket?.connected && socket.data?.ready), {
    nomeComputador: socket?.data?.agent?.nomeComputador,
    outdated: Boolean(socket?.data?.compatibility?.outdated),
  });
}

function request(
  estabelecimentoId,
  event,
  payload = {},
  timeout = 15000,
) {
  return new Promise((resolve, reject) => {
    if (shuttingDown) {
      reject(new Error("Servidor em encerramento."));
      return;
    }
    const socket = sockets.get(String(estabelecimentoId));

    if (!socket?.connected || !socket.data?.ready) {
      reject(new Error("Agente de impressão desconectado."));
      return;
    }

    socket.timeout(timeout).emit(event, payload, (error, result) => {
      if (error) {
        reject(new Error("O agente não respondeu a tempo."));
        return;
      }

      if (result?.success === false) {
        reject(new Error(result.message || "Falha no agente."));
        return;
      }

      resolve(result?.data ?? result ?? {});
    });
  });
}

function stop() {
  shuttingDown = true;
  printQueueService.setShuttingDown(true);
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  for (const [lojaId, socket] of sockets) {
    publishStatus(lojaId, false);
    socket.disconnect(true);
  }
  sockets.clear();
  statusListeners.clear();
}

module.exports = {
  init,
  currentStatus,
  isOnline,
  request,
  requestPrintJob,
  stop,
  subscribeStatus,
  _testing: {
    publishStatus,
    sockets,
    statusListeners,
    statusPayload,
  },
};
