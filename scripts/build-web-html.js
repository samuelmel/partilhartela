/**
 * Gera apps/web/index.html a partir de apps/desktop/index.html.
 *
 * O HTML do Desktop e a fonte canonica (unica tela do produto). A versao Web
 * e derivada, removendo o que so existe no Electron:
 *   - modal nativo de selecao de tela (desktopCapturer)
 *   - badge do filtro de audio nativo (addon WASAPI)
 *
 * Feito em Node para preservar o encoding UTF-8.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'apps', 'desktop', 'index.html');
const DEST = path.join(__dirname, '..', 'apps', 'web', 'index.html');

const OLD_SCRIPTS = `    <!-- Application Script Modules (Injected in correct dependency order) -->
    <script src="js/config.js"></script>
    <script src="js/ui.js"></script>
    <script src="js/audio-native.js"></script>
    <script src="js/webrtc.js"></script>
    <script src="js/app.js"></script>`;

const NEW_SCRIPTS = `    <!-- Pacote compartilhado (Host + Receptor) -->
  <script src="js/shared/quality.js?v=20261001-4"></script>
  <script src="js/shared/signaling.js?v=20261001-4"></script>
  <script src="js/shared/utils.js?v=20261001-4"></script>

    <!-- Application Script Modules (Injected in correct dependency order) -->
  <script src="js/config.js?v=20261001-4"></script>
  <script src="js/ui.js?v=20261001-4"></script>
  <script src="js/webrtc.js?v=20261001-4"></script>
  <script src="js/app.js?v=20261001-4"></script>`;

/**
 * Blocos que existem apenas no Desktop.
 *
 * `end` fecha exatamente o bloco: para o badge, apenas a div do proprio badge.
 * Consumir o `</div>` seguinte desalinharia o liveOverlay.
 */
const DESKTOP_ONLY_BLOCKS = [
  {
    label: 'modal nativo do Electron',
    start: '    <!-- ELECTRON NATIVE SCREEN / WINDOW PICKER MODAL -->',
    end: '    <!-- FOOTER -->'
  },
  {
    label: 'badge do filtro de audio nativo',
    start: '\n                    <!-- Filtro de áudio nativo',
    end: '</div>',
    // O badge nao tem divs aninhadas: o primeiro </div> apos ele é o seu.
    nonGreedy: true
  }
];

function buildWebHtml(sourceHtml) {
  let html = sourceHtml;

  if (!html.includes(OLD_SCRIPTS)) {
    throw new Error(
      'Bloco de scripts nao encontrado em ' + SRC +
      '\nEsperado encontrar o bloco com js/audio-native.js. ' +
      'Ajuste NEW_SCRIPTS/OLD_SCRIPTS em build-web-html.js.'
    );
  }
  html = html.replace(OLD_SCRIPTS, NEW_SCRIPTS);

  DESKTOP_ONLY_BLOCKS.forEach((block) => {
    const start = html.indexOf(block.start);
    if (start === -1) {
      console.warn('aviso: bloco nao encontrado (' + block.label + ')');
      return;
    }

    const end = html.indexOf(block.end, start);
    if (end === -1) {
      console.warn('aviso: fim do bloco nao encontrado (' + block.label + ')');
      return;
    }

    html = block.nonGreedy
      ? html.slice(0, start) + html.slice(end + block.end.length)
      : html.slice(0, start) + html.slice(end);
  });

  assertBalancedDivs(html);

  return html;
}

/** Guarda contra remocao que desalinhe a arvore de elementos. */
function assertBalancedDivs(html) {
  const open = (html.match(/<div\b/g) || []).length;
  const close = (html.match(/<\/div>/g) || []).length;

  if (open !== close) {
    throw new Error(
      'HTML gerado com divs desbalanceados: ' + open + ' abertos vs ' +
      close + ' fechados. A remocao de bloco corrompeu a estrutura.'
    );
  }
}

function main() {
  const sourceHtml = fs.readFileSync(SRC, 'utf8');
  const output = buildWebHtml(sourceHtml);
  fs.writeFileSync(DEST, output, 'utf8');
  console.log('apps/web/index.html gerado (' + output.length + ' bytes)');
}

if (require.main === module) {
  main();
}

module.exports = { buildWebHtml, DESKTOP_ONLY_BLOCKS };