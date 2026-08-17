const crypto = require("crypto");
const express = require('express');
const {
  createImageUpload,
  imageUploadErrorHandler,
} = require('./src/uploads/uploadMiddleware');

const route = express.Router();

const homeController = require(
  './src/controllers/homeController'
);

const registroController = require(
  './src/controllers/registroController'
);

const loginController = require(
  './src/controllers/loginControllerReal'
);

const recuperacaoSenhaController = require(
  './src/controllers/recuperacaoSenhaController'
);

const admin = require(
  './src/controllers/adminRealController'
);

const pagamento = require(
  './src/controllers/pagamentoController'
);

const whatsapp = require(
  './src/controllers/whatsappController'
);


const {
  loginRequired,
  permissao,
  permissaoQualquer,
  permissaoCategoria,
  permissaoCategoriaLeitura,
  somenteProprietario,
} = require('./src/middleware/auth');

const {
  carregarAssinatura,
  assinaturaRequired,
} = require('./src/middleware/assinatura');
const {
  anonymousSameOriginProtection,
  csrfSameOriginProtection,
} = require('./src/middleware/csrf');
const {
  createRateLimiter,
} = require('./src/middleware/rateLimit');

const normalizarEmailRateLimit = value => String(value || "").trim().toLowerCase().slice(0, 254);
const hashRateLimit = value => crypto.createHash("sha256").update(String(value || "")).digest("hex");

const limiteAssinatura = createRateLimiter({ name: "subscription", windowMs: 60_000, max: 6 });
const limiteOauth = createRateLimiter({ name: "oauth", windowMs: 60_000, max: 10 });
const limitePixPedido = createRateLimiter({ name: "order-pix", windowMs: 60_000, max: 12 });
const limiteStatusPagamento = createRateLimiter({ name: "payment-status", windowMs: 60_000, max: 60 });
const limiteWebhook = createRateLimiter({ name: "webhook", windowMs: 60_000, max: 300 });
const limiteLoginIp = createRateLimiter({
  name: "auth-login-ip",
  windowMs: 15 * 60_000,
  max: 40,
  key: req => req.ip,
});
const limiteLoginIdentidade = createRateLimiter({
  name: "auth-login-identity",
  windowMs: 15 * 60_000,
  max: 10,
  key: req => `${req.ip}|${hashRateLimit(normalizarEmailRateLimit(req.body?.email))}`,
});
const limiteCadastro = createRateLimiter({
  name: "auth-register",
  windowMs: 60 * 60_000,
  max: 5,
  key: req => req.ip,
});
const limiteRecuperacaoSolicitar = createRateLimiter({
  name: "auth-recovery-request",
  windowMs: 15 * 60_000,
  max: 5,
  key: req => `${req.ip}|${hashRateLimit(normalizarEmailRateLimit(req.body?.email))}`,
});
const limiteRecuperacaoCodigo = createRateLimiter({
  name: "auth-recovery-code",
  windowMs: 15 * 60_000,
  max: 10,
  key: req => `${req.ip}|${req.sessionID || "no-session"}|${hashRateLimit(req.session?.recuperacaoEmail)}`,
});
const limiteNovaSenha = createRateLimiter({
  name: "auth-recovery-password",
  windowMs: 15 * 60_000,
  max: 5,
  key: req => `${req.ip}|${req.sessionID || "no-session"}`,
});
const limitePedidoCatalogo = createRateLimiter({
  name: "public-order-catalog-burst",
  windowMs: 60_000,
  max: 8,
  key: req => `${req.ip}|${String(req.params.slug || "").toLowerCase()}`,
});
const limitePedidoCatalogoHora = createRateLimiter({
  name: "public-order-catalog-hour",
  windowMs: 60 * 60_000,
  max: 30,
  key: req => `${req.ip}|${String(req.params.slug || "").toLowerCase()}`,
});
const limitePedidoMesa = createRateLimiter({
  name: "public-order-table-burst",
  windowMs: 60_000,
  max: 12,
  key: req => `${req.ip}|${String(req.params.token || "")}`,
});
const limitePedidoMesaHora = createRateLimiter({
  name: "public-order-table-hour",
  windowMs: 60 * 60_000,
  max: 60,
  key: req => `${req.ip}|${String(req.params.token || "")}`,
});
const limiteAcompanhamentoPedido = createRateLimiter({
  name: "public-order-tracking",
  windowMs: 60_000,
  max: 30,
  key: req => `${req.ip}|${String(req.params.slug || "").toLowerCase()}`,
  onLimit: (req, res) => res.status(429).json({
    code: "MUITAS_TENTATIVAS",
    message: "Muitas tentativas. Aguarde e tente novamente.",
  }),
});
const limiteConsultaPedidoPublico = createRateLimiter({
  name: "public-order-lookup",
  windowMs: 5 * 60_000,
  max: 8,
  key: req => {
    const phone = String(req.body?.telefone || "").replace(/\D/g, "").slice(-11);
    const code = String(req.body?.codigoCompleto || req.body?.codigoFinal || "")
      .trim().toUpperCase();
    const digest = crypto.createHash("sha256").update(`${phone}|${code}`).digest("hex");
    return `${req.ip}|${String(req.params.slug || "").toLowerCase()}|${digest}`;
  },
  onLimit: (req, res) => res.status(429).json({
    ok: false,
    code: "MUITAS_TENTATIVAS",
    message: "Aguarde antes de tentar novamente.",
  }),
});
const respostaPedidoSemCache = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  next();
};

