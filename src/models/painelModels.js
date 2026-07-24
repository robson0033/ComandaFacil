const mongoose = require("mongoose");

const base = {
  estabelecimentoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Registro",
    required: true,
    index: true,
  },
};
const opts = { timestamps: true };

const Categoria = mongoose.model(
  "Categoria",
  new mongoose.Schema(
    {
      ...base,
      nome: { type: String, required: true, trim: true },
      tipo: { type: String, enum: ["estoque", "catalogo"], required: true },
    },
    opts,
  ),
);

const Estoque = mongoose.model(
  "Estoque",
  new mongoose.Schema(
    {
      ...base,
      nome: { type: String, required: true, trim: true },
      categoriaId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Categoria",
        required: true,
      },
      quantidade: { type: Number, default: 0, min: 0 },
      quantidadeInicial: { type: Number, default: 0, min: 0 },
      minimo: { type: Number, default: 0, min: 0 },
      unidade: { type: String, default: "unidade", trim: true },
      custoUnitario: { type: Number, default: 0, min: 0 },
    },
    opts,
  ),
);

const Produto = mongoose.model(
  "Produto",
  new mongoose.Schema(
    {
      ...base,
      nome: { type: String, required: true, trim: true },
      descricao: { type: String, default: "", trim: true },
      categoriaId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Categoria",
        required: true,
      },
      preco: { type: Number, required: true, min: 0 },
      imagem: { type: String, default: "" },

      custo: { type: Number, default: 0, min: 0 },

      fichaTecnica: [
        {
          estoqueId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Estoque",
            required: true,
          },
          nome: { type: String, required: true, trim: true },
          quantidade: { type: Number, required: true, min: 0.0001 },
          unidade: {
            type: String,
            enum: ["g", "kg", "ml", "l", "un"],
            required: true,
          },
          custoCalculado: { type: Number, default: 0, min: 0 },
        },
      ],

      adicionais: [
        {
          nome: {
            type: String,
            required: true,
            trim: true,
            maxlength: 80,
          },

          preco: {
            type: Number,
            required: true,
            min: 0,
          },

          ativo: {
            type: Boolean,
            default: true,
          },
        },
      ],

      ativo: { type: Boolean, default: true },
    },
    opts,
  ),
);

const Mesa = mongoose.model(
  "Mesa",
  new mongoose.Schema(
    {
      ...base,

      numero: {
        type: Number,
        required: true,
        min: 1,
      },

      capacidade: {
        type: Number,
        default: 1,
        min: 1,
      },

      setor: {
        type: String,
        default: "Salão principal",
        trim: true,
      },

      status: {
        type: String,
        enum: [
          "livre",
          "ocupada",
          "aguardando_pagamento",
          "paga",
          "reservada",
          "inativa",
        ],
        default: "livre",
      },

      token: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },
    },
    opts,
  ),
);

const Funcionario = mongoose.model(
  'Funcionario',
  new mongoose.Schema(
    {
      ...base,

      nome: {
        type: String,
        required: true,
        trim: true,
      },

      cpf: {
        type: String,
        required: true,
        trim: true,
      },

      email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
      },

      telefone: {
        type: String,
        default: '',
        trim: true,
      },

      endereco: {
        type: String,
        default: '',
        trim: true,
      },

      salario: {
        type: Number,
        default: 0,
        min: 0,
      },

      foto: {
        type: String,
        default: '',
      },

      funcao: {
        type: String,
        enum: [
          'gerente',
          'garcom',
          'caixa',
          'cozinha',
          'atendente',
          'entregador',
        ],
        required: true,
      },

      senha: {
        type: String,
        required: true,
      },

      ativo: {
        type: Boolean,
        default: true,
      },

      permissoes: [
        {
          type: String,
          enum: [
            'dashboard',
            'pedidos',
            'relatorios',
            'estoque',
            'catalogo',
            'mesas',
            'funcionarios',
            'configuracoes',
            'imprimir_pedidos',
            'configurar_impressoras',
          ],
        },
      ],
    },
    opts
  )
);

