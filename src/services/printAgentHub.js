const crypto = require("crypto");
const { PrintAgent } = require("../models/painelModels");
const printQueueService = require("./printQueueService");

const sockets = new Map();
const statusListeners = new Map();
let sweepTimer = null;

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
  return {
    type: "print-agent-status",
    connected: Boolean(connected),
    status: connected ? "conectado" : "desconectado",
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
  const namespace = io.of("/print-agent");
  printQueueService.setTransport({
    deliver: (socket, payload) =>
      emitWithAck(socket, "print:job", payload, 5000),
    query: (socket, jobId) =>
      queryJobStatus(socket, jobId),
    wake(estabelecimentoId) {
      const socket = sockets.get(String(estabelecimentoId));
      if (socket?.connected) {
        void printQueueService.drenarFilaDoEstabelecimento(
          estabelecimentoId,
          socket,
        );
      }
    },
  });

  namespace.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token || "").trim();
      const codigo = normalizarCodigo(socket.handshake.auth?.code);

      let agente = null;

      if (token) {
        agente = await PrintAgent.findOne({
          tokenHash: hash(token),
          ativo: true,
        });
      }

      if (!agente && codigo.length === 6) {
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
        }
      }

      if (!agente) {
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

    try {
      agente.nomeComputador = String(
        socket.handshake.auth?.computerName || "",
      ).trim();
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

      socket.emit("agent:ready", { lojaId });
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
        await printQueueService.atualizarStatusDoAgente(lojaId, status);
        if (["enviado", "falhou"].includes(String(status?.status || ""))) {
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
          if (socket.connected) {
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

async function queryJobStatus(socket, jobId) {
  try {
    return await emitWithAck(socket, "job:status:get", { jobId }, 5000);
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
  const socket = sockets.get(String(estabelecimentoId));
  if (!socket?.connected) throw new Error("Agente de impressão desconectado.");

  if (!payload?.jobId) {
    throw new Error("O trabalho precisa estar persistido e possuir jobId.");
  }
  return emitWithAck(socket, event, payload, Math.min(timeout, 5000));
}

function isOnline(estabelecimentoId) {
  return Boolean(sockets.get(String(estabelecimentoId))?.connected);
}

function currentStatus(estabelecimentoId) {
  const socket = sockets.get(String(estabelecimentoId));
  return statusPayload(estabelecimentoId, Boolean(socket?.connected), {
    nomeComputador: socket?.data?.agent?.nomeComputador,
  });
}

function request(
  estabelecimentoId,
  event,
  payload = {},
  timeout = 15000,
) {
  return new Promise((resolve, reject) => {
    const socket = sockets.get(String(estabelecimentoId));

    if (!socket?.connected) {
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

module.exports = {
  init,
  currentStatus,
  isOnline,
  request,
  requestPrintJob,
  subscribeStatus,
  _testing: {
    publishStatus,
    sockets,
    statusListeners,
    statusPayload,
  },
};
