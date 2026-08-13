# ComandaFacil — PIX online com expiração em 10 minutos

## Objetivo

O PIX online de pedidos agora possui uma janela fixa de 10 minutos. Se o pagamento não for aprovado dentro dessa janela, a tentativa expira, o QR Code deixa de ser utilizável no catálogo, o pedido passa para `pagamentoStatus = expirado` e pode ser arquivado com segurança.

## Fluxo implementado

1. Ao gerar o PIX, a tentativa é criada com expiração em 10 minutos.
2. O pedido recebe `pixExpiraEm` e o catálogo mostra uma contagem regressiva `10:00`.
3. Durante a janela, o status continua sendo consultado normalmente.
4. Ao chegar a zero:
   - o QR Code e o código copia-e-cola são ocultados/desabilitados no catálogo;
   - o servidor consulta o pagamento antes de expirar localmente;
   - se ainda estiver pendente/em processamento/autorizado, tenta cancelar o pagamento remoto;
   - o pedido passa para `pagamentoStatus = expirado`;
   - a tentativa passa para `status = expired`;
   - o painel mostra `Pagamento expirado`;
   - o pedido deixa de ser bloqueado pelo arquivamento.
5. Um worker no servidor roda a cada 30 segundos para expirar tentativas mesmo que o cliente feche o navegador.
6. No boot, tentativas antigas que já passaram da janela também são reconciliadas.

## Segurança financeira

- Antes de expirar, o servidor consulta o pagamento no Mercado Pago quando há token disponível.
- Se o pagamento já tiver sido aprovado dentro do prazo, o fluxo normal de aprovação é aplicado.
- Se surgir uma aprovação registrada depois do prazo de 10 minutos, o sistema NÃO marca o pedido silenciosamente como pago. Ele marca `reconciliation_required`, sinaliza inconsistência e dispara um alerta específico para conciliação manual.
- O PIX expirado sem aprovação pode ser arquivado por proprietário ou funcionário com a permissão de arquivamento, sem remover histórico financeiro.

## Correção adicional do webhook

Foi corrigida uma inconsistência no tratamento de pagamentos `cancelled`, `rejected`, `refunded` e `charged_back`: a restauração de estoque agora aceita corretamente os estados `restaurado`, `ja_restaurado` e `nao_baixado`. Antes, um PIX abandonado sem estoque baixado podia gerar erro em `webhook_order_processing` mesmo sem existir uma falha financeira real.

## Arquivos alterados

- `server.js`
- `src/controllers/pagamentoController.js`
- `src/models/painelModels.js`
- `src/services/pedidoArquivamentoService.js`
- `src/services/pedidoPixExpirationService.js` (novo)
- `src/services/pedidoPublicoTokenService.js`
- `src/views/admin-real.ejs`
- `src/views/catalogo-publico.ejs`
- `test/orderPixExpiration10minP0.test.js` (novo)
- `test/pedidoSoftDeleteP0.test.js`

## Validações realizadas

- 7/7 testes específicos da expiração de PIX passaram.
- 155 arquivos JavaScript passaram em `node --check` pelo script de sintaxe do projeto.
- Os JavaScripts embutidos alterados de `catalogo-publico.ejs` e `admin-real.ejs` foram extraídos e passaram em `node --check` após neutralizar apenas as expressões EJS do servidor.
- A suíte completa foi tentada, mas o `npm ci` não terminou dentro do ambiente de execução e deixou dependências incompletas; por isso testes não relacionados que importam pacotes ausentes falharam por `MODULE_NOT_FOUND`. Isso não foi contado como falha funcional da mudança.

## Comportamento esperado no painel

Enquanto o PIX estiver válido:

`Pagamento: Pendente`

Após 10 minutos sem aprovação:

`Pagamento expirado`

Nesse estado, o botão de arquivamento pode concluir o arquivamento normalmente, desde que não exista aprovação tardia ou conciliação financeira pendente.
