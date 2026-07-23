const express = require('express');
const multer = require('multer');

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

const admin = require(
  './src/controllers/adminRealController'
);

const pagamento = require(
  './src/controllers/pagamentoController'
);


const {
  loginRequired,
  permissao,
} = require('./src/middleware/auth');

const {
  carregarAssinatura,
  assinaturaRequired,
} = require('./src/middleware/assinatura');

/*
|--------------------------------------------------------------------------
| CONFIGURAÇÃO DO MULTER — IMAGENS NO MONGODB
|--------------------------------------------------------------------------
|
| As imagens ficam temporariamente na memória durante o upload.
| Depois, o controller converte o arquivo para uma Data URL Base64
| e salva esse conteúdo diretamente no documento do MongoDB.
|
| Assim, as novas imagens não dependem da pasta public/uploads.
|
*/

const imageFilter = (
  req,
  file,
  callback
) => {
  const tiposPermitidos = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  ];

  if (
    !tiposPermitidos.includes(
      file.mimetype
    )
  ) {
    return callback(
      new Error(
        'Envie uma imagem JPG, PNG, WEBP ou GIF.'
      )
    );
  }

  return callback(null, true);
};

const criarUploadDeImagem = () => {
  return multer({
    storage: multer.memoryStorage(),

    fileFilter: imageFilter,

    limits: {
      /*
       * O MongoDB aceita no máximo 16 MB por documento.
       * O limite de 3 MB evita que a conversão Base64 deixe
       * o documento excessivamente grande.
       */
      fileSize: 3 * 1024 * 1024,
    },
  });
};

const produtoUpload =
  criarUploadDeImagem();

const perfilUpload =
  criarUploadDeImagem();

const funcionarioUpload =
  criarUploadDeImagem();

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

route.post(
  '/login/admin',
  loginController.login
);

route.get(
  '/cadastro/index',
  registroController.cadastro
);

route.post(
  '/cadastro/login',
  registroController.registro
);

route.get(
  '/login/logout',
  loginController.logout
);

/*
|--------------------------------------------------------------------------
| ASSINATURA E MERCADO PAGO
|--------------------------------------------------------------------------
*/

route.get(
  '/assinatura',
  loginRequired,
  carregarAssinatura,
  pagamento.pagina
);

route.post(
  '/assinatura/cartao',
  loginRequired,
  carregarAssinatura,
  pagamento.assinarCartao
);

route.post(
  '/assinatura/pix',
  loginRequired,
  carregarAssinatura,
  pagamento.gerarPix
);

route.get(
  '/assinatura/retorno',
  loginRequired,
  carregarAssinatura,
  pagamento.retorno
);

route.get('/admin/mercado-pago/conectar', loginRequired, pagamento.conectarMercadoPago);
route.get('/admin/mercado-pago/callback', loginRequired, pagamento.callbackMercadoPago);
route.post('/admin/mercado-pago/desconectar', loginRequired, pagamento.desconectarMercadoPago);

route.post(
  '/webhook/mercado-pago',
  pagamento.webhook
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
  '/admin/pedidos/:id/excluir',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('pedidos'),
  admin.excluirPedido
);

route.get(
  '/admin/api/pedidos/novos',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('pedidos'),
  admin.buscarNovosPedidos
);

/*
|--------------------------------------------------------------------------
| CATEGORIAS
|--------------------------------------------------------------------------
*/

route.post(
  '/admin/categorias',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  admin.criarCategoria
);

route.post(
  '/admin/categorias/:id/excluir',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
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
  produtoUpload.single('imagem'),
  admin.criarProduto
);


route.post(
  '/admin/produtos/:id/editar',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('catalogo'),
  produtoUpload.single('imagem'),
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
  permissao('mesas'),
  admin.solicitarContaMesa
);

route.post(
  '/admin/mesas/:id/pagar',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('mesas'),
  admin.pagarContaMesa
);

/*
|--------------------------------------------------------------------------
| FUNCIONĆRIOS
|--------------------------------------------------------------------------
*/

route.post(
  '/admin/funcionarios/:id/editar',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('funcionarios'),
  funcionarioUpload.single('foto'),
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
  '/admin/configuracoes',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('configuracoes'),
  perfilUpload.single('fotoPerfil'),
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
route.get('/admin/agente/status', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configurar_impressoras'), admin.statusAgente);
route.get('/admin/agente/network/scan', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configurar_impressoras'), admin.buscarImpressorasRedeRemotas);
route.get('/admin/agente/impressoras', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configurar_impressoras'), admin.impressorasAgente);
route.post('/admin/agente/teste', loginRequired, carregarAssinatura, assinaturaRequired, permissao('configurar_impressoras'), admin.testarImpressoraRemota);
route.post('/admin/agente/pedidos/:id/imprimir', loginRequired, carregarAssinatura, assinaturaRequired, permissao('imprimir_pedidos'), admin.imprimirPedidoRemoto);

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

route.post('/catalogo/:slug/pedidos', admin.criarPedidoCatalogo);
route.post('/catalogo/:slug/pedidos/:pedidoId/pix', pagamento.gerarPixPedido);
route.get('/catalogo/:slug/pedidos/:pedidoId/pagamento-status', pagamento.statusPagamentoPedido);
route.get('/catalogo/:slug/meus-pedidos', admin.buscarPedidosCatalogo);
route.post('/catalogo/:slug/produtos/:produtoId/avaliacoes', admin.avaliarProdutoCatalogo);

route.get(
  '/mesa/:token',
  admin.mesaPublica
);

route.post(
  '/mesa/:token/pedidos',
  admin.criarPedidoMesa
);


route.post(
  '/mesa/:token/pedidos/:pedidoId/avaliacoes',
  admin.avaliarPedidoMesa
);

route.get(
  '/admin/api/pedidos/novos',
  loginRequired,
  carregarAssinatura,
  assinaturaRequired,
  permissao('pedidos'),
  admin.buscarNovosPedidos
);

module.exports = route;