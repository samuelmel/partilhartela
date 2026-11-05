// Publica um release do app Tauri no GitHub com tudo que os dois updaters precisam:
//   latest.json  -> Tauri (tauri-plugin-updater)
//   latest.yml   -> Electron (electron-updater); copiado do release Latest atual para nunca faltar
// Uso (na raiz, depois de `tauri build` e de assinar o instalador):  node scripts/release-tauri.mjs [--dry]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = 'samuelmel/partilhartela';
const dry = process.argv.includes('--dry');
const conf = JSON.parse(readFileSync('apps/desktop-tauri/src-tauri/tauri.conf.json', 'utf8'));
const version = conf.version;
const nsisDir = process.env.TAURI_NSIS_DIR ?? 'C:/pt-target/release/bundle/nsis';
const installer = `PartilharTela_${version}_x64-setup.exe`;

for (const file of [installer, `${installer}.sig`]) {
  if (!existsSync(path.join(nsisDir, file))) {
    throw new Error(`Falta ${path.join(nsisDir, file)}. Rode o build e assine o instalador (tauri signer sign).`);
  }
}

const work = path.join(tmpdir(), `partilhartela-release-${version}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
copyFileSync(path.join(nsisDir, installer), path.join(work, installer));
copyFileSync(path.join(nsisDir, `${installer}.sig`), path.join(work, `${installer}.sig`));

writeFileSync(path.join(work, 'latest.json'), JSON.stringify({
  version,
  notes: process.env.RELEASE_NOTES ?? `PartilharTela ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(path.join(nsisDir, `${installer}.sig`), 'utf8').trim(),
      url: `https://github.com/${repo}/releases/download/v${version}/${installer}`
    }
  }
}, null, 2));

// O Electron lê o latest.yml do release Latest: se o novo release não tiver um, ele para de achar atualização.
const response = await fetch(`https://github.com/${repo}/releases/latest/download/latest.yml`);
if (!response.ok) throw new Error(`Não consegui baixar o latest.yml do release atual (HTTP ${response.status}).`);
writeFileSync(path.join(work, 'latest.yml'), await response.text());

const assets = [installer, `${installer}.sig`, 'latest.json', 'latest.yml'].map((name) => path.join(work, name));
console.log(`Release v${version} com: ${assets.map((a) => path.basename(a)).join(', ')}`);
if (dry) {
  console.log(`--dry: nada foi publicado. Arquivos em ${work}`);
} else {
  execFileSync('gh', [
    'release', 'create', `v${version}`, '--repo', repo, '--target', 'master', '--latest',
    '--title', `PartilharTela ${version}`, '--notes', process.env.RELEASE_NOTES ?? `PartilharTela ${version}`, ...assets
  ], { stdio: 'inherit' });
}
