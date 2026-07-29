# Auditoria de rotas administrativas mutáveis

Todas as rotas `/admin/**` abaixo passam primeiro por
`route.use('/admin', csrfSameOriginProtection)`. O middleware exige origem
exata e token CSRF. Depois dele são aplicados sessão, assinatura e permissão.
Os controllers resolvem `estabelecimentoId` pela sessão e não pelo formulário.

| Método | Path | Controller | Autenticação / permissão | Isolamento |
|---|---|---|---|---|
| POST | `/admin/mercado-pago/conectar` | `pagamento.conectarMercadoPago` | proprietário, assinatura, configurações | sessão |
| POST | `/admin/mercado-pago/desconectar` | `pagamento.desconectarMercadoPago` | proprietário, assinatura, configurações | sessão |
| POST | `/admin/pedidos/:id/status` | `admin.atualizarStatusPedido` | login, assinatura, pedidos | `_id` + loja |
| POST | `/admin/pedidos/:id/confirmar-pagamento` | `admin.confirmarPagamentoPedido` | login, assinatura, pedidos | `_id` + loja |
| POST | `/admin/pedidos/:id/arquivar` | `admin.arquivarPedido` | login, assinatura, arquivar pedidos | `_id` + loja |
| POST | `/admin/categorias` | `admin.criarCategoria` | login, assinatura, estoque/catálogo | loja da sessão |
| POST | `/admin/categorias/:id/excluir` | `admin.excluirCategoria` | login, assinatura, estoque/catálogo | `_id` + loja |
| POST | `/admin/estoque` | `admin.criarEstoque` | login, assinatura, estoque | loja da sessão |
| POST | `/admin/estoque/:id/excluir` | `admin.excluirEstoque` | login, assinatura, estoque | `_id` + loja |
| POST | `/admin/produtos` | `admin.criarProduto` | login, assinatura, catálogo, upload | loja da sessão |
| POST | `/admin/produtos/:id/editar` | `admin.editarProduto` | login, assinatura, catálogo, upload | `_id` + loja |
| POST | `/admin/produtos/:id/excluir` | `admin.excluirProduto` | login, assinatura, catálogo | `_id` + loja |
| POST | `/admin/mesas` | `admin.criarMesa` | login, assinatura, mesas | loja da sessão |
| POST | `/admin/mesas/:id/excluir` | `admin.excluirMesa` | login, assinatura, mesas | `_id` + loja |
| POST | `/admin/mesas/:id/status` | `admin.atualizarStatusMesa` | login, assinatura, mesas | `_id` + loja |
| POST | `/admin/mesas/:id/solicitar-conta` | `admin.solicitarContaMesa` | login, assinatura, mesas | `_id` + loja |
| POST | `/admin/mesas/:id/pagar` | `admin.pagarContaMesa` | login, assinatura, mesas | `_id` + loja |
| POST | `/admin/funcionarios` | `admin.criarFuncionario` | login, assinatura, funcionários, upload | loja da sessão |
| POST | `/admin/funcionarios/:id/editar` | `admin.editarFuncionario` | login, assinatura, funcionários, upload | `_id` + loja |
| POST | `/admin/funcionarios/:id/excluir` | `admin.excluirFuncionario` | login, assinatura, funcionários | `_id` + loja |
| POST | `/admin/configuracoes` | `admin.salvarConfiguracao` | login, assinatura, configurações, upload | loja da sessão |
| POST | `/admin/configuracoes/impressora` | `admin.salvarImpressora` | login, assinatura, configurar impressoras | loja da sessão |
| POST | `/admin/agente/codigo` | `admin.gerarCodigoAgente` | login, assinatura, configurar impressoras | loja da sessão |
| POST | `/admin/agente/network/scan` | `admin.buscarImpressorasRedeRemotas` | login, assinatura, configurar impressoras | socket da loja |
| POST | `/admin/agente/teste` | `admin.testarImpressoraRemota` | login, assinatura, configurar impressoras | socket da loja |
| POST | `/admin/agente/pedidos/:id/imprimir` | `admin.imprimirPedidoRemoto` | login, assinatura, imprimir pedidos | pedido + loja |
| POST | `/admin/agente/jobs/:jobId/retry` | `admin.retryJobImpressao` | login, assinatura, imprimir pedidos | job + loja |
| POST | `/admin/agente/jobs/:jobId/reconcile` | `admin.reconciliarJobImpressao` | login, assinatura, imprimir pedidos | job + loja |

Rotas administrativas fora do prefixo `/admin`:

| Método | Path | Proteção |
|---|---|---|
| POST | `/login/logout` | `csrfSameOriginProtection`, sessão do logout |
| POST | `/assinatura/cartao` | middleware global `/assinatura`, proprietário e configurações |
| POST | `/assinatura/pix` | middleware global `/assinatura`, proprietário e configurações |

Login, recuperação, cadastro, catálogo público, mesa pública e webhook não são
rotas administrativas e possuem políticas próprias. O webhook Mercado Pago não
usa sessão/CSRF de navegador; ele usa autenticação criptográfica específica.

## Diagnóstico temporário de Origin

Para investigar diferenças do proxy sem registrar headers sensíveis:

```env
CSRF_ORIGIN_DIAGNOSTICS=true
```

O evento `csrf_origin_diagnostic` registra somente método, path, tipo e tamanho
do valor de Origin, origem normalizada, origem normalizada do `APP_URL`,
quantidade de origens permitidas e se houve correspondência. Depois da
confirmação no Render, remova ou defina a variável como `false`; o log normal
fica reduzido a código técnico, método e path.

## Origem opaca e validação após deploy

A CSP principal do projeto não contém `sandbox`; usa `frame-ancestors 'none'`
para impedir incorporação sem transformar o documento em origem opaca. Também
não existem meta CSP, iframe sandbox ou service worker no repositório. Respostas
administrativas recebem `Cache-Control: no-store, private`.

Após um deploy controlado:

1. DevTools → Application → Service Workers → Unregister;
2. Storage → Clear site data;
3. feche todas as abas do sistema;
4. abra novamente e faça login;
5. cadastre uma categoria de teste;
6. confira no Network que o POST envia
   `Origin: https://comandafacil-2kot.onrender.com`;
7. confira no GET `/admin` que existe somente uma
   `Content-Security-Policy`, sem a diretiva `sandbox`.

`Origin: null` permanece bloqueada. `Sec-Fetch-Site` não substitui Origin,
sessão ou token CSRF.
