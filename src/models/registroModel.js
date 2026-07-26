const mongoose = require("mongoose");
const validator = require("validator");
const bcryptjs = require("bcryptjs");

const registroSchema = new mongoose.Schema({
  nome: {
    type: String,
    required: true,
    trim: true,
  },

  nomeEstabelecimento: {
    type: String,
    required: true,
    trim: true,
  },

  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    unique: true,
  },

  telefone: {
    type: String,
    required: true,
    trim: true,
  },

  cpfCnpj: {
    type: String,
    required: true,
    trim: true,
    unique: true,
  },

  senha: {
    type: String,
    required: true,
  },

  aceiteLegal: {
    aceitouTermos: {
      type: Boolean,
      default: false,
    },
    aceitouPrivacidade: {
      type: Boolean,
      default: false,
    },
    aceitoEm: {
      type: Date,
      default: null,
    },
    versao: {
      type: String,
      default: "",
      trim: true,
    },
    ip: {
      type: String,
      default: "",
      trim: true,
    },
    userAgent: {
      type: String,
      default: "",
      trim: true,
    },
  },
});

const registroModel = mongoose.model("Registro", registroSchema);

class Registro {
  constructor(body, metadata = {}) {
    this.body = body;
    this.metadata = metadata;
    this.errors = [];
    this.user = null;
  }

  async register() {
    this.cleanUp();

    this.validaCampos();
    this.validaAceiteLegal();
    this.validaCpfCnpj();
    this.validaEmail();
    this.validaSenha();

    if (this.errors.length > 0) return;

    await this.userExists();

    if (this.errors.length > 0) return;

    this.criptografaSenha();

    try {
      this.user = await registroModel.create({
        ...this.body,
        aceiteLegal: {
          aceitouTermos: true,
          aceitouPrivacidade: true,
          aceitoEm: new Date(),
          versao: String(this.metadata.versaoTermos || ""),
          ip: String(this.metadata.ipAceite || "").slice(0, 120),
          userAgent: String(this.metadata.userAgentAceite || "").slice(0, 500),
        },
      });
    } catch (error) {
      if (error?.code === 11000) {
        this.errors.push("E-mail, CPF ou CNPJ já cadastrado.");
        return;
      }
      throw error;
    }
  }

  validaCampos() {
    if (!this.body.nome) {
      this.errors.push("Nome é obrigatório.");
    }

    if (!this.body.nomeEstabelecimento) {
      this.errors.push("Nome do estabelecimento é obrigatório.");
    }

    if (!this.body.telefone) {
      this.errors.push("Telefone é obrigatório.");
    }

    if (!this.body.cpfCnpj) {
      this.errors.push("CPF ou CNPJ é obrigatório.");
    }

    if (!this.body.email) {
      this.errors.push("E-mail é obrigatório.");
    }

    if (!this.body.senha) {
      this.errors.push("Senha é obrigatória.");
    }
  }

  validaAceiteLegal() {
    if (!this.body.aceitarTermos) {
      this.errors.push(
        "Para criar a conta, aceite os Termos de Uso e a Política de Privacidade."
      );
    }
  }

  validaCpfCnpj() {
    if (!this.body.cpfCnpj) return;

    const valor = this.body.cpfCnpj.replace(/\D+/g, "");

    if (valor.length === 11) {
      this.validaCpf(valor);
      return;
    }

    if (valor.length === 14) {
      this.validaCnpj(valor);
      return;
    }

    this.errors.push("CPF ou CNPJ inválido.");
  }

  validaCpf(cpf) {
    if (/^(\d)\1{10}$/.test(cpf)) {
      this.errors.push("CPF inválido.");
      return;
    }

    let soma = 0;

    for (let i = 0; i < 9; i++) {
      soma += Number(cpf[i]) * (10 - i);
    }

    let primeiroDigito = 11 - (soma % 11);

    if (primeiroDigito >= 10) {
      primeiroDigito = 0;
    }

    if (primeiroDigito !== Number(cpf[9])) {
      this.errors.push("CPF inválido.");
      return;
    }

    soma = 0;

    for (let i = 0; i < 10; i++) {
      soma += Number(cpf[i]) * (11 - i);
    }

    let segundoDigito = 11 - (soma % 11);

    if (segundoDigito >= 10) {
      segundoDigito = 0;
    }

    if (segundoDigito !== Number(cpf[10])) {
      this.errors.push("CPF inválido.");
    }
  }

  validaCnpj(cnpj) {
    if (/^(\d)\1{13}$/.test(cnpj)) {
      this.errors.push("CNPJ inválido.");
      return;
    }

    const calcularDigito = (cnpjParcial, pesos) => {
      let soma = 0;

      for (let i = 0; i < pesos.length; i++) {
        soma += Number(cnpjParcial[i]) * pesos[i];
      }

      const resto = soma % 11;

      return resto < 2 ? 0 : 11 - resto;
    };

    const primeiroDigito = calcularDigito(
      cnpj.slice(0, 12),
      [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    );

    if (primeiroDigito !== Number(cnpj[12])) {
      this.errors.push("CNPJ inválido.");
      return;
    }

    const segundoDigito = calcularDigito(
      cnpj.slice(0, 13),
      [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    );

    if (segundoDigito !== Number(cnpj[13])) {
      this.errors.push("CNPJ inválido.");
    }
  }

  validaEmail() {
    if (!this.body.email) return;

    this.body.email = this.body.email.toLowerCase().trim();

    if (!validator.isEmail(this.body.email)) {
      this.errors.push("E-mail inválido.");
    }
  }

  validaSenha() {
    if (!this.body.senha) return;

    if (this.body.senha.length < 6 || this.body.senha.length > 15) {
      this.errors.push("A senha precisa ter entre 6 e 15 caracteres.");
    }

    if (this.body.senha !== this.body.confirmarSenha) {
      this.errors.push("As senhas não são iguais.");
    }
  }

  async userExists() {
    const { Funcionario } = require("./painelModels");
    const emailExiste = await registroModel.findOne({
      email: this.body.email,
    });
    const funcionarioExiste = await Funcionario.exists({
      email: this.body.email,
    });

    if (emailExiste || funcionarioExiste) {
      this.errors.push("E-mail já cadastrado.");
    }

    const documentoExiste = await registroModel.findOne({
      cpfCnpj: this.body.cpfCnpj,
    });

    if (documentoExiste) {
      this.errors.push("CPF ou CNPJ já cadastrado.");
    }
  }

  criptografaSenha() {
    const salt = bcryptjs.genSaltSync(10);

    this.body.senha = bcryptjs.hashSync(this.body.senha, salt);

    delete this.body.confirmarSenha;
    delete this.body.aceitarTermos;
  }

  cleanUp() {
    const body = {};

    for (const key of [
      "nome",
      "nomeEstabelecimento",
      "email",
      "telefone",
      "cpfCnpj",
      "senha",
      "confirmarSenha",
      "aceitarTermos",
    ]) {
      body[key] = typeof this.body[key] === "string" ? this.body[key] : "";
    }

    this.body = {
      nome: body.nome.trim(),
      nomeEstabelecimento: body.nomeEstabelecimento.trim(),
      email: body.email.trim(),
      telefone: body.telefone.trim(),
      cpfCnpj: body.cpfCnpj.replace(/\D+/g, ""),
      senha: body.senha,
      confirmarSenha: body.confirmarSenha,
      aceitarTermos: body.aceitarTermos === "on" ? "on" : "",
    };
  }
}

module.exports = {
  Registro,
  registroModel,
};
