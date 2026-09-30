/**
 * @streamp2p/shared
 *
 * Ponto de entrada para consumo em Node (main process / testes).
 * No renderer use os arquivos em src/ diretamente via <script>.
 */
'use strict';

const quality = require('./src/quality');
const signaling = require('./src/signaling');
const utils = require('./src/utils');
const processScan = require('./src/process-scan');

module.exports = {
  Quality: quality,
  Signaling: signaling,
  Utils: utils,
  ProcessScan: processScan
};