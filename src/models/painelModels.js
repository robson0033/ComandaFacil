const mongoose = require("mongoose");
const { SUBSCRIPTION_ATTEMPT_STATUS } = require("../constants/subscriptionAttempt");

const base = {
  estabelecimentoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Registro",
    required: true,
    index: true,
  },
};
const opts = { timestamps: true };
const imagemArmazenadaSchema = new mongoose.Schema(
  {
    storageKey: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    mimeType: {
      type: String,
      enum: ["image/webp"],
      required: true,
    },
    provider: {
      type: String,
      enum: ["local", "cloudinary", "external", "s3"],
      default: "local",
    },
    largura: { type: Number, required: true, min: 1 },
    altura: { type: Number, required: true, min: 1 },
    tamanho: { type: Number, required: true, min: 1 },
    atualizadoEm: { type: Date, required: true },
  },
  { _id: false },
);

const Categoria = mongoose.model(
  "Categoria",
  new mongoose.Schema(
    {
      ...base,
      nome: { type: String, required: true, trim: true },
      tipo: { type: String, enum: ["estoque", "catalogo"], required: true },
      tipoProduto: {
        type: String,
        enum: ["normal", "pizza"],
        default: "normal",
      },
      configuracaoPizza: {
        permiteMeioAMeio: {
          type: Boolean,
          default: false,
        },
        regraPrecoMeioAMeio: {
          type: String,
          enum: [
            "maior_sabor_escolhido",
            "maior_preco_categoria",
          ],
          default: "maior_sabor_escolhido",
        },
        tamanhos: {
          type: [
            {
              nome: {
                type: String,
                required: true,
                trim: true,
                maxlength: 50,
              },
              ordem: {
                type: Number,
                default: 0,
                min: 0,
              },
              ativo: {
                type: Boolean,
                default: true,
              },
            },
          ],
          default: [],
        },
      },
      configuracaoVariacoes: {
        habilitado: {
          type: Boolean,
          default: false,
        },
        opcoes: {
          type: [
            {
              nome: {
                type: String,
                required: true,
                trim: true,
                maxlength: 50,
              },
              ordem: {
                type: Number,
                default: 0,
                min: 0,
              },
              ativo: {
                type: Boolean,
                default: true,
              },
            },
          ],
          default: [],
        },
      },
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
      quantidadeInicial: { type: Number, min: 0 },
      totalEntradas: { type: Number, min: 0 },
      totalConsumido: { type: Number, min: 0 },
      minimo: { type: Number, default: 0, min: 0 },
      unidade: { type: String, default: "unidade", trim: true },
      custoUnitario: { type: Number, default: 0, min: 0 },
      ativo: { type: Boolean, default: true },
      desativadoEm: { type: Date, default: null },
      desativadoPor: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
      },
      motivoDesativacao: { type: String, default: "", maxlength: 300 },
      auditoria: [{
        tipo: {
          type: String,
          enum: ["ingrediente_desativado"],
          required: true,
        },
        ingredienteId: {
          type: mongoose.Schema.Types.ObjectId,
          required: true,
        },
        usuarioId: {
          type: mongoose.Schema.Types.ObjectId,
          default: null,
        },
        registradoEm: { type: Date, required: true },
        operationKey: { type: String, required: true },
      }],
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
      imagemArquivo: { type: imagemArmazenadaSchema, default: null },

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

      precosPizza: {
        type: [
          {
            tamanhoId: {
              type: mongoose.Schema.Types.ObjectId,
              required: true,
            },
            tamanhoNome: {
              type: String,
              required: true,
              trim: true,
              maxlength: 50,
            },
            preco: {
              type: Number,
              required: true,
              min: 0,
            },
          },
        ],
        default: [],
      },
      precosVariacoes: {
        type: [
          {
            variacaoId: {
              type: mongoose.Schema.Types.ObjectId,
              required: true,
            },
            variacaoNome: {
              type: String,
              required: true,
              trim: true,
              maxlength: 50,
            },
            preco: {
              type: Number,
              required: true,
              min: 0,
            },
          },
        ],
        default: [],
      },

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

const funcionarioSchema = new mongoose.Schema(
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
      fotoArquivo: { type: imagemArmazenadaSchema, default: null },

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
            'arquivar_pedidos',
          ],
        },
      ],
    },
    opts,
  );
funcionarioSchema.index(
  { email: 1 },
  { unique: true, name: "funcionario_email_global_unico" },
);
const Funcionario = mongoose.model("Funcionario", funcionarioSchema);

