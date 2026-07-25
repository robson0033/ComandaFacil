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
      estoqueOperacoes: {
        type: [String],
        default: [],
        select: false,
      },
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
        enum: ["termica", "comum", "rede", "usb", "bluetooth", ""],
        default: "rede",
      },
      impressoraEndereco: { type: String, default: "", trim: true },
      impressoraIp: { type: String, default: "", trim: true },
      impressoraPorta: { type: Number, default: 9100, min: 1, max: 65535 },
      larguraPapel: {
        type: String,
        enum: ["58mm", "80mm", "A4"],
        default: "80mm",
      },
      impressoraPapel: {
        type: String,
        enum: ["58mm", "80mm"],
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
        scope: { type: String, default: "", trim: true },
        conectadoPor: {
          type: mongoose.Schema.Types.ObjectId,
          default: null,
        },
        desconectadoEm: { type: Date, default: null },
        desconectadoPor: {
          type: mongoose.Schema.Types.ObjectId,
          default: null,
        },
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
      estoqueBaixado: { type: Boolean, default: false },
      estoqueBaixadoEm: { type: Date, default: null },

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
      estoqueProcessamento: {
        type: String,
        enum: ["pendente", "processando", "concluido", "falhou"],
        default: "pendente",
      },
      estoqueProcessamentoEm: { type: Date, default: null },
      estoqueErro: { type: String, default: "" },
      pagamentoInconsistente: { type: Boolean, default: false },
      pagamentoInconsistencia: { type: String, default: "" },
      historicoFinanceiro: [{
        paymentId: { type: String, default: "" },
        status: { type: String, default: "" },
        registradoEm: { type: Date, default: Date.now },
      }],

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
        enum: [
          "teste",
          "pendente",
          "ativa",
          "atrasada",
          "cancelada",
          "expirada",
          "reembolsada",
        ],
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
      proximaCobranca: { type: Date, default: null },
      mercadoPagoPreapprovalId: { type: String, default: "" },
      mercadoPagoPreapprovalCriadoEm: { type: Date, default: null },
      mercadoPagoPaymentId: { type: String, default: "" },
      mercadoPagoPaymentCriadoEm: { type: Date, default: null },
      ultimoStatusMercadoPago: { type: String, default: "" },
      ultimoPagamentoAprovadoId: { type: String, default: "" },
      ultimoPagamentoAprovadoEm: { type: Date, default: null },
      ultimoEventoFinanceiroEm: { type: Date, default: null },
      ultimoEventoFinanceiroKey: { type: String, default: "" },
      historicoFinanceiro: [{
        paymentId: { type: String, default: "" },
        preapprovalId: { type: String, default: "" },
        status: { type: String, default: "" },
        aprovadoEm: { type: Date, default: null },
        registradoEm: { type: Date, default: Date.now },
      }],
    },
    opts,
  ),
);

const assinaturaTentativaSchema = new mongoose.Schema(
  {
    attemptId: { type: String, required: true, immutable: true },
    ...base,
    assinaturaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assinatura",
      required: true,
      index: true,
    },
    metodo: { type: String, enum: ["cartao", "pix"], required: true },
    status: {
      type: String,
      enum: [
        "criando",
        "pending",
        "authorized",
        "approved",
        "failed",
        "cancelled",
        "expired",
        "superseded",
        "reconciliation_required",
      ],
      required: true,
      default: "criando",
      index: true,
    },
    ativa: { type: Boolean, required: true, default: true },
    idempotencyKey: { type: String, required: true, immutable: true },
    mercadoPagoPaymentId: { type: String, default: "" },
    mercadoPagoPreapprovalId: { type: String, default: "" },
    valorCentavos: { type: Number, required: true, min: 1 },
    moeda: { type: String, enum: ["BRL"], default: "BRL" },
    redirectUrl: { type: String, default: "" },
    pixQrCodeBase64: { type: String, default: "" },
    pixCopiaCola: { type: String, default: "" },
    expiresAt: { type: Date, required: true, index: true },
    completedAt: { type: Date, default: null },
    supersededAt: { type: Date, default: null },
    erro: { type: String, default: "", maxlength: 1000 },
  },
  opts,
);
assinaturaTentativaSchema.index(
  { attemptId: 1 },
  { unique: true, name: "assinatura_tentativa_attempt_unico" },
);
assinaturaTentativaSchema.index(
  { estabelecimentoId: 1, metodo: 1 },
  {
    unique: true,
    partialFilterExpression: { ativa: true },
    name: "assinatura_tentativa_ativa_unica",
  },
);
const AssinaturaTentativa = mongoose.model(
  "AssinaturaTentativa",
  assinaturaTentativaSchema,
);