const produtoUpload = createImageUpload('produto');
const perfilUpload = createImageUpload('perfil');
const funcionarioUpload = createImageUpload('funcionario');

/*
|--------------------------------------------------------------------------
| LOGIN E CADASTRO
|--------------------------------------------------------------------------
*/

route.get(
  '/',
  homeController.index
);

route.get(
  '/login/index',
  homeController.index
);

route.get(
  '/login',
  homeController.index
);

route.get(
  '/termos',
  homeController.termos
);

route.get(
  '/privacidade',
  homeController.privacidade
);

route.post(
  '/login/admin',
  limiteLoginIp,
  limiteLoginIdentidade,
  anonymousSameOriginProtection,
  loginController.login
);

route.get(
  '/login/recuperar-senha',
  recuperacaoSenhaController.paginaSolicitarCodigo
);

route.post(
  '/login/recuperar-senha',
  limiteRecuperacaoSolicitar,
  anonymousSameOriginProtection,
  recuperacaoSenhaController.solicitarCodigo
);

route.get(
  '/login/verificar-codigo',
  recuperacaoSenhaController.paginaVerificarCodigo
);

route.post(
  '/login/verificar-codigo',
  limiteRecuperacaoCodigo,
  anonymousSameOriginProtection,
  recuperacaoSenhaController.verificarCodigo
);

route.get(
  '/login/nova-senha',
  recuperacaoSenhaController.paginaNovaSenha
);

route.post(
  '/login/nova-senha',
  limiteNovaSenha,
  anonymousSameOriginProtection,
  recuperacaoSenhaController.salvarNovaSenha
);

route.get(
  '/cadastro/index',
  registroController.cadastro
);

route.post(
  '/cadastro/login',
  limiteCadastro,
  anonymousSameOriginProtection,
  registroController.registro
);

route.post(
  '/login/logout',
  csrfSameOriginProtection,
  loginController.logout
);

/*
|--------------------------------------------------------------------------
| ASSINATURA E MERCADO PAGO
|--------------------------------------------------------------------------
*/

route.use('/assinatura', csrfSameOriginProtection);

route.get(
  '/assinatura',
  loginRequired,
  somenteProprietario,
  carregarAssinatura,
  pagamento.pagina
);

route.post(
  '/assinatura/cartao',
  loginRequired,
  somenteProprietario,
  carregarAssinatura,
  limiteAssinatura,
  pagamento.assinarCartao
);

route.post(
  '/assinatura/pix',
  loginRequired,
  somenteProprietario,
  carregarAssinatura,
  limiteAssinatura,
  pagamento.gerarPix
);

