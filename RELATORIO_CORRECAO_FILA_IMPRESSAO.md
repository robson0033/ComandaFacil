# Correção da fila de impressão — `print_queue_stuck`

Data: 2026-08-11

## Problema observado

O monitor operacional tratava qualquer `PrintJob` antigo em `pendente` como fila
travada. Isso gerava `print_queue_stuck` mesmo quando o computador do agente de
impressão estava desligado/desconectado ou quando o protocolo de impressão da
loja estava pausado.

Também existiam duas situações que podiam deixar jobs sem saída:

1. a impressora do snapshot do job era removida, desativada ou mudava de origem
   (Delivery/Mesa/Retirada) depois da criação do job;
2. o job chegava ao limite de 5 tentativas ainda em `pendente`/`aguardando_retry`
   e deixava de ser elegível para novo claim, sem ser finalizado como falha.

Além disso, jobs antigos sem `nextAttemptAt` não eram elegíveis ao claim e o
estado `enviado` não participava da recuperação de lease expirado.

## Correções aplicadas

- `pendente` e `aguardando_retry` só abrem `print_queue_stuck` se:
  - o protocolo v2 estiver habilitado para a loja; e
  - houver um agente compatível efetivamente online/pronto.
- Agente offline não consome tentativa e não gera alerta crítico falso.
- Jobs de impressora removida/desativada ou incompatível com a origem atual são
  cancelados com motivo explícito, sem apagar o pedido.
- A reconciliação roda:
  - no boot do servidor;
  - a cada 5 minutos;
  - imediatamente depois de salvar as configurações de impressoras.
- Jobs com 5 tentativas esgotadas passam para `falhou`, permitindo a ação manual
  de reimpressão em vez de permanecerem eternamente em `pendente`.
- Jobs legados com `nextAttemptAt` ausente/null continuam elegíveis para claim.
- `enviado` com lease expirado passa para `resultado_desconhecido`, permitindo a
  reconciliação segura com o agente.
- Foram adicionados logs seguros:
  - `print_queue_orphan_jobs_cancelled`
  - `print_queue_exhausted_jobs_failed`

## O que acontece com os jobs antigos após o deploy

- Impressora ainda válida + agente online: o job volta a ser consumido pela fila.
- Impressora removida/desativada/incompatível com a origem: `cancelado` com motivo.
- Cinco tentativas já consumidas: `falhou`, podendo ser reimpresso manualmente.
- Agente offline: permanece aguardando sem gerar `critical`; quando o agente
  reconectar, o job continua elegível para impressão.

Nenhum pedido é apagado por esta correção.

## Variável do Render

O protocolo do agente continua respeitando a configuração de rollout já
existente. Para produção, se o painel do agente mostrar **Aguardando ativação**,
confirme no Render:

```env
PRINT_PROTOCOL_V2_ENABLED=true
```

Se o agente já aparece como **Conectado**, não é necessário alterar essa variável.

## Validações executadas

- 144 arquivos JavaScript aprovados pelo verificador de sintaxe.
- 11/11 testes de alertas operacionais aprovados.
- 14/14 testes de hardening de produção aprovados.
- 3/3 testes de integração estática da recuperação de fila aprovados.
- Verificação dinâmica com modelos simulados aprovou:
  - roteamento por impressora/origem;
  - finalização de tentativas esgotadas;
  - cancelamento seguro de job órfão.