const Configuracao = mongoose.model(
  "Configuracao",
  new mongoose.Schema(
    {
      ...base,
      nomeEstabelecimento: { type: String, required: true, trim: true },
      descricao: { type: String, default: "", trim: true },
      telefone: { type: String, default: "", trim: true },
      endereco: { type: String, default: "", trim: true },
      timezone: {
        type: String,
        enum: ["America/Sao_Paulo"],
        default: "America/Sao_Paulo",
      },
      fotoPerfil: { type: String, default: "" },
      fotoPerfilArquivo: { type: imagemArmazenadaSchema, default: null },
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
      ativo: { type: Boolean, default: true },
      bloqueado: { type: Boolean, default: false },
      vendasBloqueadas: { type: Boolean, default: false },
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

            origemPedidos: {
              type: String,
              enum: ["todas", "delivery", "mesa", "retirada", "delivery_retirada"],
              default: "todas",
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
        termsAcceptedAt: { type: Date, default: null },
        termsVersion: { type: String, default: "" },
        platformFeePercent: { type: Number, default: null },
      },

    },
    opts,
  ),
);

const cidadeEntregaSchema = new mongoose.Schema(
  {
    ...base,
    nome: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    nomeNormalizado: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 120,
    },
    uf: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      enum: [
        "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO",
        "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI",
        "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
      ],
    },
    taxaCentavos: {
      type: Number,
      required: true,
      min: 0,
      max: 50_000,
      validate: {
        validator: Number.isSafeInteger,
        message: "A taxa de entrega deve ser informada em centavos inteiros.",
      },
    },
    ativo: { type: Boolean, default: true, index: true },
    desativadoEm: { type: Date, default: null },
  },
  opts,
);

cidadeEntregaSchema.index(
  { estabelecimentoId: 1, nomeNormalizado: 1, uf: 1 },
  { unique: true, name: "cidade_entrega_tenant_nome_uf_unico" },
);
cidadeEntregaSchema.index(
  { estabelecimentoId: 1, ativo: 1, nome: 1 },
  { name: "cidade_entrega_tenant_ativo_nome" },
);

const CidadeEntrega = mongoose.model("CidadeEntrega", cidadeEntregaSchema);

