/**
 * Valida a sintaxe de todos os scripts do projeto.
 *
 * Usa node --check para arquivos CommonJS (Node/Electron) e vm.Script para os
 * arquivos do renderer (que rodam no browser sem modulo). Erros de encoding
 * (mojibake) e referencias a simbolos de outro idioma tambem sao reportados.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const DIRS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', '.git', 'out']);
const SKIP_FILES = new Set([]);

const results = [];
let failures = 0;

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }

  entries.forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) return;
      walk(full, out);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) return;
      out.push(full);
    }
  });

  return out;
}

/** Scripts que rodam no Node (podem usar require/module). */
const NODE_FILES = new Set([
  'apps/desktop/main.js',
  'apps/desktop/preload.js',
  'packages/native-audio/index.js',
  'packages/shared/src/index.js',
  'scripts/build-web-html.js',
  'scripts/check-syntax.js',
  'scripts/serve.js',
  'scripts/sync-shared.js'
]);

/** Renderer: valida como script de browser (sem escopo de modulo). */
const RENDERER_PREFIXES = ['apps/desktop/js/', 'apps/web/js/'];

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function checkEncoding(file, source) {
  const problems = [];
  // Heuristica de mojibake: "Ã§", "Ã£", "â€" etc.
  if (/Ã[\s\u0080-\u00bf]/.test(source) && !/TRANSMISS/.test(source)) {
    problems.push('possivel mojibake (encoding UTF-8 corrompido)');
  }
  if (/â€/.test(source)) {
    problems.push('possivel mojibake (UTF-8 lido como Windows-1252)');
  }
  return problems;
}

/**
 * Palavras nao-portuguesas que indicam texto esquecido sem acento.
 * 'selected' NAO entra: e o atributo HTML dos <option>.
 * CJK e cirilico sao indicadores fiables de texto colado de outra fonte.
 */
function checkSuspiciousWords(file, source) {
  const problems = [];
  const suspicious = [
    /\b(wanting)\b/,
    /[一-鿿]/,
    /[а-яА-Я]/
  ];
  suspicious.forEach((re) => {
    if (re.test(source)) {
      problems.push('texto suspeito (idioma errado / caractere CJK ou cirilico)');
    }
  });
  return problems;
}

/** URLs absolutas (CDN) nao existem localmente. */
function isExternal(href) {
  return /^(https?:)?\/\//i.test(href) || /^(data|mailto):/i.test(href);
}

/**
 * GUARDA: getUserMedia com audio de desktop e video:false derruba o renderer
 * do Electron (bad_message.cc, reason 263). Ver README secao 8 e o teste C de
 * `npm run probe:capture`.
 *
 * Procura o padrao em codigo real, ignorando comentarios e strings.
 */