const Configuracao = mongoose.model(
  "Configuracao",
  new mongoose.Schema(
    {
      ...base,
      nomeEstabelecimento: { type: String, required: true, trim: true },
      descricao: { type: String, default: "", trim: true },
      telefone: { type: String, default: "", trim: true },
      endereco: { type: String, default: "", trim: true },
      fotoPerfil: { type: String, default: "" },
      impressoraNome: { type: String, default: "", trim: true },
      impressoraTipo: {
        type: String,
        enum: ["termica", "comum", "rede", ""],
        default: "",
      },
      impressoraEndereco: { type: String, default: "", trim: true },
      impressoraPorta: { type: Number, default: 9100, min: 1, max: 65535 },
      larguraPapel: {
        type: String,
        enum: ["58mm", "80mm", "A4"],
        default: "80mm",
      },
      impressaoAutomatica: { type: Boolean, default: false },
      slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
      },

      impressoraNome: {
        type: String,
        default: "",
        trim: true,
      },

      impressoraTipo: {
        type: String,
        enum: ["rede", "usb", "bluetooth"],
        default: "rede",
      },

      impressoraIp: {
        type: String,
        default: "",
        trim: true,
      },

      impressoraPorta: {
        type: Number,
        default: 9100,
      },

      impressoraPapel: {
        type: String,
        enum: ["58mm", "80mm"],
        default: "80mm",
      },

      impressaoAutomatica: {
        type: Boolean,
        default: false,
      },

      impressoras: {
        type: [
          {
            nome: {
              type: String,
              default: "",
              trim: true,
            },

            tipoConexao: {
              type: String,
              enum: ["usb", "rede"],
              default: "usb",
            },

            deviceName: {
              type: String,
              default: "",
              trim: true,
            },

            ip: {
              type: String,
              default: "",
              trim: true,
            },

            porta: {
              type: Number,
              default: 9100,
              min: 1,
              max: 65535,
            },

            papel: {
              type: String,
              enum: ["58mm", "80mm"],
              default: "80mm",
            },

            modo: {
              type: String,
              enum: [
                "desativada",
                "manual",
                "automatica",
                "manual_automatica",
              ],
              default: "desativada",
            },

            copias: {
              type: Number,
              default: 1,
              min: 1,
              max: 5,
            },

            fontePx: {
              type: Number,
              default: 13,
              min: 8,
              max: 30,
            },

            espacamentoLinhaPx: {
              type: Number,
              default: 4,
              min: 0,
              max: 30,
            },

            espacamentoLetrasPx: {
              type: Number,
              default: 0,
              min: 0,
              max: 10,
            },

            margemSuperiorMm: {
              type: Number,
              default: 2,
              min: 0,
              max: 30,
            },

            margemInferiorMm: {
              type: Number,
              default: 5,
              min: 0,
              max: 80,
            },

            margemEsquerdaMm: {
              type: Number,
              default: 2,
              min: 0,
              max: 20,
            },

            margemDireitaMm: {
              type: Number,
              default: 2,
              min: 0,
              max: 20,
            },

            alturaMaximaMm: {
              type: Number,
              default: 500,
              min: 100,
              max: 3000,
            },

            imprimirLogo: {
              type: Boolean,
              default: true,
            },

            imprimirValores: {
              type: Boolean,
              default: true,
            },

            imprimirEndereco: {
              type: Boolean,
              default: true,
            },

            imprimirCpfCnpj: {
              type: Boolean,
              default: false,
            },

            imprimirObservacoes: {
              type: Boolean,
              default: true,
            },

            corteAutomatico: {
              type: Boolean,
              default: true,
            },
          },
        ],
        default: [],
      },

      horarioAbertura: {
        type: String,
        default: '08:00',
        trim: true,
      },

      horarioFechamento: {
        type: String,
        default: '22:00',
        trim: true,
      },

      diasFuncionamento: {
        type: [Number],
        default: [0, 1, 2, 3, 4, 5, 6],
      },

      mercadoPago: {
        conectado: { type: Boolean, default: false },
        userId: { type: String, default: "", trim: true },
        publicKey: { type: String, default: "", trim: true },
        accessTokenCriptografado: { type: String, default: "", select: false },
        refreshTokenCriptografado: { type: String, default: "", select: false },
        tokenExpiraEm: { type: Date, default: null },
        conectadoEm: { type: Date, default: null },
      },

    },
    opts,
  ),
);

