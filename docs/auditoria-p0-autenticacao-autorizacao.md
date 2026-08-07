# Auditoria P0 — autenticação, autorização e chamadas administrativas

Data: 2026-07-29. Escopo local, sem banco, Render, Mercado Pago, Cloudinary ou
impressora reais.

## Inventário de proteção

O router possui 79 combinações únicas de método e caminho. A tabela agrupa
rotas com a mesma política; parâmetros `:id`, `:jobId`, `:slug` e `:token`
continuam sendo validados por rota/controller.

| Método e caminhos | Finalidade | Sessão | Assinatura | Permissão | Origin/CSRF | Tenant | Resposta |
|---|---|---:|---:|---|---:|---:|---|
| GET `/`, `/login`, `/login/index`, `/termos`, `/privacidade` | páginas públicas | não | não | não | não | não | HTML |
| POST `/login/admin` | login | sessão anônima | não | não | política própria do login | não | HTML |
| GET/POST `/login/recuperar-senha`, `/login/verificar-codigo`, `/login/nova-senha` | recuperação | sessão anônima | não | não | controles de código/token | identidade recuperada | HTML |
| GET `/cadastro/index`, POST `/cadastro/login` | cadastro | sessão anônima | não | não | validação de cadastro | novo tenant | HTML |
| POST `/login/logout` | logout | sim ou idempotente | não | não | sim quando autenticado | sessão | 303 |
| GET `/assinatura`, `/assinatura/retorno` | regularização | sim | exceção de regularização | proprietário/configurações | GET seguro | sessão | HTML |
| POST `/assinatura/cartao`, `/assinatura/pix` | iniciar pagamento | sim | exceção de regularização | proprietário/configurações | sim | sessão | HTML |
| POST `/webhook/mercado-pago` | webhook | não | não | assinatura MP | não usa CSRF | referência validada | JSON |
| GET `/admin` e aliases de seção | painel | sim | sim | seção atual | GET sem CSRF | sessão | HTML/redirect |
| GET `/admin/api/pedidos/novos`, `/admin/api/pedidos/:id/impressao` | leitura interna | sim | sim | pedidos/impressão | GET sem CSRF | sessão | JSON |
| GET `/admin/api/pedidos/stream`, `/admin/agente/status/stream` | SSE | sim/revalidada | sim | pedidos/impressoras | GET sem CSRF | sessão | SSE |
| POST `/admin/pedidos/:id/status`, `/confirmar-pagamento`, `/arquivar` | pedidos | sim | sim | pedidos/arquivar | sim | `_id` + tenant | HTML/JSON |
| GET/POST `/admin/categorias*` | categorias | sim | sim | estoque ou catálogo | POST: sim | `_id` + tenant | HTML |
| POST `/admin/estoque*` | estoque | sim | sim | estoque | sim | `_id` + tenant | HTML/JSON |
| POST `/admin/produtos*` | produtos e adicionais embutidos | sim | sim | catálogo | sim | produto/categoria/ingrediente + tenant | HTML/JSON |
| POST `/admin/mesas*` | mesas e pagamento | sim | sim | mesas | sim | `_id` + tenant | HTML |
| POST `/admin/funcionarios*` | funcionários | sim | sim | funcionários | sim | `_id` + tenant | HTML/JSON |
| POST `/admin/configuracoes*` | loja/impressora | sim | sim | configurações/impressoras | sim | tenant da sessão | HTML/JSON |
| GET/POST `/admin/agente*` | agente, impressão e jobs | sim | sim | impressão/impressoras | POST: sim | tenant + job/pedido | JSON/SSE/arquivo |
| POST `/admin/mercado-pago/conectar`, `/desconectar` | conta MP da loja | sim | sim | proprietário/configurações | sim | tenant da sessão | redirect |
| GET `/admin/mercado-pago/callback` | callback OAuth | sim | sim | proprietário/configurações | state de uso único | tenant/state | redirect |
| GET `/catalogo/:slug*`, `/mesa/:token` | catálogo/mesa pública | não | acesso da loja | token/slug | GET sem CSRF | loja resolvida | HTML/JSON |
| POST `/catalogo/:slug/pedidos` | criar pedido público | não | acesso da loja | não | rate limit/validação | slug resolvido | JSON |
| POST `/catalogo/:slug/pedido/*` | acompanhar, Pix, status, avaliação | token público | acesso da loja | bearer público | rate limit/token | slug + hash token | JSON |
| POST `/mesa/:token/pedidos*` | pedidos/avaliação de mesa | token da mesa | acesso da loja | token | validação pública | mesa + tenant | JSON |