route.post(
  '/assinatura/pix/status',
  loginRequired,
  somenteProprietario,
  carregarAssinatura,
  pagamento.statusPixAssinatura
);

route.post(
  '/assinatura/tentativa-ativa/cancelar',
  loginRequired,
  somenteProprietario,
  carregarAssinatura,
  limiteAssinatura,
  pagamento.cancelarTentativaAtiva
);

route.get(
  '/assinatura/retorno',
  loginRequired,
  somenteProprietario,
  carregarAssinatura,
  pagamento.retorno
);

// Compatibilidade com links antigos sem permitir mutação por GET.
route.get('/pagamento/assinar', loginRequired, somenteProprietario, (req, res) =>
  res.redirect(303, '/assinatura'));
route.get('/pagamento/sucesso', loginRequired, somenteProprietario, (req, res) =>
  res.redirect(303, '/assinatura/retorno'));

// Validação global ocorre com a sessão já carregada e antes de autenticação,
// assinatura, permissão e controllers administrativos.
route.use('/admin', csrfSameOriginProtection);

route.post('/admin/mercado-pago/termos/aceitar', loginRequired, somenteProprietario, carregarAssinatura, limiteOauth, pagamento.aceitarTermosTaxaPix);
route.post('/admin/mercado-pago/conectar', loginRequired, somenteProprietario, carregarAssinatura, limiteOauth, pagamento.conectarMercadoPago);
route.get('/admin/mercado-pago/callback', loginRequired, somenteProprietario, carregarAssinatura, limiteOauth, pagamento.callbackMercadoPago);
route.post('/admin/mercado-pago/desconectar', loginRequired, somenteProprietario, carregarAssinatura, limiteOauth, pagamento.desconectarMercadoPago);

route.post(
  '/webhook/mercado-pago',
  limiteWebhook,
  pagamento.webhook
);

// WhatsApp Cloud API: endpoint público usado pela Meta para verificar o
// callback (GET) e entregar mensagens/status (POST). Não recebe CSRF nem
// exige sessão; a autenticidade do POST é validada por X-Hub-Signature-256.
route.get(
  '/webhook/whatsapp',
  limiteWebhook,
  whatsapp.verificarWebhook
);

route.post(
  '/webhook/whatsapp',
  limiteWebhook,
  whatsapp.receberWebhook
);

/*
|--------------------------------------------------------------------------
| PAINEL ADMINISTRATIVO
|--------------------------------------------------------------------------
*/

route.get(
  '/admin',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  admin.admin
);

route.get(
  '/admin/pedidos',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('pedidos'),
  (req, res) => res.redirect('/admin#pedidos')
);

const redirectAdminSection = section => (req, res) =>
  res.redirect(`/admin#${section}`);

route.get('/admin/catalogo', loginRequired, carregarAssinatura, assinaturaRequired, permissao('catalogo'), redirectAdminSection('catalogo'));
route.get('/admin/cardapio', loginRequired, carregarAssinatura, assinaturaRequired, permissao('catalogo'), redirectAdminSection('catalogo'));
route.get('/admin/mesas', loginRequired, carregarAssinatura, assinaturaRequired, permissao('mesas'), redirectAdminSection('mesas'));

