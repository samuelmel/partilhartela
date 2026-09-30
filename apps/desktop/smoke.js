/**
 * Smoke test: exercita os mesmos requires que o main process faz,
 * para validar que os caminhos e os modulos resolvem de verdade.
 *
 * Executar a partir de apps/desktop (usa caminhos relativos reais).
 */
'use strict';

const assert = require('node:assert');

let failures = 0;
function check(label, fn) {
  try {
    const value = fn();
    console.log('[OK  ] ' + label + (value !== undefined ? ' -> ' + value : ''));
  } catch (err) {
    failures++;
    console.log('[FAIL] ' + label + ' -> ' + err.message);
  }
}

async function main() {
  console.log('\n=== Smoke test: main process ===\n');

  const { getDiscordPids, EXCLUDED_PROCESSES } =
    require('../../packages/shared/src/process-scan');
  check('process-scan carrega', () => EXCLUDED_PROCESSES.join(','));

  const shared = require('../../packages/shared/src/index.js');
  check('shared exporta 4 modulos', () => {
    assert.deepStrictEqual(
      Object.keys(shared).sort(),
      ['ProcessScan', 'Quality', 'Signaling', 'Utils']
    );
    return Object.keys(shared).join(',');
  });

  check('quality default coerente', () => {
    const q = shared.Quality.DEFAULT_QUALITY;
    assert.strictEqual(q.height, 1080);
    assert.strictEqual(q.width, 1920);
    assert.strictEqual(q.fps, 60);
    return shared.Quality.labelFor('jogo');
  });

  check('fromModalValues 2160 -> 3840', () => {
    const r = shared.Quality.fromModalValues('2160', '30', '10000000', 'detail');
    assert.strictEqual(r.width, 3840);
    assert.strictEqual(r.height, 2160);
    return r.width + 'x' + r.height + '@' + r.fps;
  });

  check('generateRoomId tem 8 chars', () => {
    const id = shared.Signaling.generateRoomId();
    assert.strictEqual(id.length, 8);
    return id;
  });

  check('buildShareUrl', () => {
    const url = shared.Signaling.buildShareUrl('https://ex.com/', 'abc123');
    assert.strictEqual(url, 'https://ex.com/index.html?sala=abc123');
    return url;
  });

  check('parseRoomCode de URL', () => {
    const code = shared.Signaling.parseRoomCode(
      'https://ex.com/index.html?sala=xyz789&x=1'
    );
    assert.strictEqual(code, 'xyz789');
    return code;
  });

  check('parseRoomCode sanitiza codigo solto', () => {
    const code = shared.Signaling.parseRoomCode('  MEU-CODIGO_1! ');
    assert.strictEqual(code, 'MEU-CODIGO_1');
    return code;
  });

  check('parseRoomCode rejeita URL sem sala', () => {
    const code = shared.Signaling.parseRoomCode('https://ex.com/index.html');
    assert.strictEqual(code, '');
    return '(vazio, correto)';
  });

  check('stopAllTracks tolera null', () => {
    shared.Utils.stopAllTracks(null);
    shared.Utils.stopAllTracks(undefined);
    return 'ok';
  });

  check('detectBrowser', () => {
    const b = shared.Utils.detectBrowser('Mozilla/5.0 Gecko/20100101 Firefox/130.0');
    assert.strictEqual(b.isFirefox, true);
    const c = shared.Utils.detectBrowser(
      'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36'
    );
    assert.strictEqual(c.isChrome, true);
    return 'firefox+chrome ok';
  });

  // --- com Promise real (await) ---
  const timeoutResult = await shared.Utils
    .withTimeout(new Promise(() => {}), 50, 'teste')
    .then(() => 'NAO REJEITOU')
    .catch((err) => 'rejeitou: ' + err.message);
  if (timeoutResult.startsWith('rejeitou')) {
    console.log('[OK  ] withTimeout rejeita no prazo -> ' + timeoutResult);
  } else {
    failures++;
    console.log('[FAIL] withTimeout -> ' + timeoutResult);
  }

  // --- addon nativo ---
  const native = require('../../packages/native-audio');
  console.log('\n--- native-audio ---');
  console.log('available:', native.available);
  console.log('status:', JSON.stringify(native.getStatus()));

  const start = native.startAudioCapture([1, 2, 3], () => {}, () => {});
  console.log('startAudioCapture sem binario:', JSON.stringify(start));
  if (start.ok === false && typeof start.error === 'string' && start.error.length > 0) {
    console.log('[OK  ] fallback graceful: retornou ok=false com motivo');
  } else {
    failures++;
    console.log('[FAIL] fallback nao se comportou como esperado');
  }

  check('stopAudioCapture seguro sem binario', () => {
    const r = native.stopAudioCapture();
    assert.strictEqual(r, false);
    return 'false (sem binario)';
  });

  check('getAudioFormat tem padrao saneavel', () => {
    const f = native.getAudioFormat();
    assert.strictEqual(f.bitsPerSample, 16);
    assert.ok(f.sampleRate > 0);
    return f.sampleRate + 'Hz/' + f.channels + 'ch';
  });

  // --- PIDs reais do Discord ---
  const pids = await getDiscordPids();
  console.log('\nDiscord:', JSON.stringify(pids));
  if (Array.isArray(pids.pids)) {
    console.log('[OK  ] getDiscordPids retornou array de PIDs');
  } else {
    failures++;
    console.log('[FAIL] getDiscordPids nao retornou array');
  }

  console.log('\n' + (failures === 0 ? 'SMOKE TEST: TUDO OK' : failures + ' FALHA(S)'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Erro fatal no smoke test:', err);
  process.exit(1);
});