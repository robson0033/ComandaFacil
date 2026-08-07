const mongoose = require("mongoose");

const recuperacaoSenhaSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    tipoUsuario: {
      type: String,
      enum: ["proprietario", "funcionario"],
      required: true,
    },
    usuarioId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    codigoHash: {
      type: String,
      required: true,
    },
    tokenHash: {
      type: String,
      default: "",
    },
    tentativas: {
      type: Number,
      default: 0,
    },
    verificado: {
      type: Boolean,
      default: false,
    },
    usado: {
      type: Boolean,
      default: false,
    },
    criadoEm: {
      type: Date,
      default: Date.now,
      index: true,
    },
    expiraEm: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
  },
  {
    collection: "recuperacoes_senha",
  },
);

recuperacaoSenhaSchema.index({ email: 1, criadoEm: -1 });

const RecuperacaoSenha = mongoose.model(
  "RecuperacaoSenha",
  recuperacaoSenhaSchema,
);

module.exports = RecuperacaoSenha;