O callback OAuth é a única rota GET que conclui alteração de estado. É uma
exceção necessária ao redirect do provedor e exige sessão, state imprevisível,
uso único, expiração e vínculo com tenant; não depende de Origin do provedor.

## Fluxo de adicionais

- Criação: `POST /admin/produtos`.
- Edição: `POST /admin/produtos/:id/editar`.
- Formulário: `adicionaisNome[]` e `adicionaisPreco[]`, com `_csrf`.
- Sem imagem: submit HTML same-origin.
- Com imagem: `adminFetch`, `FormData`, `credentials: same-origin` e
  `X-CSRF-Token`.
- Middleware: CSRF global `/admin`, identidade atual, assinatura e permissão
  `catalogo`.
- Controller: whitelist explícita; nenhum `estabelecimentoId` do navegador.
- Relações: categoria, produto e ingredientes são consultados com tenant.
- Limites: 30 adicionais, nome 1–120, preço finito entre 0 e 100000 e nomes
  únicos sem diferença de caixa.

A mensagem genérica vinha do reject do middleware CSRF, antes do controller.
Agora fetch recebe código JSON e formulário antigo recebe redirect 303 para
recarregar token, com mensagem específica.

## Permissões

| Permissão | Uso |
|---|---|
| `dashboard` | métricas do painel |
| `pedidos` | leitura e operação de pedidos |
| `relatorios` | relatórios |
| `estoque` | categorias/ingredientes de estoque |
| `catalogo` | categorias, produtos e adicionais |
| `mesas` | mesas e conta |
| `funcionarios` | administração de funcionários |
| `configuracoes` | configuração da loja e Mercado Pago |
| `imprimir_pedidos` | impressão e jobs |
| `configurar_impressoras` | agente e impressoras |
| `arquivar_pedidos` | soft delete de pedidos |

Nomes são centralizados em `src/config/permissions.js`. Permissão desconhecida
falha durante a montagem da rota. Funcionário não pode conceder permissões
críticas nem superiores às próprias.

## Render

Variáveis necessárias: `NODE_ENV=production`, `APP_URL` HTTPS exata,
`SESSION_SECRET` com pelo menos 32 caracteres, `CONNECTIONSTRING`,
configuração Cloudinary e credenciais Mercado Pago já exigidas pelo validador
de ambiente. `ALLOWED_ORIGINS` deve ser omitida quando desnecessária ou conter
somente origens HTTPS exatas.

## Homologação após deploy

1. Limpar cookies antigos e confirmar somente `comandamix.sid`.
2. Entrar e inspecionar `X-Correlation-Id`, CSP e Referrer-Policy.
3. Criar e editar produto com e sem imagem e com adicionais.
4. Repetir com funcionário com/sem `catalogo`.
5. Manter duas abas; renovar sessão em uma e tentar mutação antiga na outra.
6. Apagar cookie antes de salvar e antes do logout.
7. Confirmar códigos distintos para 401, CSRF, Origin e permissão.
8. Confirmar encerramento de SSE no logout/desativação.
9. Validar callback/webhook Mercado Pago no sandbox.
10. Validar upload Cloudinary real e impressão somente em ambiente controlado.