const oauthStateSchema = new mongoose.Schema({
  stateHash: { type: String, required: true },
  sessionId: { type: String, required: true, index: true },
  ...base,
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null },
}, opts);
oauthStateSchema.index(
  { stateHash: 1 },
  { unique: true, name: "oauth_state_hash_unico" },
);
oauthStateSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "oauth_state_expiracao_ttl" },
);
const OAuthState = mongoose.model("OAuthState", oauthStateSchema);


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

const printJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true, immutable: true },
  ...base,
  pedidoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Pedido",
    required: true,
    index: true,
  },
  tipo: {
    type: String,
    enum: ["automatica", "manual"],
    required: true,
    index: true,
  },
  impressoraChave: { type: String, required: true, trim: true },
  impressora: { type: mongoose.Schema.Types.Mixed, required: true },
  estabelecimento: { type: mongoose.Schema.Types.Mixed, required: true },
  pedido: { type: mongoose.Schema.Types.Mixed, required: true },
  status: {
    type: String,
    enum: [
      "pendente",
      "aguardando_retry",
      "recebido",
      "processando",
      "enviado",
      "concluido",
      "falhou",
      "cancelado",
      "resultado_desconhecido",
    ],
    default: "pendente",
    required: true,
    index: true,
  },
  tentativas: { type: Number, default: 0, min: 0, max: 5 },
  erro: { type: String, default: "", maxlength: 1000 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastAttemptAt: { type: Date, default: null },
  lockedBy: { type: String, default: "", index: true },
  leaseToken: { type: String, default: "" },
  leaseExpiresAt: { type: Date, default: null, index: true },
  recebidoEm: { type: Date, default: null },
  processandoEm: { type: Date, default: null },
  enviadoEm: { type: Date, default: null },
  concluidoEm: { type: Date, default: null },
}, opts);

printJobSchema.index(
  {
    estabelecimentoId: 1,
    pedidoId: 1,
    impressoraChave: 1,
    tipo: 1,
  },
  {
    unique: true,
    partialFilterExpression: { tipo: "automatica" },
    name: "printjob_automatico_unico",
  },
);

printJobSchema.index({
  estabelecimentoId: 1,
  status: 1,
  nextAttemptAt: 1,
  createdAt: 1,
});

const PrintJob = mongoose.model("PrintJob", printJobSchema);

const paymentEventSchema = new mongoose.Schema({
  eventKey: { type: String, required: true },
  requestId: { type: String, required: true },
  resourceId: { type: String, required: true },
  resourceType: { type: String, required: true },
  action: { type: String, default: "" },
  estabelecimentoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Registro",
    default: null,
  },
  assinaturaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Assinatura",
    default: null,
  },
  pedidoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Pedido",
    default: null,
  },
  status: {
    type: String,
    enum: ["recebido", "processando", "processado", "falhou"],
    default: "recebido",
    index: true,
  },
  payloadHash: { type: String, required: true },
  recebidoEm: { type: Date, default: Date.now },
  processandoEm: { type: Date, default: null },
  processadoEm: { type: Date, default: null },
  erro: { type: String, default: "" },
  tentativas: { type: Number, default: 0, min: 0 },
}, opts);

paymentEventSchema.index({ eventKey: 1 }, { unique: true, name: "payment_event_key_unico" });
const PaymentEvent = mongoose.model("PaymentEvent", paymentEventSchema);

// Estes índices de segurança são aplicados somente pelo script manual
// scripts/create-mercado-pago-indexes.js, após a verificação de duplicidades.
for (const model of [
  Configuracao,
  Pedido,
  Assinatura,
  AssinaturaTentativa,
  OAuthState,
  PaymentEvent,
]) {
  model.schema.set("autoIndex", false);
}

Configuracao.schema.index(
  { estabelecimentoId: 1 },
  { unique: true, name: "configuracao_estabelecimento_unico" },
);
Pedido.schema.index(
  { mercadoPagoPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { mercadoPagoPaymentId: { $type: "string", $gt: "" } },
    name: "pedido_payment_id_unico",
  },
);
Assinatura.schema.index(
  { estabelecimentoId: 1 },
  { unique: true, name: "assinatura_estabelecimento_unico" },
);
Assinatura.schema.index(
  { mercadoPagoPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { mercadoPagoPaymentId: { $type: "string", $gt: "" } },
    name: "assinatura_payment_id_unico",
  },
);
Assinatura.schema.index(
  { mercadoPagoPreapprovalId: 1 },
  {
    unique: true,
    partialFilterExpression: { mercadoPagoPreapprovalId: { $type: "string", $gt: "" } },
    name: "assinatura_preapproval_id_unico",
  },
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
  AssinaturaTentativa,
  OAuthState,
  PrintAgent,
  PrintJob,
  PaymentEvent,
};
