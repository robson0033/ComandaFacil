const crypto = require("crypto");
const { PrintAgent } = require("../models/painelModels");

const sockets = new Map();

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

function init(io) {
  const namespace = io.of("/print-agent");

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

    sockets.set(lojaId, socket);

    try {
      agente.nomeComputador = String(
        socket.handshake.auth?.computerName || "",
      ).trim();
      agente.ultimaConexao = new Date();
      await agente.save();

      // O token precisa ser enviado antes do ready. O Electron só considera
      // a vinculação concluída depois de receber os dois eventos.
      if (socket.data.newToken) {
        socket.emit("agent:token", {
          token: socket.data.newToken,
        });
      }

      socket.emit("agent:ready", { lojaId });
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

    socket.on("disconnect", () => {
      if (sockets.get(lojaId)?.id === socket.id) {
        sockets.delete(lojaId);
      }
    });
  });
}

function isOnline(estabelecimentoId) {
  return Boolean(sockets.get(String(estabelecimentoId))?.connected);
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
  isOnline,
  request,
};
