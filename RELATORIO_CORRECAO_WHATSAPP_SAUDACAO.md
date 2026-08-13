# Correção — saudação do WhatsApp sem fallback indevido

## Problema
Quando a conversa já existia e o cliente enviava uma saudação como `oi`, o robô enviava primeiro a mensagem de fallback (ex.: "Não consegui identificar essa opção") e só depois o menu.

## Correção
A automação agora reconhece saudações/comandos de início antes de procurar opções ou aplicar fallback. Esses textos reabrem diretamente o menu:

- oi / olá / opa / e aí / eae
- bom dia / boa tarde / boa noite
- menu
- início / iniciar
- começar / começar atendimento
- ajuda

Saudações com texto adicional, como `Oi, gostaria de fazer um pedido`, também abrem o menu diretamente.

Mensagens realmente desconhecidas continuam usando a mensagem de fallback quando a conversa já existia. Respostas interativas dos botões/listas continuam sendo processadas pelas respectivas opções.

## Arquivos alterados
- `src/services/whatsappAutomationService.js`
- `test/whatsappAutomationP0.test.js`

## Validações executadas
- `node scripts/check-syntax.js`: 159 arquivos JavaScript aprovados.
- Teste isolado da detecção: 10 saudações, 3 não-saudações e resposta interativa preservada.

## Teste manual após deploy
1. Envie `oi` ao WhatsApp da loja.
2. O sistema deve responder diretamente com boas-vindas + menu, sem mensagem de fallback.
3. Depois envie um texto desconhecido, como `xyzxyz`.
4. Como a conversa já existe, deve aparecer o fallback + menu.
