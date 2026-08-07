# Protocolo do agente de impressão

Versão atual: `2`. Servidor compatível exige agente `1.2.0` ou superior.

## Identidade e autorização

O namespace continua sendo `/print-agent`. A autorização da loja vem
exclusivamente do token vinculado no servidor; `estabelecimentoId` informado
pelo agente nunca é usado para autorizar status ou reconciliação.

O handshake envia `agentVersion`, `protocolVersion`,
`supportedProtocolVersions` e capacidades. Agente incompatível não recebe
jobs e o painel exibe “Agente desatualizado”.

## Eventos

| Evento | Direção | Conteúdo técnico |
|---|---|---|
| `agent:token` | servidor → agente | token de vínculo, armazenado com proteção do sistema quando disponível |
| `agent:ready` | servidor → agente, com ACK | versões negociadas, capacidades e timestamp |
| `print:job` | servidor → agente, com ACK | envelope completo do trabalho |
| `job:status` | agente → servidor | ACK de transição local |
| `job:status:get` | servidor → agente, com ACK | consulta por `jobId` e `leaseId` |
| `print:reconcile` | agente → servidor, com ACK | resumo limitado dos jobs não finais |

Todo envelope de job contém:

- `protocolVersion`;
- `jobId` UUID;
- `leaseId` UUID;
- `impressoraId`;
- `attempt`;
- `deadline`;
- `modo`;
- snapshots validados de estabelecimento, pedido e impressora.

Todo ACK contém `jobId`, `leaseId`, `protocolVersion`, `agentVersion`,
`status`, `timestamp` e `impressoraId`. ACK com lease, loja, socket,
impressora ou protocolo divergente é ignorado.

## Estados

| Estado local | Interpretação |
|---|---|
| `recebido` | envelope persistido |
| `validado` | contrato e payload aprovados |
| `aceito` | execução aceita pelo agente |
| `imprimindo` | adapter foi acionado |
| `enviado_impressora` | bytes aceitos pelo spooler/socket |
| `concluido` | driver retornou sucesso |
| `falhou_antes_envio` | nenhum byte foi enviado; retry pode ser liberado |
| `resultado_desconhecido` | envio possível/parcial; retry automático proibido |

Em reinício, `imprimindo` e `enviado_impressora` são recuperados como
`resultado_desconhecido`. Um lease novo não apaga o lease e a evidência
anteriores; primeiro ocorre reconciliação.

## Reconciliação

O servidor pode responder `concluido`, `cancelar`, `manter_desconhecido`,
`liberar_para_retry` ou `aguardar`. `liberar_para_retry` só é emitido para
`falhou_antes_envio` com o mesmo lease vigente. Ausência do job no agente não
é prova de falha segura e não libera reimpressão.

Timeout de entrega ou consulta mantém o servidor em
`resultado_desconhecido`. Não é criado novo `jobId` no retry.