const pagamentoPedidoSchema = new mongoose.Schema(
  {
    formaPagamento: {
      type: String,
      enum: [
        "dinheiro",
        "pix",
        "pix_online",
        "cartao",
        "nao_informado",
      ],
      required: true,
    },
    valorCentavos: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "O valor do pagamento deve ser informado em centavos inteiros.",
      },
    },
  },
  { _id: false },
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
        maxlength: 120,
      },

      telefoneCliente: { type: String, default: "", trim: true, maxlength: 30 },
      telefoneNormalizado: { type: String, default: "", trim: true, index: true },
      codigoPublico: { type: String, trim: true, uppercase: true },
      codigoPublicoFinal: { type: String, trim: true, uppercase: true },
      emailCliente: {
        type: String,
        default: "",
        trim: true,
        lowercase: true,
        maxlength: 254,
      },
      enderecoEntrega: { type: String, default: "", trim: true, maxlength: 360 },
      ruaEntrega: { type: String, default: "", trim: true, maxlength: 180 },
      numeroEntrega: { type: String, default: "", trim: true, maxlength: 40 },
      bairroEntrega: { type: String, default: "", trim: true, maxlength: 120 },
      referenciaEntrega: { type: String, default: "", trim: true, maxlength: 240 },
      cidadeEntregaId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CidadeEntrega",
        default: null,
      },
      cidadeEntregaNome: { type: String, default: "", trim: true, maxlength: 120 },
      cidadeEntregaUf: { type: String, default: "", trim: true, uppercase: true, maxlength: 2 },
      acompanhamentoTokenHash: {
        type: String,
        select: false,
      },
      acompanhamentoTokenCriadoEm: { type: Date, default: null },
      acompanhamentoTokenExpiraEm: { type: Date, default: null },
      excluido: { type: Boolean, default: false },
      excluidoEm: { type: Date, default: null },
      excluidoPor: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
      },
      excluidoPorTipo: {
        type: String,
        enum: ["proprietario", "funcionario", ""],
        default: "",
      },
      motivoExclusao: { type: String, default: "", trim: true, maxlength: 500 },
      exclusaoOperationKey: { type: String, default: "", trim: true },

      canal: {
        type: String,
        enum: ["mesa", "balcao", "delivery", "retirada"],
        default: "mesa",
      },

      idempotencyKey: {
        type: String,
        default: "",
        trim: true,
        lowercase: true,
        maxlength: 36,
      },
      idempotencyPayloadHash: {
        type: String,
        default: "",
        trim: true,
        maxlength: 64,
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
            maxlength: 160,
          },

          quantidade: {
            type: Number,
            required: true,
            min: 1,
            max: 99,
            validate: {
              validator: Number.isInteger,
              message: "A quantidade deve ser inteira.",
            },
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
                maxlength: 120,
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
            maxlength: 300,
          },
          pizzaMeioAMeio: {
            type: Boolean,
            default: false,
          },
          saboresPizza: [
            {
              produtoId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Produto",
                required: true,
              },
              nome: {
                type: String,
                required: true,
                trim: true,
                maxlength: 160,
              },
              preco: {
                type: Number,
                required: true,
                min: 0,
              },
              fracao: {
                type: Number,
                required: true,
                min: 0.01,
                max: 1,
              },
            },
          ],
          regraPrecoPizza: {
            type: String,
            enum: [
              "",
              "maior_sabor_escolhido",
              "maior_preco_categoria",
            ],
            default: "",
          },
          precoBasePizza: {
            type: Number,
            default: null,
            min: 0,
          },
          tamanhoPizzaId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
          },
          tamanhoPizzaNome: {
            type: String,
            default: "",
            trim: true,
            maxlength: 50,
          },
          variacaoId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
          },
          variacaoNome: {
            type: String,
            default: "",
            trim: true,
            maxlength: 50,
          },
          precoBaseVariacao: {
            type: Number,
            default: null,
            min: 0,
          },
          custoUnitarioSnapshot: { type: Number, default: 0, min: 0 },
          fichaTecnicaSnapshotCriado: {
            type: Boolean,
            default: false,
          },
          fichaTecnicaSnapshot: [
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
        },
      ],

      observacao: {
        type: String,
        default: "",
        trim: true,
        maxlength: 500,
      },

      subtotalProdutos: {
        type: Number,
        default: 0,
        min: 0,
      },

      taxaEntregaCentavos: {
        type: Number,
        default: 0,
        min: 0,
        max: 50_000,
        validate: {
          validator: Number.isSafeInteger,
          message: "A taxa de entrega do pedido deve ser informada em centavos inteiros.",
        },
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
        enum: [
          "dinheiro",
          "pix",
          "pix_online",
          "cartao",
          "combinado",
          "nao_informado",
        ],
        default: "nao_informado",
      },

      pagamentos: {
        type: [pagamentoPedidoSchema],
        default: [],
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
      estoqueRestaurado: { type: Boolean, default: false },
      estoqueRestauradoEm: { type: Date, default: null },
      estoqueLockId: { type: String, default: "" },
      estoqueLockExpiraEm: { type: Date, default: null },
      estoqueSnapshotCriado: { type: Boolean, default: false },
      estoqueConsumos: [{
        estoqueId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Estoque",
          required: true,
          immutable: true,
        },
        nomeIngrediente: { type: String, required: true, immutable: true },
        produtoId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Produto",
          required: true,
          immutable: true,
        },
        itemPedidoIndice: { type: Number, required: true, immutable: true },
        quantidadeProduto: { type: Number, required: true, immutable: true },
        quantidadeConsumida: { type: Number, required: true, immutable: true },
        unidadeFicha: { type: String, required: true, immutable: true },
        quantidadeNaUnidadeEstoque: {
          type: Number,
          required: true,
          immutable: true,
        },
        unidadeEstoque: { type: String, required: true, immutable: true },
        operationKey: { type: String, required: true, immutable: true },
        estado: {
          type: String,
          enum: ["pendente", "baixado", "restaurado", "falhou"],
          default: "pendente",
        },
        erro: { type: String, default: "" },
      }],

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
      mercadoPagoLastCheckedAt: { type: Date, default: null },
      mercadoPagoCheckLockedUntil: { type: Date, default: null },
      pixCopiaCola: { type: String, default: "" },
      pixQrCodeBase64: { type: String, default: "" },
      pixExpiraEm: { type: Date, default: null },
      platformFeePercent: { type: Number, default: null },
      platformFeeCents: { type: Number, default: 0, min: 0 },
      platformFeeStatus: {
        type: String,
        enum: ["requested", "applied", "not_applied", "reversed", "partially_reversed", "reconciliation_required"],
        default: "not_applied",
      },
      platformFeeTermsVersion: { type: String, default: "" },
      platformFeeCalculatedAt: { type: Date, default: null },
      grossAmountCents: { type: Number, default: 0, min: 0 },
      merchantAmountBeforeMpFeesCents: { type: Number, default: 0, min: 0 },
      platformFeeReversedCents: { type: Number, default: 0, min: 0 },
      platformFeeNetCents: { type: Number, default: 0, min: 0 },
      estoqueProcessamento: {
        type: String,
        enum: [
          "nao_iniciado",
          "preparando",
          "baixando",
          "concluido",
          "restaurando",
          "restaurado",
          "falhou",
          "reconciliacao_necessaria",
          "processando",
          "pendente",
        ],
        default: "nao_iniciado",
      },
      estoqueProcessamentoEm: { type: Date, default: null },
      estoqueErro: { type: String, default: "" },
      pagamentoInconsistente: { type: Boolean, default: false },
      pagamentoInconsistencia: { type: String, default: "" },
      historicoFinanceiro: [{
        paymentId: { type: String, default: "" },
        status: { type: String, default: "" },
        tipo: { type: String, default: "" },
        statusAnterior: { type: String, default: "" },
        statusNovo: { type: String, default: "" },
        formaPagamento: { type: String, default: "" },
        pagamentos: {
          type: [pagamentoPedidoSchema],
          default: [],
        },
        valor: { type: Number, default: 0 },
        usuarioId: {
          type: mongoose.Schema.Types.ObjectId,
          default: null,
        },
        motivo: { type: String, default: "" },
        operationKey: { type: String, default: "" },
        registradoEm: { type: Date, default: Date.now },
      }],

    },
    opts,
  ),
);

