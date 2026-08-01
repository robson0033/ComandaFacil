# Mercado Pago em produção

## Variáveis obrigatórias

- `APP_URL=https://seu-dominio` sem barra final.
- `MP_REDIRECT_URI=https://seu-dominio/admin/mercado-pago/callback` exatamente igual à URL cadastrada no Mercado Pago.
- `MP_CLIENT_ID` e `MP_CLIENT_SECRET` da aplicação OAuth da plataforma.
- `MERCADO_PAGO_ACCESS_TOKEN`, `MERCADO_PAGO_PUBLIC_KEY` e `MERCADO_PAGO_PLATFORM_USER_ID` da conta da plataforma usada para cobrar a assinatura do Comanda Fácil.
- `MERCADO_PAGO_WEBHOOK_SECRET` da aplicação.
- `TOKEN_ENCRYPTION_KEY` aleatória, longa e exclusiva para criptografar tokens OAuth das lojas.

Não use a credencial de uma loja como credencial da plataforma. Não copie tokens entre ambientes.

## Separação financeira

- A assinatura do Comanda Fácil é criada com a credencial da plataforma e validada contra `MERCADO_PAGO_PLATFORM_USER_ID`.
- O Pix de um pedido é criado somente com o token OAuth criptografado da loja identificada pelo slug e pelo `estabelecimentoId`.
- Antes de persistir a cobrança do pedido, o sistema confirma `collector_id`, valor e `external_reference`.
- No webhook, o recurso é consultado novamente na API do Mercado Pago e validado contra o pedido/assinatura e o estabelecimento esperado.

## OAuth

O fluxo utiliza `state` de uso único, expiração, vínculo com a sessão e a loja, além de PKCE S256. O callback confirma a identidade retornada por `/users/me` antes de armazenar os tokens, que ficam criptografados com AES-256-GCM.

## Homologação mínima

1. Conecte duas lojas de teste a duas contas Mercado Pago diferentes.
2. Gere um Pix em cada loja.
3. Confirme no Mercado Pago que cada cobrança tem o `collector_id` da conta correta.
4. Pague somente uma cobrança e confirme que apenas o pedido correspondente muda para pago.
5. Repita o webhook e confirme idempotência.
6. Tente usar token de pedido de uma loja no slug da outra e confirme resposta 404.
