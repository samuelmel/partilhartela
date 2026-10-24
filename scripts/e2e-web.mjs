// E2E da web via Chrome DevTools Protocol: apresentador web + 2 espectadores + celular.
// Pré-requisitos: `npm run dev:server` (com LiveKit configurado) e
// `VITE_TOKEN_SERVER_URL=http://localhost:8787 npm run dev:web` rodando.
// Uso: node scripts/e2e-web.mjs [pasta-de-saida] [url-da-web]
// Chrome: CHROME_PATH (padrão: instalação do Windows). Usa --use-fake-ui-for-media-stream,
// então getDisplayMedia é aceito sozinho e publica uma tela/bipe sintéticos.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OUT = process.argv[2] ?? path.join(tmpdir(), 'partilhartela-e2e');
const BASE = process.argv[3] ?? 'http://localhost:5174/';
mkdirSync(OUT, { recursive: true });
const port = 9333;
const chrome = spawn(process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pt-e2e-'))}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--auto-select-desktop-capture-source=Entire screen', '--window-size=1366,860', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };

async function waitHttp() {
  for (let i = 0; i < 50; i++) { try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
  throw new Error('chrome não subiu');
}

async function openPage(name, { width = 1366, height = 860, mobile = false, ua } = {}) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') logs.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (msg.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  if (ua) await send('Emulation.setUserAgentOverride', { userAgent: ua });
  const p = {
    name, logs, send,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false });
      if (r.exceptionDetails) throw new Error(`${name} eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
    async front() { await send('Page.bringToFront'); await sleep(300); },
    async goto(url) { await send('Page.navigate', { url }); await sleep(1500); },
    async shot(file) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64')); },
    async waitFor(expr, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await p.eval(`!!(${expr})`)) return true; } catch {} await sleep(250); } return false; },
    // clique real (gera ativação de usuário, exigida por getDisplayMedia e Fullscreen)
    async click(selectorExpr) {
      const box = await p.eval(`(() => { const el = ${selectorExpr}; if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!box) throw new Error(`${name}: elemento não encontrado ${selectorExpr}`);
      await send('Page.bringToFront');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    },
    async key(key, code, keyCode) { await send('Page.bringToFront'); for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode }); },
    async type(selector, text) { await p.click(`document.querySelector('${selector}')`); await p.eval(`document.querySelector('${selector}').select?.()`); await send('Input.insertText', { text }); }
  };
  (globalThis.__pages ??= []).push(p);
  return p;
}

const btn = (text) => `[...document.querySelectorAll('button')].find(b => b.textContent.trim().includes(${JSON.stringify(text)}))`;
// RMS do áudio que chega no <audio> do espectador (o fake device toca um bipe contínuo).
const rmsExpr = `(async () => {
  const a = document.querySelector('.audio-sink audio'); if (!a || !a.srcObject) return -1;
  const ctx = new AudioContext(); await ctx.resume();
  const src = ctx.createMediaStreamSource(a.srcObject); const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
  const buf = new Float32Array(an.fftSize); let max = 0;
  for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 100)); an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; max = Math.max(max, Math.sqrt(s / buf.length)); }
  await ctx.close(); return max; })()`;