function checkDesktopAudioOnly(source, relative) {
  const problems = [];

  // Remove comentarios de bloco e de linha para nao acusar a documentacao.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

  // audio de desktop + video ausente ou false, dentro de um getUserMedia.
  const suspicious = /getUserMedia\s*\(\s*\{[\s\S]{0,400}?audio\s*:\s*\{[\s\S]{0,300}?chromeMediaSource\s*:\s*'desktop'[\s\S]{0,400}?\}\s*,\s*video\s*:\s*false/g;

  let match;
  while ((match = suspicious.exec(code)) !== null) {
    const line = code.slice(0, match.index).split('\n').length;
    problems.push(
      'getUserMedia com audio de desktop e video:false (linha ' + line +
      ') derruba o renderer. Peca audio e video juntos.'
    );
  }

  return problems;
}

function checkFile(file) {
  const relative = rel(file);
  const source = fs.readFileSync(file, 'utf8');
  const problems = [];

  // 1. Sintaxe
  try {
    if (NODE_FILES.has(relative)) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } else if (RENDERER_PREFIXES.some((p) => relative.startsWith(p))) {
      // vm.Script nao aceita 'use strict' com declaracao de variavel em
      // posicao invalida, mas os arquivos do renderer sao scripts simples.
      new vm.Script(source, { filename: relative });
    } else {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
  } catch (err) {
    const msg = (err.stderr ? err.stderr.toString() : err.message)
      .split('\n')
      .filter((l) => l.includes('Error') || l.includes('^'))
      .slice(0, 3)
      .join(' | ');
    problems.push('SINTAXE: ' + msg.trim());
  }

  // 2. Encoding e texto: so faz sentido no que vai para a tela (renderer/UI).
  //    Os arquivos de tooling contem literais de regex que disparariam falso positivo.
  if (RENDERER_PREFIXES.some((p) => relative.startsWith(p))) {
    checkEncoding(file, source).forEach((p) => problems.push(p));
    checkSuspiciousWords(file, source).forEach((p) => problems.push(p));
    checkDesktopAudioOnly(source, relative).forEach((p) => problems.push(p));
  }

  const ok = problems.length === 0;
  if (!ok) failures++;
  results.push({ file: relative, ok, problems });
}

function main() {
  const files = [];
  DIRS.forEach((dir) => walk(path.join(ROOT, dir), files));

  const jsFiles = files.filter((f) => f.endsWith('.js'));
  jsFiles.forEach(checkFile);

  // Valida tambem o HTML: balanceamento basico de <script> e charset.
  const htmlFiles = files.filter((f) => f.endsWith('.html'));
  htmlFiles.forEach((file) => {
    const relative = rel(file);
    const source = fs.readFileSync(file, 'utf8');
    const problems = [];

    const scripts = [...source.matchAll(/<script[^>]*src="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((src) => !isExternal(src));

    scripts.forEach((src) => {
      const localSrc = src.split(/[?#]/, 1)[0];
      const resolved = path.join(path.dirname(file), localSrc);
      if (!fs.existsSync(resolved)) {
        problems.push('script inexistente: ' + src);
      }
    });

    const styles = [...source.matchAll(/<link[^>]*href="([^"]+\.css)"/g)]
      .map((m) => m[1])
      .filter((href) => !isExternal(href));

    styles.forEach((href) => {
      const resolved = path.join(path.dirname(file), href);
      if (!fs.existsSync(resolved)) {
        problems.push('css inexistente: ' + href);
      }
    });

    if (!/charset=["']?utf-8/i.test(source)) {
      problems.push('sem <meta charset="utf-8">');
    }

    // Estrutura de elementos: pega remocoes de bloco que desalinham a arvore.
    const openDivs = (source.match(/<div\b/g) || []).length;
    const closeDivs = (source.match(/<\/div>/g) || []).length;
    if (openDivs !== closeDivs) {
      problems.push('divs desbalanceados: ' + openDivs + ' abertos vs ' +
        closeDivs + ' fechados');
    }

    const openButtons = (source.match(/<button\b/g) || []).length;
    const closeButtons = (source.match(/<\/button>/g) || []).length;
    if (openButtons !== closeButtons) {
      problems.push('buttons desbalanceados: ' + openButtons + ' vs ' + closeButtons);
    }

    checkEncoding(file, source).forEach((p) => problems.push(p));
    checkSuspiciousWords(file, source).forEach((p) => problems.push(p));

    const ok = problems.length === 0;
    if (!ok) failures++;
    results.push({ file: relative, ok, problems });
  });

  // Relatorio
  console.log('\n=== StreamP2P - Validacao de sintaxe ===\n');
  results.forEach((r) => {
    const mark = r.ok ? 'OK  ' : 'FAIL';
    console.log('[' + mark + '] ' + r.file);
    r.problems.forEach((p) => console.log('        -> ' + p));
  });

  const total = results.length;
  console.log('\n' + (total - failures) + '/' + total + ' arquivos OK');

  if (failures > 0) {
    console.error('\n' + failures + ' arquivo(s) com problema.');
    process.exit(1);
  }

  console.log('Tudo certo.');
}

if (require.main === module) {
  main();
}

module.exports = { walk, checkFile, rel };