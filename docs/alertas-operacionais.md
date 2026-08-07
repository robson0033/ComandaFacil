# Alertas operacionais

O item 17 usa um canal externo independente do SMTP da aplicação. Dessa forma,
uma falha de e-mail ainda consegue gerar aviso por webhook.

## Canal

Configure no Render:

```env
ALERT_WEBHOOK_URL=https://endereco-secreto-do-canal
ALERT_SERVICE_NAME=ComandaFacil
ALERT_ENVIRONMENT=production
```

`ALERT_WEBHOOK_URL` aceita:

- webhook do Discord;
- webhook do Slack;
- endpoint HTTPS próprio que aceite JSON.

Para endpoint próprio com autenticação Bearer, use opcionalmente:

```env
ALERT_WEBHOOK_BEARER_TOKEN=segredo-do-endpoint
```

Nunca registre, envie por chat ou faça commit da URL e do token. URLs de webhook
normalmente contêm credenciais no próprio caminho.

## Limites padrão

```env
ALERT_COOLDOWN_MS=900000
ALERT_5XX_THRESHOLD=5
ALERT_5XX_WINDOW_MS=300000
ALERT_QUEUE_STUCK_MS=180000
ALERT_QUEUE_CHECK_INTERVAL_MS=60000
ALERT_WEBHOOK_TIMEOUT_MS=5000
```

Os valores são opcionais. Os padrões acima significam:

- um mesmo incidente não envia novo alerta antes de 15 minutos;
- cinco respostas 5xx iguais em cinco minutos abrem o incidente;
- um trabalho elegível parado por mais de três minutos é considerado preso;
- a fila é conferida a cada minuto;
- o envio ao canal externo expira em cinco segundos.

O monitor não cria, reenvia, conclui ou cancela trabalhos de impressão. Ele
apenas consulta a fila e emite alertas.

## Eventos cobertos

- `http_5xx_threshold`: repetição de respostas HTTP 5xx;
- `readiness_unavailable`: `/ready` respondeu 503;
- `mercado_pago_webhook_failed`: webhook autenticado falhou e respondeu 503;
- `print_queue_stuck`: trabalho elegível ou lease expirado permaneceu preso;
- `print_queue_monitor_failed`: o próprio monitor não conseguiu consultar a fila;
- `email_delivery_failed`: criação do transportador ou envio SMTP falhou.

Webhooks repetidos já processados continuam retornando 200 e não geram alerta.
Assinaturas inválidas continuam registradas como rejeição de segurança, mas não
são enviadas ao canal para evitar que tráfego malicioso cause uma tempestade de
notificações.

E-mails são mostrados apenas de forma mascarada. Senhas, tokens, cookies,
strings MongoDB e cabeçalhos de autorização passam pelo sanitizador antes de
qualquer envio.

## `/ready` precisa também de monitor externo

O alerta interno detecta quando o processo está vivo, mas algum requisito de
prontidão falhou. Ele não consegue avisar quando o processo inteiro ou a rede
estão fora do ar.

Configure também um monitor externo para consultar:

```text
https://comandafacil-2kot.onrender.com/ready
```

Configuração recomendada:

- método `GET`;
- resposta esperada `200`;
- intervalo de um minuto;
- abrir incidente após duas ou três falhas consecutivas;
- enviar aviso de recuperação quando voltar a `200`.

O monitor externo deve usar o mesmo canal operacional ou outro canal que não
dependa do servidor ComandaFácil.

## Homologação segura do canal

O script abaixo envia eventos sintéticos. Ele não derruba o servidor, não altera
pedidos, não chama o Mercado Pago, não cria PrintJob e não tenta SMTP:

```bash
ALLOW_OPERATIONAL_ALERT_TEST=true \
node scripts/testar-alertas-operacionais.js
```

A URL deve vir do `.env` local ou das variáveis do ambiente; nunca a coloque no
comando. O resultado aprovado termina com:

```text
ALERTAS_ESPERADOS=7
ALERTAS_ENTREGUES=7
FALHAS_DE_ENTREGA=0
SEGREDOS_EXIBIDOS=NAO
CANAL_ALERTA_OK=SIM
```

Depois, confirme visualmente no canal os cinco alertas e as duas recuperações.

## Critério de aprovação do item 17

```text
CANAL_EXTERNO_CONFIGURADO=SIM
ERRO_5XX_DETECTADO=SIM
READY_INTERNO_DETECTADO=SIM
READY_EXTERNO_MONITORADO=SIM
FALHA_WEBHOOK_DETECTADA=SIM
FILA_PRESA_DETECTADA=SIM
FALHA_EMAIL_DETECTADA=SIM
RECUPERACOES_ENVIADAS=SIM
SEGREDOS_NAO_EXPOSTOS=SIM
ITEM_17_OK=SIM
```