try {
  await waitHttp();

  // ---------- Apresentador web
  const A = await openPage('A');
  await A.goto(BASE);
  await A.waitFor(`document.querySelector('#nickname')`);
  await A.eval(`localStorage.clear()`); await A.goto(BASE);
  await A.shot('01-web-home-desktop.png');
  await A.click(btn('Compartilhar tela'));
  check('apelido obrigatório', await A.waitFor(`document.body.innerText.includes('Escolha um apelido')`, 3000));
  await A.type('#nickname', 'Ana');
  await A.click(btn('Compartilhar tela'));
  const inRoom = await A.waitFor(`document.querySelector('.room-shell') && document.querySelector('.conn-ok')`, 20000);
  check('web cria sala e conecta', inRoom, await A.eval(`location.search`));
  const code = await A.eval(`new URLSearchParams(location.search).get('room')`);
  check('código de 6 chars sem 0/O/1/I', /^[A-HJ-NP-Z2-9]{6}$/.test(code ?? ''), code);
  await A.shot('02-web-room-empty.png');

  await A.click(btn('Compartilhar minha tela'));
  const sharing = await A.waitFor(`document.body.innerText.includes('Você está transmitindo')`, 20000);
  check('web publica tela (getDisplayMedia + LiveKit)', sharing, (await A.eval(`document.querySelector('.dock-state')?.innerText`)) ?? '');
  check('prévia local exibida', await A.waitFor(`document.querySelector('.viewport video')?.videoWidth > 0`, 8000));
  await A.shot('03-web-presenter-sharing.png');

  // ---------- Espectador B (convite ?room=)
  const B = await openPage('B');
  await B.goto(`${BASE}?room=${code}`);
  await B.waitFor(`document.querySelector('#nickname')`);
  await B.shot('04-web-invite.png');
  await B.type('#nickname', 'Bruno');
  await B.click(btn('Entrar na sala'));
  check('espectador entra pelo link', await B.waitFor(`document.querySelector('.room-shell')`, 20000));
  const videoB = await B.waitFor(`document.querySelector('.viewport video')?.videoWidth > 0`, 25000);
  check('espectador web recebe a tela', videoB, String(await B.eval(`document.querySelector('.viewport video')?.videoWidth + 'x' + document.querySelector('.viewport video')?.videoHeight`)));
  const hasAudioB = await B.waitFor(`document.querySelector('.audio-sink audio')`, 10000);
  check('espectador recebe faixa ScreenShareAudio', hasAudioB);
  check('lista mostra Ana ao vivo', await B.eval(`document.querySelector('.side')?.innerText.includes('Ana') && document.querySelector('.member-live') !== null`));
  await sleep(1500);
  await B.shot('05-web-viewer-desktop.png');

  // ---------- Espectador C (outro navegador/aba)
  const C = await openPage('C');
  await C.goto(`${BASE}?room=${code}`);
  await C.waitFor(`document.querySelector('#nickname')`);
  await C.type('#nickname', 'Carla');
  await C.click(btn('Entrar na sala'));
  check('segundo espectador recebe a tela', await C.waitFor(`document.querySelector('.viewport video')?.videoWidth > 0`, 25000));
  await C.waitFor(`document.querySelector('.audio-sink audio')`, 10000);

  // ---------- Volume local
  const setVol = (p, v) => p.eval(`(() => { const s = document.querySelector('.volume input[type=range]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(s, '${v}'); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  for (const v of [0, 25, 50, 100]) {
    await setVol(B, v); await sleep(150);
    const got = await B.eval(`document.querySelector('.audio-sink audio').volume`);
    const label = await B.eval(`document.querySelector('.volume-value').textContent`);
    check(`volume ${v}% aplicado só no elemento local`, Math.abs(got - v / 100) < 0.001 && label === `${v}%`, `volume=${got} rótulo=${label}`);
  }
  await setVol(B, 25);
  check('volume de B não altera C', (await C.eval(`document.querySelector('.audio-sink audio').volume`)) === 1);
  await B.click(`document.querySelector('.volume .icon-btn')`); await sleep(200);
  check('mute local em B', await B.eval(`document.querySelector('.audio-sink audio').muted && document.querySelector('.volume-value').textContent === 'Mudo'`));
  check('mute local de B não muta C', await C.eval(`!document.querySelector('.audio-sink audio').muted`));
  check('mute local de B não muta a publicação', !(await A.eval(`document.querySelector('.dock-state').innerText.includes('mutado')`)));
  check('preferência de volume salva no localStorage deste navegador', (await B.eval(`localStorage.getItem('partilhartela.listenerVolume')`)) === '0.25');
  await B.click(`document.querySelector('.volume .icon-btn')`);

  // ---------- Mute do apresentador (medido pelo sinal que chega em C)
  await C.front();
  const rmsBefore = await C.eval(rmsExpr);
  await A.click(btn('Mutar som'));
  check('apresentador muta som (estado do SDK)', await A.waitFor(`document.body.innerText.includes('som mutado para todos') && document.querySelector('[aria-pressed=true]')`, 5000));
  await sleep(1200);
  const rmsMuted = await C.eval(rmsExpr);
  const videoAlive = await C.eval(`(() => { const v = document.querySelector('.viewport video'); return v.videoWidth > 0 && !v.paused; })()`);
  check('espectadores deixam de ouvir', rmsBefore > 0.005 && rmsMuted < rmsBefore * 0.1, `rms antes=${rmsBefore.toFixed?.(4)} mutado=${rmsMuted.toFixed?.(4)}`);
  check('vídeo segue durante mute', videoAlive);
  await A.shot('06-web-presenter-muted.png');
  await A.click(btn('Ativar som'));
  await C.front(); await sleep(2000);
  const rmsBack = await C.eval(rmsExpr);
  await C.front();
  const frames1 = await C.eval(`document.querySelector('.viewport video').getVideoPlaybackQuality().totalVideoFrames`);
  check('desmutar restaura o som', rmsBack > rmsBefore * 0.5, `rms=${rmsBack.toFixed?.(4)}`);
  for (let i = 0; i < 4; i++) { await A.click(`document.querySelector('.dock-actions .btn:not(.btn-danger)')`); await sleep(400); }
  await C.front(); await sleep(1000);
  const frames2 = await C.eval(`document.querySelector('.viewport video').getVideoPlaybackQuality().totalVideoFrames`);
  check('mute/desmute repetido sem reiniciar vídeo', frames2 > frames1 && (await C.eval(`document.querySelectorAll('.audio-sink audio').length`)) === 1, `frames ${frames1}->${frames2}`);
  check('estado final consistente após cliques pares', !(await A.eval(`document.body.innerText.includes('som mutado')`)));

  // ---------- Fullscreen
  await B.click(`document.querySelector('[aria-label="Tela cheia"]')`);
  const fsOn = await B.waitFor(`document.fullscreenElement === document.querySelector('.viewport')`, 4000);
  check('fullscreen: o viewport entra em tela cheia', fsOn);
  check('fullscreen: ícone/rótulo segue o estado real', await B.waitFor(`document.querySelector('[aria-label="Sair da tela cheia"]')`, 3000));
  await B.shot('07-web-viewer-fullscreen.png');
  await B.click(`document.querySelector('[aria-label="Sair da tela cheia"]')`);
  check('fullscreen: sai pelo botão', await B.waitFor(`!document.fullscreenElement && !!document.querySelector('[aria-label="Tela cheia"]')`, 4000));
  await B.click(`document.querySelector('[aria-label="Tela cheia"]')`);
  await B.waitFor(`document.fullscreenElement`, 4000);
  await B.eval(`document.exitFullscreen()`); // saída externa (equivale a Esc/F11 do navegador)
  check('fullscreen: botão acompanha saída externa (Esc)', await B.waitFor(`!document.fullscreenElement && !!document.querySelector('[aria-label="Tela cheia"]')`, 4000));
  await B.key('f', 'KeyF', 70);
  check('atalho F alterna fullscreen', await B.waitFor(`document.fullscreenElement === document.querySelector('.viewport')`, 4000));
  await B.eval(`document.exitFullscreen()`);
  await A.click(`document.querySelector('[aria-label="Tela cheia"]')`);
  check('fullscreen na prévia local do apresentador', await A.waitFor(`document.fullscreenElement === document.querySelector('.viewport')`, 4000));
  await A.eval(`document.exitFullscreen()`);

  // ---------- Parar pela interface
  await A.click(btn('Parar transmissão'));
  check('parar: apresentador volta ao estado inicial', await A.waitFor(`document.body.innerText.includes('Compartilhar minha tela')`, 8000));
  check('parar: espectadores veem estado vazio', await B.waitFor(`document.body.innerText.includes('Ninguém está transmitindo') && !document.querySelector('.audio-sink audio')`, 10000));
  check('parar: sem tile fantasma em C', await C.waitFor(`!document.querySelector('.viewport video:not([hidden])') && document.querySelectorAll('.member-live').length === 0`, 10000));

  // ---------- Encerramento pelo navegador (evento 'ended' da track, como o botão nativo)
  await A.click(btn('Compartilhar minha tela'));
  await A.waitFor(`document.body.innerText.includes('Você está transmitindo')`, 20000);
  await C.waitFor(`document.querySelector('.viewport video')?.videoWidth > 0`, 20000);
  await A.eval(`document.querySelector('.viewport video').srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended'))`);
  check('encerramento nativo atualiza o apresentador', await A.waitFor(`document.body.innerText.includes('encerrada pelo navegador')`, 8000));
  check('encerramento nativo não deixa áudio órfão', await C.waitFor(`!document.querySelector('.audio-sink audio') && !document.querySelector('.viewport video:not([hidden])')`, 10000));
  await A.shot('08-web-native-stop.png');

  // ---------- Sair da sala durante fullscreen (B)
  await A.click(btn('Compartilhar minha tela'));
  const again = await A.waitFor(`document.body.innerText.includes('Você está transmitindo')`, 20000);
  check('retransmitir após encerramento nativo', again, await A.eval(`document.querySelector('.dock')?.innerText`));
  await B.front();
  check('espectador recebe a nova transmissão', await B.waitFor(`document.querySelector('.viewport video')?.videoWidth > 0`, 20000));
  await B.click(`document.querySelector('[aria-label="Tela cheia"]')`);
  await B.waitFor(`document.fullscreenElement`, 4000);
  await B.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Sair da sala')).click()`);
  // Sair pede confirmação (ConfirmDialog).
  await B.waitFor(`document.querySelector('.confirm .btn-danger')`, 4000);
  await B.eval(`document.querySelector('.confirm .btn-danger').click()`);
  check('sair durante fullscreen volta ao início sem fullscreen', await B.waitFor(`!document.fullscreenElement && document.querySelector('.home') && !location.search.includes('room')`, 6000));
  check('participante some da lista após sair', await A.waitFor(`!document.querySelector('.side').innerText.includes('Bruno')`, 10000));

  // ---------- Erros
  await B.goto(`${BASE}`);
  await B.type('#nickname', 'Bruno');
  await B.type('#room-code', 'ZZZZZZ');
  await B.click(btn('Entrar'));
  check('código inexistente mostra erro', await B.waitFor(`document.body.innerText.includes('inexistente ou expirada')`, 8000));
  await B.shot('09-web-error.png');

  // ---------- Celular (espectador)
  const M = await openPage('M', { width: 390, height: 844, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await M.goto(BASE);
  await M.waitFor(`document.querySelector('#nickname')`);
  check('celular: sem botão de transmitir que não funciona', !(await M.eval(`!!${btn('Compartilhar tela')}`)) && (await M.eval(`document.body.innerText.includes('Celulares e tablets')`)));
  await M.shot('10-mobile-home.png');
  await M.type('#nickname', 'Mia');
  await M.type('#room-code', code);
  await M.click(btn('Entrar'));
  check('celular assiste', await M.waitFor(`document.querySelector('.viewport video')?.videoWidth > 0`, 25000));
  check('celular: dock explica limitação sem botão', !(await M.eval(`!!${btn('Compartilhar minha tela')}`)));
  await sleep(1000);
  await M.shot('11-mobile-room.png');
  await M.click(`document.querySelector('[aria-label="Código da sala e participantes"]')`);
  await sleep(400);
  await M.shot('12-mobile-drawer.png');
  check('sem rolagem horizontal no celular', await M.eval(`document.documentElement.scrollWidth <= 390`));

  // ---------- Limpeza do apresentador
  await A.click(btn('Sair da sala'));
  await A.waitFor(`document.querySelector('.confirm .btn-danger')`, 4000);
  await A.click(`document.querySelector('.confirm .btn-danger')`);
  check('apresentador sai e despublica', await A.waitFor(`document.querySelector('.home')`, 6000));
  check('celular vê sala vazia após apresentador sair', await M.waitFor(`document.body.innerText.includes('Ninguém está transmitindo')`, 10000));

  for (const p of [A, B, C, M]) {
    const bad = p.logs.filter((l) => /EXCEPTION|error/i.test(l) && !/favicon/i.test(l));
    check(`console sem erros (${p.name})`, bad.length === 0, bad.slice(0, 3).join(' | '));
  }
} catch (e) {
  check('execução', false, e.stack);
  for (const p of globalThis.__pages ?? []) console.log(p.name, p.logs.filter(l => !/webrtc stats|signal connecting/.test(l)).slice(-8).join(' || '));
} finally {
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passaram`);
  chrome.kill();
  process.exit(failed > 0 ? 1 : 0);
}
