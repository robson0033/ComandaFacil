# Rollout e rollback do agente de impressão 1.2.0

## Estado inicial

Mantenha:

```env
PRINT_PROTOCOL_V2_ENABLED=false
PRINT_PROTOCOL_V2_PILOT_ESTABLISHMENT_IDS=
PRINT_AGENT_DOWNLOAD_1_2_0_ENABLED=false
```

Com a flag desativada, os `PrintJob` persistidos permanecem na fila e não são
entregues. Não existe fallback para protocolo 1 ou trabalho sem `leaseId`.

## Ativação piloto

Depois do build Windows verificado e da homologação física:

1. Coloque o EXE, `checksums-1.2.0.txt` e `homologacao-1.2.0.json` em diretório
   privado, absoluto e fora de `public`.
2. O JSON deve declarar versão `1.2.0`, plataforma `win32`,
   `physicalHomologationApproved: true` e `buildVerificationApproved: true`.
3. Configure IDs MongoDB técnicos, separados por vírgula:

```env
PRINT_PROTOCOL_V2_ENABLED=true
PRINT_PROTOCOL_V2_PILOT_ESTABLISHMENT_IDS=ID_LOJA_PILOTO
```

Os IDs são validados no boot. O navegador não participa da decisão. Lista vazia
com a flag ativa libera todas as lojas, portanto só deve ser usada após o piloto.

## Download preparado

O link atual do painel não é substituído automaticamente. A rota fixa e
autenticada `/admin/agente/download/1.2.0` somente serve o EXE quando:

- `PRINT_AGENT_DOWNLOAD_1_2_0_ENABLED=true`;
- `PRINT_AGENT_ARTIFACT_DIRECTORY` é absoluto;
- nome, tamanho, checksum e manifesto de homologação são válidos.

O arquivo é enviado com Content-Type de executável Windows,
Content-Disposition attachment, Content-Length e `X-Checksum-SHA256`.

## Rollback

1. Defina `PRINT_PROTOCOL_V2_ENABLED=false` e reinicie com segurança.
2. Preserve os jobs persistidos; não altere `jobId`, lease ou estados ambíguos.
3. Desative o download 1.2.0 se o instalador estiver sob investigação.
4. Não envie jobs v2 ao agente 1.1.1 e não faça downgrade silencioso.
5. Preserve configuração, token e `print-jobs-v2.json` no Windows.
6. Concilie resultados desconhecidos antes de reativar.
7. Reative somente a loja piloto; amplie após observação controlada.

