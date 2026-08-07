const { logger: appLogger } = require("./src/utils/logger");

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

router.get('/downloads/agente', (req, res) => {
  const nomeArquivo = 'ComandaFacil-Agente-Setup.exe';

  const caminhoArquivo = path.resolve(
    __dirname,
    '..',
    '..',
    'downloads',
    nomeArquivo
  );

  if (!fs.existsSync(caminhoArquivo)) {
    return res.status(404).send(
      'O instalador do agente ainda não foi enviado para o servidor.'
    );
  }

  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private'
  );

  return res.download(
    caminhoArquivo,
    nomeArquivo,
    error => {
      if (error && !res.headersSent) {
        appLogger.error(
          'Erro ao baixar o agente:',
          error
        );

        return res.status(500).send(
          'Não foi possível baixar o agente de impressão.'
        );
      }
    }
  );
});

module.exports = router;
