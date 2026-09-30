/**
 * Copia packages/shared/src para apps/*\/js\/shared.
 *
 * O renderer nao usa bundler (scripts via <script src>), entao o pacote
 * compartilhado precisa estar fisicamente dentro de cada app. Este script
 * evita divergencia entre a fonte canonica e as copias.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'packages', 'shared', 'src');
const TARGETS = [
  path.join(ROOT, 'apps', 'desktop', 'js', 'shared'),
  path.join(ROOT, 'apps', 'web', 'js', 'shared')
];

// process-scan.js so e usado pelo processo main (usa node:child_process),
// portanto nao e copiado para os renderers.
const RENDERER_FILES = ['quality.js', 'signaling.js', 'utils.js'];

function copyTo(targets, files, sourceDir) {
  const copied = [];

  targets.forEach((targetDir) => {
    fs.mkdirSync(targetDir, { recursive: true });

    files.forEach((file) => {
      const from = path.join(sourceDir, file);
      const to = path.join(targetDir, file);

      if (!fs.existsSync(from)) {
        throw new Error('Arquivo ausente em packages/shared/src: ' + file);
      }

      const source = fs.readFileSync(from, 'utf8');
      let changed = true;

      if (fs.existsSync(to)) {
        changed = fs.readFileSync(to, 'utf8') !== source;
      }

      if (changed) {
        fs.writeFileSync(to, source, 'utf8');
        copied.push(path.relative(ROOT, to));
      }
    });
  });

  return copied;
}

function main() {
  const copied = copyTo(TARGETS, RENDERER_FILES, SRC_DIR);

  if (copied.length === 0) {
    console.log('sync:shared - nada a fazer (copias atualizadas)');
  } else {
    console.log('sync:shared - atualizados:');
    copied.forEach((file) => console.log('  ' + file));
  }
}

if (require.main === module) {
  main();
}

module.exports = { copyTo, RENDERER_FILES, SRC_DIR, TARGETS };