# Checklist de build Windows do agente

Versão: `1.2.0`  
Protocolo mínimo: `2`  
Servidor mínimo: versão que negocia protocolo `2`  
Agente mínimo aceito pelo servidor: `1.2.0`

## Pré-build

- usar Windows x64 e Node compatível com o projeto;
- partir de `package-lock.json` revisado e executar `npm ci`;
- executar `npm test` e a homologação exclusivamente simulada;
- confirmar `contextIsolation: true`, `nodeIntegration: false` e `sandbox: true`;
- confirmar que `main.js`, `preload.js`, `printSecurity.js`,
  `printProtocol.js`, `jobStateStore.js`, `agentJobEngine.js`, `index.html` e
  assets estão em `build.files`;
- confirmar que `dist` não contém artefatos reaproveitados de versão anterior;
- não incluir tokens, configurações locais ou histórico de jobs.

## electron-builder

- `productName`: Comanda Fácil - Agente de Impressão;
- NSIS assistido (`oneClick: false`);
- instalação por usuário (`perMachine: false`);
- diretório selecionável, atalhos de desktop e menu iniciar;
- dados do usuário preservados na desinstalação;
- ícone `assets/icon.ico`;
- artefato esperado:
  `dist/ComandaFacil-Agente-Instalador-1.2.0.exe`.

Build, somente no Windows:

```powershell
npm run dist
```

Após o build:

```powershell
npx asar list .\dist\win-unpacked\resources\app.asar
Get-FileHash .\dist\ComandaFacil-Agente-Instalador-1.2.0.exe -Algorithm SHA256
```

Registrar o SHA-256 no Release e testar instalação, atualização, atalhos,
inicialização automática, desinstalação e reconexão em uma máquina Windows de
homologação. Não publicar Release até concluir testes USB e TCP 9100 reais.
