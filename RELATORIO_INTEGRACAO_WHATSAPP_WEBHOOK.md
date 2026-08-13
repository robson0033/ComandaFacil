# Integração inicial — WhatsApp Cloud API

## Implementado

- `GET /webhook/whatsapp` para a verificação do callback da Meta (`hub.challenge`).
- `POST /webhook/whatsapp` para receber mensagens e status.
- Validação criptográfica do POST pelo cabeçalho `X-Hub-Signature-256` com HMAC-SHA256 e `WHATSAPP_APP_SECRET`.
- Captura do corpo JSON bruto somente no endpoint do WhatsApp para que a assinatura seja verificada sobre os bytes originais.
- Logs sanitizados: não registram conteúdo da mensagem nem telefone completo do cliente.
- Rate limit reaproveitando o limitador de webhooks já existente.

## Variáveis de ambiente

Nesta etapa:

- `WHATSAPP_VERIFY_TOKEN`: string aleatória escolhida pelo operador. O mesmo valor deve ser informado no painel da Meta em **Verificar token**.
- `WHATSAPP_APP_SECRET`: segredo do app Meta, obtido em **Configurações do app > Básico > Chave secreta do app**. Não deve ser enviado por chat nem salvo no repositório.

A ausência dessas variáveis não impede o servidor de iniciar, mas a rota correspondente responde `503` até ser configurada.

## Callback

Para o domínio atual do ComandaFacil:

`https://comandafacilservice.com.br/webhook/whatsapp`

## Próxima etapa

Depois de a Meta validar o callback, assinar o campo `messages` e testar a entrega de webhooks. O envio automático e o vínculo multi-tenant por `phone_number_id` devem ser adicionados em etapa posterior, quando o número de produção ou Embedded Signup estiver configurado.
