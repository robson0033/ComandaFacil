# Correção — webhook Mercado Pago x pedido arquivado

## Problema corrigido

O webhook `payment.updated` podia localizar um `OrderPaymentAttempt`, mas deixar de localizar o pedido porque a consulta excluía documentos com `excluido: true`. Isso gerava:

- `mercado_pago_webhook_failed`
- `stage: webhook_unknown`
- HTTP 503
- mensagem `Pedido da tentativa de pagamento não encontrado.`

O Mercado Pago podia reenviar o mesmo evento porque o servidor respondia 503.

## Mudanças aplicadas

### 1. Arquivamento protegido contra PIX em andamento

Antes de arquivar, o serviço agora consulta `OrderPaymentAttempt` do mesmo estabelecimento e pedido.

O arquivamento é bloqueado quando existir:

- `creating`
- `pending`
- `in_process`
- `authorized`
- pagamento `approved` ainda não conciliado
- `reconciliationStatus: reconciliation_required`

O painel recebe HTTP 409 com um código específico:

- `PIX_EM_PROCESSAMENTO`
- `PIX_RECONCILIACAO_NECESSARIA`

A tentativa bloqueada também fica registrada na auditoria de arquivamento.

### 2. Webhook reconhece pedidos arquivados

Quando a tentativa existe, o webhook agora procura o pedido mesmo que `excluido: true`.

O fluxo passa a distinguir:

- `order`: pedido operacional normal
- `archived_order`: pedido já arquivado
- `orphaned_order_attempt`: tentativa ainda existe, mas o documento do pedido não existe mais

### 3. Pagamento aprovado após arquivamento

O sistema NÃO reabre o pedido e NÃO o marca automaticamente como pago.

Ele:

- valida ID do pagamento, valor, moeda, referência externa e conta recebedora;
- atualiza a tentativa para `reconciliation_required`;
- preserva o evento no histórico financeiro do pedido arquivado;
- marca `pagamentoInconsistente: true`;
- grava o motivo da inconsistência;
- dispara o alerta específico `mercado_pago_archived_order_payment_detected`;
- conclui o webhook normalmente para evitar loop de HTTP 503.

Eventos financeiros de uma tentativa órfã usam `mercado_pago_orphaned_order_payment_detected`.

### 4. Rejeitado/cancelado após arquivamento

Se o Mercado Pago informar `rejected` ou `cancelled`, a tentativa é encerrada como processada e não gera alerta financeiro crítico.

### 5. Diagnóstico com stages específicos

Erros novos deixam de cair genericamente em `webhook_unknown` quando for possível identificar o ponto:

- `webhook_order_token_lookup`
- `webhook_order_resource_lookup`
- `webhook_order_processing`
- `webhook_archived_order_validation`
- `webhook_archived_order_processing`
- `webhook_orphaned_order_validation`
- `webhook_orphaned_order_processing`
- `webhook_subscription_processing`
- `webhook_preapproval_processing`
- `webhook_resource_identity`

### 6. Visibilidade em Pedidos arquivados

A tabela de pedidos arquivados ganhou a coluna **Financeiro**.

Se um evento financeiro chegar depois do arquivamento, ela mostra:

`⚠ Conciliação necessária`

O detalhe fica disponível no atributo de ajuda do texto.

## Arquivos alterados

- `src/controllers/pagamentoController.js`
- `src/services/pedidoArquivamentoService.js`
- `src/controllers/adminRealController.js`
- `src/views/admin-real.ejs`
- `test/pedidoSoftDeleteP0.test.js`
- `test/mercadoPagoArchivedOrderWebhookP0.test.js` (novo)

## Verificações realizadas

- 148 arquivos JavaScript aprovados em `node --check`.
- 12 verificações estáticas de integração aprovadas.
- Foram adicionados 7 cenários de regressão automatizados para PIX/arquivamento/webhook.
- A instalação completa das dependências para executar `npm test` não concluiu no ambiente de preparação, então esses testes de runtime devem rodar normalmente no CI/Render após `npm install`/`npm ci`.

## Comportamento esperado para o incidente informado

Para um evento cuja tentativa exista e o pedido esteja arquivado:

- o erro `Pedido da tentativa de pagamento não encontrado.` deixa de ocorrer;
- se o pagamento estiver `approved`, o webhook responde 200 após registrar a necessidade de conciliação e gera o alerta específico;
- se estiver `rejected`/`cancelled`, o webhook responde 200 sem alerta crítico financeiro;
- novos pedidos não poderão ser arquivados enquanto um PIX estiver em andamento ou pendente de conciliação.