route.get(
  '/admin/api/mesas/resumo',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissaoQualquer('mesas', 'pedidos'),
  admin.resumoMesas
);
route.get('/admin/funcionarios', loginRequired, carregarAssinatura, assinaturaRequired, permissao('funcionarios'), redirectAdminSection('funcionarios'));
route.get('/admin/estoque', loginRequired, carregarAssinatura, assinaturaRequired, permissao('estoque'), redirectAdminSection('estoque'));
route.get('/admin/relatorios', loginRequired, carregarAssinatura, assinaturaRequired, permissao('relatorios'), redirectAdminSection('relatorios'));
route.get('/admin/configuracoes', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configuracoes'), redirectAdminSection('configuracoes'));
route.get('/admin/agente', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configurar_impressoras'), redirectAdminSection('configuracoes'));

route.get(
  '/admin/api/pedidos/:id/impressao',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('imprimir_pedidos'),
  admin.obterPedidoParaImpressao
);

route.post(
  '/admin/pedidos/:id/status',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('pedidos'),
  admin.atualizarStatusPedido
);

route.post(
  '/admin/pedidos/:id/confirmar-pagamento',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('pedidos'),
  admin.confirmarPagamentoPedido
);

route.post(
  '/admin/pedidos/:id/forma-pagamento',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('pedidos'),
  admin.alterarFormaPagamentoPedido
);

route.post(
  '/admin/pedidos/:id/arquivar',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('arquivar_pedidos'),
  admin.arquivarPedido
);

route.get(
  '/admin/api/pedidos/novos',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('pedidos'),
  admin.buscarNovosPedidos
);
route.get(
  '/admin/api/pedidos/stream',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('pedidos'),
  admin.streamNovosPedidos
);

/*
|--------------------------------------------------------------------------
| CATEGORIAS
|--------------------------------------------------------------------------
*/

route.get(
  '/admin/categorias',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissaoCategoriaLeitura,
  redirectAdminSection('estoque')
);

route.post(
  '/admin/categorias',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissaoCategoria,
  admin.criarCategoria
);

route.post(
  '/admin/categorias/:id/excluir',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissaoCategoria,
  admin.excluirCategoria
);

/*
|--------------------------------------------------------------------------
| ESTOQUE
|--------------------------------------------------------------------------
*/

route.post(
  '/admin/estoque',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('estoque'),
  admin.criarEstoque
);

route.post(
  '/admin/estoque/:id/excluir',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('estoque'),
  admin.excluirEstoque
);

/*
|--------------------------------------------------------------------------
| CATĆLOGO E PRODUTOS
|--------------------------------------------------------------------------
*/

route.post(
  '/admin/produtos',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('catalogo'),
  produtoUpload,
  imageUploadErrorHandler,
  admin.criarProduto
);


route.post(
  '/admin/produtos/:id/editar',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('catalogo'),
  produtoUpload,
  imageUploadErrorHandler,
  admin.editarProduto
);

route.post(
  '/admin/produtos/:id/excluir',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('catalogo'),
  admin.excluirProduto
);

route.delete(
  '/admin/produtos/:id',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('catalogo'),
  admin.excluirProduto
);

/*
|--------------------------------------------------------------------------
| MESAS
|--------------------------------------------------------------------------
*/

route.post(
  '/admin/mesas',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('mesas'),
  admin.criarMesa
);

route.post(
  '/admin/mesas/:id/excluir',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('mesas'),
  admin.excluirMesa
);

route.post(
  '/admin/mesas/:id/status',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('mesas'),
  admin.atualizarStatusMesa
);

route.post(
  '/admin/mesas/:id/solicitar-conta',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissaoQualquer('mesas', 'pedidos'),
  admin.solicitarContaMesa
);

route.post(
  '/admin/mesas/:id/pagar',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissaoQualquer('mesas', 'pedidos'),
  admin.pagarContaMesa
);

/*
|--------------------------------------------------------------------------
| FUNCIONĆRIOS
|--------------------------------------------------------------------------
*/

route.post(
  '/admin/funcionarios',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('funcionarios'),
  funcionarioUpload,
  imageUploadErrorHandler,
  admin.criarFuncionario
);

route.post(
  '/admin/funcionarios/:id/editar',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('funcionarios'),
  funcionarioUpload,
  imageUploadErrorHandler,
  admin.editarFuncionario
);

route.post(
  '/admin/funcionarios/:id/excluir',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('funcionarios'),
  admin.excluirFuncionario
);

/*
|--------------------------------------------------------------------------
| CONFIGURAĆ‡Ć•ES
|--------------------------------------------------------------------------
*/

route.post(
  '/admin/cidades-entrega',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('configuracoes'),
  admin.criarCidadeEntrega
);

route.post(
  '/admin/cidades-entrega/:id/editar',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('configuracoes'),
  admin.editarCidadeEntrega
);

route.post(
  '/admin/cidades-entrega/:id/status',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('configuracoes'),
  admin.alterarStatusCidadeEntrega
);

route.post(
  '/admin/configuracoes',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('configuracoes'),
  perfilUpload,
  imageUploadErrorHandler,
  admin.salvarConfiguracao
);

route.post(
  '/admin/configuracoes/impressora',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('configurar_impressoras'),
  admin.salvarImpressora
);

route.post('/admin/agente/codigo', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configurar_impressoras'), admin.gerarCodigoAgente);
route.get('/admin/agente/status', loginRequired, carregarAssinatura, assinaturaRequired, permissaoQualquer('imprimir_pedidos', 'configurar_impressoras'), admin.statusAgente);
route.get('/admin/agente/download/1.2.0', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configurar_impressoras'), admin.downloadAgenteValidado);
route.get('/admin/agente/status/stream', loginRequired, carregarAssinatura, assinaturaRequired, permissaoQualquer('imprimir_pedidos', 'configurar_impressoras'), admin.streamStatusAgente);
route.post('/admin/agente/network/scan', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configurar_impressoras'), admin.buscarImpressorasRedeRemotas);
route.get('/admin/agente/impressoras', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configurar_impressoras'), admin.impressorasAgente);
route.post('/admin/agente/teste', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configurar_impressoras'), admin.testarImpressoraRemota);
route.post('/admin/agente/pedidos/:id/imprimir', loginRequired, carregarAssinatura, assinaturaRequired, permissao('imprimir_pedidos'), admin.imprimirPedidoRemoto);
route.post('/admin/agente/mesas/:id/imprimir-comanda', loginRequired, carregarAssinatura, assinaturaRequired, permissao('imprimir_pedidos'), admin.imprimirComandaMesaRemota);
route.get('/admin/agente/jobs/:jobId', loginRequired, carregarAssinatura, assinaturaRequired, permissao('imprimir_pedidos'), admin.statusJobImpressao);
route.post('/admin/agente/jobs/:jobId/retry', loginRequired, carregarAssinatura, assinaturaRequired, permissao('imprimir_pedidos'), admin.retryJobImpressao);
route.post('/admin/agente/jobs/:jobId/reconcile', loginRequired, carregarAssinatura, assinaturaRequired, permissao('imprimir_pedidos'), admin.reconciliarJobImpressao);

/*
|--------------------------------------------------------------------------
| ROTAS PĆBLICAS
|--------------------------------------------------------------------------
*/

/*
|--------------------------------------------------------------------------
| ROTAS PĆBLICAS
|--------------------------------------------------------------------------
*/

route.get(
  '/catalogo/:slug',
  admin.catalogoPublico
);

route.get('/catalogo/:slug/produtos-status', admin.statusProdutosCatalogo);
route.post('/catalogo/:slug/pedidos', respostaPedidoSemCache, limitePedidoCatalogo, limitePedidoCatalogoHora, anonymousSameOriginProtection, admin.criarPedidoCatalogo);
route.post('/catalogo/:slug/pedidos/consultar', respostaPedidoSemCache, limiteConsultaPedidoPublico, admin.consultarPedidoPublico);
route.post(
  '/catalogo/:slug/pedido/consultar',
  respostaPedidoSemCache,
  limiteAcompanhamentoPedido,
  admin.acompanharPedidoCatalogo
);
route.post('/catalogo/:slug/pedido/pix', respostaPedidoSemCache, limitePixPedido, pagamento.gerarPixPedido);
route.post('/catalogo/:slug/pedido/pagamento-status', respostaPedidoSemCache, limiteStatusPagamento, pagamento.statusPagamentoPedido);
route.post('/catalogo/:slug/pedido/avaliacao', respostaPedidoSemCache, limiteAcompanhamentoPedido, admin.avaliarProdutoCatalogo);

route.get(
  '/mesa/:token',
  admin.mesaPublica
);

route.post(
  '/mesa/:token/pedidos',
  respostaPedidoSemCache,
  limitePedidoMesa,
  limitePedidoMesaHora,
  anonymousSameOriginProtection,
  admin.criarPedidoMesa
);


route.post(
  '/mesa/:token/pedidos/:pedidoId/avaliacoes',
  admin.avaliarPedidoMesa
);

module.exports = route;
