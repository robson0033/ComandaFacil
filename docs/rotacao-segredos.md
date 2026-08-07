# Rotação de segredos

## Princípio

Rotação é a troca controlada de uma credencial antiga por uma nova. O procedimento padrão é:

1. **Preparar** a credencial nova sem revogar a antiga.
2. **Aplicar** o novo valor somente no ambiente correto.
3. **Implantar** e reiniciar de forma controlada.
4. **Validar** a função afetada e o endpoint `/ready`.
5. **Revogar** a credencial antiga.
6. **Registrar** data, responsável, resultado e motivo, sem registrar o valor.
7. **Rollback**: restaurar temporariamente o valor anterior somente quando ele ainda estiver válido e a nova credencial falhar.

Nunca cole valores de segredo no documento de rotação, commit, issue, chat, log ou captura de tela.

## Registro mínimo

Use um registro privado com estes campos:

```text
DATA_UTC=
AMBIENTE=development|test|production
CREDENCIAL=
MOTIVO=rotina|vazamento|troca_de_pessoa|falha_do_provedor
RESPONSAVEL=
NOVO_VALOR_APLICADO=SIM|NAO
VALIDACAO=APROVADA|REPROVADA
ANTIGO_REVOGADO=SIM|NAO
ROLLBACK=NAO|EXECUTADO
OBSERVACAO_SEM_SEGREDOS=
```

## `CONNECTIONSTRING`

**Impacto:** conexão com o MongoDB e armazenamento de sessões.

1. Criar um usuário novo no Atlas com os privilégios mínimos do ambiente.
2. Manter o usuário antigo ativo durante a transição.
3. Atualizar `.env` local ou Render, nunca ambos com a mesma credencial.
4. Reiniciar e validar `/ready`, login, leitura e criação de pedido.
5. Confirmar que a sessão usa MongoStore.
6. Revogar o usuário/senha antigo.
7. Em rollback, reativar temporariamente o usuário antigo somente se necessário.

## `SESSION_SECRET`

**Impacto:** sessões existentes deixam de ser válidas e usuários precisarão entrar novamente.

1. Gerar um valor aleatório forte exclusivo do ambiente.
2. Programar a troca em horário controlado.
3. Atualizar no Render e implantar.
4. Validar login, logout, CSRF e nova sessão.
5. Não reutilizar o valor antigo em nenhum outro ambiente.

O sistema atual não possui janela com dois `SESSION_SECRET`; a troca é imediata.

## `TOKEN_ENCRYPTION_KEY`

**Impacto crítico:** tokens OAuth do Mercado Pago persistidos com a chave antiga podem ficar ilegíveis.

Não rotacione diretamente sem um plano de migração. Escolha uma destas estratégias:

- implementar leitura com chave antiga e regravação com chave nova; ou
- exigir reconexão OAuth de todas as lojas após a troca.

Antes de revogar a chave antiga, validar uma loja piloto, pagamento Pix e consulta de credencial. Em caso de dúvida, interromper a rotação e não apagar a chave anterior.


## `AVALIACAO_AUDIT_SALT`

**Impacto:** identificadores técnicos de auditoria podem mudar após a rotação.

1. Gerar um valor aleatório exclusivo do ambiente.
2. Atualizar no ambiente correto.
3. Implantar e validar criação e consulta de avaliações sem exposição de dados pessoais.
4. Confirmar que logs novos continuam usando somente identificadores técnicos.
5. Revogar o valor antigo após a validação.

## Mercado Pago

### `MERCADO_PAGO_ACCESS_TOKEN`

1. Emitir uma nova credencial da plataforma.
2. Atualizar somente no Render.
3. Validar o diagnóstico seguro de `/users/me`, Pix de teste e assinatura em conta de teste.
4. Confirmar que nenhum token apareceu nos logs.
5. Revogar a credencial antiga.

### `MERCADO_PAGO_WEBHOOK_SECRET`

1. Preparar a mudança no Mercado Pago e no Render na mesma janela.
2. Atualizar o segredo e implantar.
3. Enviar um webhook de teste válido.
4. Confirmar resposta `200`, idempotência e ausência de efeitos duplicados.
5. Eventos assinados com o segredo antigo podem falhar durante a transição; acompanhe os alertas do Discord.

### `MP_CLIENT_SECRET`

1. Emitir ou regenerar o segredo do aplicativo OAuth.
2. Atualizar no Render.
3. Validar início OAuth, callback e identidade da conta conectada.
4. Revogar o segredo antigo depois da validação.

## Cloudinary — `CLOUDINARY_API_SECRET`

1. Criar/regenerar o segredo no provedor.
2. Atualizar no Render.
3. Validar upload, leitura e remoção de uma imagem de homologação.
4. Confirmar que a aplicação continua usando HTTPS e o namespace correto.
5. Revogar o segredo antigo.

## SMTP — `SMTP_PASS`

1. Criar nova senha de aplicativo ou credencial SMTP.
2. Atualizar no Render.
3. Enviar recuperação de senha para uma conta de teste.
4. Confirmar entrega e ausência de token/senha nos logs.
5. Revogar a credencial antiga.

O alerta de falha de e-mail usa o Discord, portanto continua independente do SMTP.

## Discord — `ALERT_WEBHOOK_URL`

1. Criar um webhook novo no canal privado.
2. Atualizar `ALERT_WEBHOOK_URL` no Render.
3. Implantar e executar `scripts/testar-alertas-operacionais.js` com autorização temporária.
4. Confirmar 7 de 7 mensagens entregues e nenhuma exposição de segredo.
5. Excluir o webhook antigo no Discord.

Não tente editar apenas o token no final da URL; trate a URL inteira como segredo.

## Endpoint próprio — `ALERT_WEBHOOK_BEARER_TOKEN`

1. Permitir temporariamente token antigo e novo no receptor, quando o receptor suportar sobreposição.
2. Atualizar o Render.
3. Testar entrega.
4. Remover o token antigo no receptor.

## Agente de impressão

1. Revogar ou desconectar o vínculo antigo.
2. Gerar um novo código de vínculo no painel.
3. Vincular novamente o agente correto.
4. Confirmar status conectado e uma impressão controlada.
5. Não reutilizar token entre lojas, computadores ou ambientes.

## Incidente de exposição

Quando houver suspeita de vazamento:

1. considerar a credencial comprometida, mesmo sem prova de uso;
2. rotacionar imediatamente a credencial afetada;
3. revisar logs por uso anormal sem registrar o segredo;
4. encerrar sessões quando `SESSION_SECRET` ou cookies forem afetados;
5. revogar tokens OAuth e webhooks afetados;
6. verificar histórico do Git e remover o segredo também do provedor — apenas apagar do commit atual não o torna seguro;
7. registrar o incidente de forma privada.

## Frequência sugerida

- imediatamente após vazamento, troca de responsável ou perda de dispositivo;
- periodicamente conforme a política do provedor e da empresa;
- após uso temporário de uma credencial de diagnóstico;
- sempre que uma credencial tiver sido compartilhada por meio inadequado.