Pedido.schema.index(
  { estabelecimentoId: 1, canal: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
    name: "pedido_criacao_idempotente_unica",
  },
);
Pedido.schema.index(
  { estabelecimentoId: 1, codigoPublico: 1 },
  {
    unique: true,
    partialFilterExpression: { codigoPublico: { $type: "string", $gt: "" } },
    name: "pedido_codigo_publico_tenant_unico",
  },
);
Pedido.schema.index(
  {
    estabelecimentoId: 1,
    telefoneNormalizado: 1,
    codigoPublicoFinal: 1,
    createdAt: -1,
  },
  { name: "pedido_consulta_publica_segura" },
);
Pedido.schema.index(
  { acompanhamentoTokenHash: 1 },
  {
    unique: true,
    partialFilterExpression: {
      acompanhamentoTokenHash: { $type: "string" },
    },
    name: "pedido_acompanhamento_token_hash_unico",
  },
);
Pedido.schema.index(
  { estabelecimentoId: 1, excluido: 1, createdAt: -1 },
  { name: "pedido_estabelecimento_excluido_data" },
);
Pedido.schema.index(
  { estabelecimentoId: 1, telefoneNormalizado: 1, createdAt: -1 },
  { name: "pedido_tenant_telefone_data" },
);
Pedido.schema.index(
  { estabelecimentoId: 1, emailCliente: 1, createdAt: -1 },
  { name: "pedido_tenant_email_data" },
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

      ipHash: {
        type: String,
        default: "",
        trim: true,
        select: false,
      },

      dispositivoHash: {
        type: String,
        default: "",
        trim: true,
        select: false,
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
          "suspensa",
          "bloqueada",
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
        ...Object.values(SUBSCRIPTION_ATTEMPT_STATUS),
      ],
      required: true,
      default: SUBSCRIPTION_ATTEMPT_STATUS.PROCESSING,
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
    expiredAt: { type: Date, default: null },
    cancelRequestedAt: { type: Date, default: null },
    cancelRequestId: { type: String, default: "", select: false },
    cancelledAt: { type: Date, default: null },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Registro",
      default: null,
    },
    remoteCancellationStatus: { type: String, default: "" },
    reconciliationReason: { type: String, default: "", maxlength: 500 },
    reconciliationRequestedAt: { type: Date, default: null },
    reconciliationAttempts: { type: Number, default: 0, min: 0 },
    lastRemoteStatus: { type: String, default: "", maxlength: 100 },
    lastRemoteCheckedAt: { type: Date, default: null },
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
  { estabelecimentoId: 1 },
  {
    unique: true,
    partialFilterExpression: { ativa: true },
    name: "assinatura_tentativa_ativa_global_unica",
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


const printAgentSchema = new mongoose.Schema({
    ...base,
    tokenHash: { type: String, default: "" },
    codigoVinculacao: { type: String, default: "" },
    codigoExpiraEm: { type: Date, default: null },
    nomeComputador: { type: String, default: "" },
    agentVersion: { type: String, default: "", maxlength: 40 },
    protocolVersion: { type: Number, default: 0 },
    protocolCompativel: { type: Boolean, default: false },
    capacidades: { type: [String], default: [] },
    impressoras: { type: Array, default: [] },
    ultimaConexao: { type: Date, default: null },
    ativo: { type: Boolean, default: true },
  }, opts);
printAgentSchema.index(
  { estabelecimentoId: 1 },
  { unique: true, name: "print_agent_estabelecimento_unico" },
);
printAgentSchema.index(
  { tokenHash: 1 },
  {
    unique: true,
    partialFilterExpression: { tokenHash: { $type: "string", $gt: "" } },
    name: "print_agent_token_hash_unico",
  },
);
printAgentSchema.index(
  { codigoVinculacao: 1 },
  {
    unique: true,
    partialFilterExpression: {
      codigoVinculacao: { $type: "string", $gt: "" },
    },
    name: "print_agent_codigo_ativo_unico",
  },
);
const PrintAgent = mongoose.model("PrintAgent", printAgentSchema);

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
  motivo: {
    type: String,
    enum: ["order_created", "payment_approved", "manual"],
    default: "order_created",
  },
  paymentIdSuffix: { type: String, default: "", maxlength: 16 },
  impressoraChave: { type: String, required: true, trim: true },
  impressora: { type: mongoose.Schema.Types.Mixed, required: true },
  estabelecimento: { type: mongoose.Schema.Types.Mixed, required: true },
  pedido: { type: mongoose.Schema.Types.Mixed, required: true },
  status: {
    type: String,
    enum: [
      "pendente",
      "entregando",
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
  ultimoLeaseId: { type: String, default: "" },
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

const auditoriaEventoSchema = new mongoose.Schema({
  ...base,
  entidade: { type: String, required: true, trim: true, maxlength: 80 },
  entidadeId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  acao: { type: String, required: true, trim: true, maxlength: 100 },
  usuarioId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  usuarioTipo: {
    type: String,
    enum: ["proprietario", "funcionario", "sistema"],
    required: true,
  },
  dadosResumidos: { type: mongoose.Schema.Types.Mixed, default: {} },
  operationKey: { type: String, trim: true },
  registradoEm: { type: Date, default: Date.now, index: true },
}, opts);
auditoriaEventoSchema.index(
  { operationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { operationKey: { $type: "string" } },
    name: "auditoria_operation_key_unico",
  },
);
auditoriaEventoSchema.index(
  { estabelecimentoId: 1, registradoEm: -1 },
  { name: "auditoria_estabelecimento_data" },
);
const AuditoriaEvento = mongoose.model(
  "AuditoriaEvento",
  auditoriaEventoSchema,
);

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

const orderPaymentAttemptSchema = new mongoose.Schema({
  publicReference: { type: String, required: true, immutable: true },
  externalReference: { type: String, required: true, immutable: true },
  estabelecimentoId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  pedidoId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "Pedido", index: true },
  paymentId: { type: String, default: "", trim: true },
  expectedCollectorId: { type: String, required: true, immutable: true },
  expectedAmount: { type: Number, required: true, min: 0 },
  currency: { type: String, enum: ["BRL"], default: "BRL" },
  status: { type: String, default: "creating", index: true },
  paymentMethod: { type: String, enum: ["pix"], default: "pix" },
  idempotencyKey: { type: String, required: true, immutable: true },
  expiresAt: { type: Date, required: true },
  lastCheckedAt: { type: Date, default: null },
  processedAt: { type: Date, default: null },
  reconciliationStatus: { type: String, default: "pending" },
  webhookEvents: { type: [String], default: [] },
  legacyReference: { type: Boolean, default: false },
  platformFeePercent: { type: Number, default: null },
  platformFeeCents: { type: Number, default: 0, min: 0 },
  platformFeeStatus: {
    type: String,
    enum: ["requested", "applied", "not_applied", "reversed", "partially_reversed", "reconciliation_required"],
    default: "not_applied",
  },
  platformFeeTermsVersion: { type: String, default: "" },
  platformFeeCalculatedAt: { type: Date, default: null },
  grossAmountCents: { type: Number, default: 0, min: 0 },
  merchantAmountBeforeMpFeesCents: { type: Number, default: 0, min: 0 },
  platformFeeReversedCents: { type: Number, default: 0, min: 0 },
  platformFeeNetCents: { type: Number, default: 0, min: 0 },
}, opts);
orderPaymentAttemptSchema.index({ publicReference: 1 }, { unique: true, name: "order_attempt_public_reference_unique" });
orderPaymentAttemptSchema.index({ externalReference: 1 }, { unique: true, name: "order_attempt_external_reference_unique" });
orderPaymentAttemptSchema.index({ paymentId: 1 }, {
  unique: true,
  partialFilterExpression: { paymentId: { $type: "string", $gt: "" } },
  name: "order_attempt_payment_id_unique",
});
orderPaymentAttemptSchema.index({ idempotencyKey: 1 }, { unique: true, name: "order_attempt_idempotency_unique" });
orderPaymentAttemptSchema.index({ estabelecimentoId: 1, pedidoId: 1, createdAt: -1 }, { name: "order_attempt_tenant_order" });
orderPaymentAttemptSchema.index({ estabelecimentoId: 1, status: 1 }, { name: "order_attempt_tenant_status" });
const OrderPaymentAttempt = mongoose.model("OrderPaymentAttempt", orderPaymentAttemptSchema);

const platformFeeTermsAcceptanceSchema = new mongoose.Schema({
  estabelecimentoId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  usuarioId: { type: mongoose.Schema.Types.ObjectId, required: true },
  termsVersion: { type: String, required: true },
  platformFeePercent: { type: Number, required: true },
  acceptedAt: { type: Date, required: true },
  ipHash: { type: String, required: true },
  userAgentSanitized: { type: String, default: "", maxlength: 300 },
  termsHash: { type: String, required: true },
  source: { type: String, enum: ["mercado_pago_oauth"], required: true },
  status: { type: String, enum: ["active", "revoked"], default: "active" },
  revokedAt: { type: Date, default: null },
}, opts);
platformFeeTermsAcceptanceSchema.index({
  estabelecimentoId: 1,
  termsVersion: 1,
  source: 1,
  status: 1,
}, { name: "platform_fee_terms_tenant_version_status" });
platformFeeTermsAcceptanceSchema.index({
  estabelecimentoId: 1,
  termsVersion: 1,
  termsHash: 1,
  status: 1,
}, {
  unique: true,
  partialFilterExpression: { status: "active" },
  name: "platform_fee_terms_active_unique",
});
const PlatformFeeTermsAcceptance = mongoose.model(
  "PlatformFeeTermsAcceptance",
  platformFeeTermsAcceptanceSchema,
);

const orderLookupVerificationSchema = new mongoose.Schema({
  estabelecimentoId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  identifierHash: { type: String, required: true, index: true },
  sessionHash: { type: String, required: true },
  codeHash: { type: String, required: true, select: false },
  salt: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  attempts: { type: Number, default: 0 },
  usedAt: { type: Date, default: null },
}, opts);
orderLookupVerificationSchema.index(
  { estabelecimentoId: 1, identifierHash: 1, sessionHash: 1, createdAt: -1 },
  { name: "order_lookup_tenant_identifier_session" },
);
const OrderLookupVerification = mongoose.model("OrderLookupVerification", orderLookupVerificationSchema);

// Estes índices de segurança são aplicados somente pelo script manual
// scripts/create-mercado-pago-indexes.js, após a verificação de duplicidades.
for (const model of [
  Configuracao,
  CidadeEntrega,
  Pedido,
  Assinatura,
  AssinaturaTentativa,
  OAuthState,
  PaymentEvent,
  AuditoriaEvento,
  OrderLookupVerification,
  OrderPaymentAttempt,
  PlatformFeeTermsAcceptance,
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
  CidadeEntrega,
  Pedido,
  Avaliacao,
  Assinatura,
  AssinaturaTentativa,
  OAuthState,
  PrintAgent,
  PrintJob,
  PaymentEvent,
  AuditoriaEvento,
  OrderLookupVerification,
  OrderPaymentAttempt,
  PlatformFeeTermsAcceptance,
};