const Pedido = mongoose.model(
  "Pedido",
  new mongoose.Schema(
    {
      ...base,

      mesaId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Mesa",
        default: null,
      },

      cliente: {
        type: String,
        default: "Cliente",
        trim: true,
      },

      telefoneCliente: { type: String, default: "", trim: true },
      telefoneNormalizado: { type: String, default: "", trim: true, index: true },
      emailCliente: { type: String, default: "", trim: true, lowercase: true },
      enderecoEntrega: { type: String, default: "", trim: true },

      canal: {
        type: String,
        enum: ["mesa", "balcao", "delivery", "retirada"],
        default: "mesa",
      },

      itens: [
        {
          produtoId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Produto",
            required: true,
          },

          nome: {
            type: String,
            required: true,
          },

          quantidade: {
            type: Number,
            required: true,
            min: 1,
          },

          preco: {
            type: Number,
            required: true,
            min: 0,
          },

          subtotal: {
            type: Number,
            required: true,
            min: 0,
          },

          adicionais: [
            {
              nome: {
                type: String,
                required: true,
                trim: true,
              },

              preco: {
                type: Number,
                required: true,
                min: 0,
              },
            },
          ],

          observacao: {
            type: String,
            default: "",
            trim: true,
          },
        },
      ],

      observacao: {
        type: String,
        default: "",
        trim: true,
      },

      total: {
        type: Number,
        default: 0,
        min: 0,
      },

      custo: {
        type: Number,
        default: 0,
        min: 0,
      },

      status: {
        type: String,
        enum: [
          "novo",
          "preparo",
          "pronto",
          "entregue",
          "finalizado",
          "cancelado",
        ],
        default: "novo",
      },

      pagamentoStatus: {
        type: String,
        enum: ["pendente", "pago", "cancelado"],
        default: "pendente",
      },

      formaPagamento: {
        type: String,
        enum: ["dinheiro", "pix", "cartao", "nao_informado"],
        default: "nao_informado",
      },

      pagoEm: {
        type: Date,
        default: null,
      },

      pagamentoInformadoEm: {
        type: Date,
        default: null,
      },

      precisaTroco: {
        type: Boolean,
        default: false,
      },

      trocoPara: {
        type: Number,
        default: null,
        min: 0,
      },

      valorTroco: {
        type: Number,
        default: null,
        min: 0,
      },

      mercadoPagoPaymentId: { type: String, default: "", index: true },
      mercadoPagoStatus: { type: String, default: "" },
      pixCopiaCola: { type: String, default: "" },
      pixQrCodeBase64: { type: String, default: "" },
      pixExpiraEm: { type: Date, default: null },

    },
    opts,
  ),
);



const Avaliacao = mongoose.model(
  "Avaliacao",
  new mongoose.Schema(
    {
      ...base,

      pedidoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Pedido",
        required: true,
        index: true,
      },

      mesaId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Mesa",
        default: null,
        index: true,
      },

      produtoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Produto",
        required: true,
        index: true,
      },

      cliente: {
        type: String,
        default: "Cliente",
        trim: true,
      },

      nota: {
        type: Number,
        required: true,
        min: 1,
        max: 5,
      },

      comentario: {
        type: String,
        default: "",
        trim: true,
        maxlength: 500,
      },
    },
    opts,
  ),
);

Avaliacao.schema.index(
  {
    pedidoId: 1,
    produtoId: 1,
  },
  {
    unique: true,
  },
);

const Assinatura = mongoose.model(
  "Assinatura",
  new mongoose.Schema(
    {
      ...base,
      status: {
        type: String,
        enum: ["teste", "ativa", "pendente", "expirada", "cancelada"],
        default: "teste",
        index: true,
      },
      metodo: {
        type: String,
        enum: ["teste", "cartao", "pix"],
        default: "teste",
      },
      inicioTeste: { type: Date, default: Date.now },
      fimTeste: { type: Date, required: true },
      planoInicio: { type: Date, default: null },
      planoExpira: { type: Date, default: null },
      mercadoPagoPreapprovalId: { type: String, default: "" },
      mercadoPagoPaymentId: { type: String, default: "" },
      ultimoStatusMercadoPago: { type: String, default: "" },
    },
    opts,
  ),
);


const PrintAgent = mongoose.model(
  "PrintAgent",
  new mongoose.Schema({
    ...base,
    tokenHash: { type: String, default: "", index: true },
    codigoVinculacao: { type: String, default: "" },
    codigoExpiraEm: { type: Date, default: null },
    nomeComputador: { type: String, default: "" },
    impressoras: { type: Array, default: [] },
    ultimaConexao: { type: Date, default: null },
    ativo: { type: Boolean, default: true },
  }, opts),
);

module.exports = {
  Categoria,
  Estoque,
  Produto,
  Mesa,
  Funcionario,
  Configuracao,
  Pedido,
  Avaliacao,
  Assinatura,
  PrintAgent,
};