/**
 * @streamp2p/shared
 *
 * Ponto de entrada para consumo em Node (main process / testes).
 * No renderer use os arquivos em src/ diretamente via <script>.
 */
'use strict';

const quality = require('./quality');
const signaling = require('./signaling');
const utils = require('./utils');
const processScan = require('./process-scan');

module.exports = {
  Quality: quality,
  Signaling: signaling,
  Utils: utils,
  ProcessScan: processScan
};