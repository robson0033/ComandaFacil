# Correção — Comanda de mesa não imprimia no Agente v1.3.0

## Sintoma
Ao clicar em **Imprimir todos os pedidos** de uma mesa, o trabalho entrava na fila, era tentado repetidamente e terminava com:

`print_queue_exhausted_jobs_failed`

O monitor finalizava o job após 5 tentativas.

## Causa confirmada
A impressão consolidada da mesa passou a persistir metadados internos dentro de `PrintJob.pedido`:

- `documentoTipo`
- `comandaMesaId`
- `comandaChave`
- `comandaQuantidadePedidos`
- `comandaPedidoIds`

O Agente v1.3.0 valida `pedido` com uma allowlist estrita e não reconhece esses campos. Por segurança, ele rejeita o trabalho antes de enviar bytes à impressora. O servidor então libera retry e, após o limite, o job vira `falhou`.

## Correção aplicada
Foi adicionada `sanitizarPedidoParaAgente()` em `src/services/printQueueService.js`.

Os metadados da comanda **continuam armazenados no MongoDB** para:

- identificar que o documento é uma comanda de mesa;
- detectar/restringir reimpressões da mesma versão;
- manter a lista de pedidos que formam a comanda.

Porém, antes de montar o envelope do protocolo v2, esses campos são removidos da cópia enviada ao Agente v1.3.0.

Com isso, o agente recebe somente o contrato que já conhece e a impressão consolidada continua contendo os itens e o total da mesa.

## Compatibilidade
Não é necessário reinstalar ou atualizar o Agente v1.3.0 para esta correção.

## Jobs que já falharam
Jobs que já atingiram 5 tentativas antes do deploy permanecem com status `falhou` por segurança. Depois do deploy, basta clicar novamente em **Imprimir todos os pedidos** para gerar um novo job já compatível.

## Validações realizadas
- 153 arquivos JavaScript verificados com `node --check`: 0 falhas.
- comparação estática com a allowlist real do Agente v1.3.0: os 5 campos internos foram confirmados como não suportados pelo agente e agora são removidos antes da entrega.
- teste unitário adicionado para garantir que a sanitização não altera o snapshot persistido.
- teste de integração estática adicionado para garantir que `processarJob()` usa a sanitização antes de `buildJobEnvelope()`.
