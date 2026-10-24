// Página aberta pelo botão do bot no Discord: botões de link só aceitam http(s), então ela
// repassa para o protocolo partilhartela:// e oferece o download (e o navegador, se configurado).

const downloadUrl = process.env.DOWNLOAD_URL ?? 'https://github.com/samuelmel/partilhartela/releases/latest';
const webAppUrl = process.env.WEB_APP_URL?.replace(/\/+$/, '');

/** Hash do script inline, para a CSP liberar só ele. */
export const joinPageCsp = (scriptHash: string) => [
  "default-src 'none'",
  `script-src '${scriptHash}'`,
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** `code` já validado (6 caracteres A-Z/0-9) antes de chegar aqui. */
export function renderJoinPage(code: string, exists: boolean): { html: string; script: string } {
  const appLink = `partilhartela://join/${code}`;
  const webLink = webAppUrl ? `${webAppUrl}/?room=${code}` : undefined;
  const script = exists ? `window.location.href = ${JSON.stringify(appLink)};` : '';
  const body = exists
    ? `<h1>Abrindo a sala ${escapeHtml(code)}…</h1>
      <p>Se o PartilharTela estiver instalado, ele abre sozinho e entra na sala.</p>
      <a class="btn primary" href="${escapeHtml(appLink)}">Abrir no app</a>
      ${webLink ? `<a class="btn" href="${escapeHtml(webLink)}">Assistir no navegador</a>` : ''}
      <p class="muted">Não tem o app? <a href="${escapeHtml(downloadUrl)}">Baixe o PartilharTela para Windows</a>, instale e clique de novo no botão do Discord.</p>`
    : `<h1>Sala encerrada</h1>
      <p>Esta sala não existe mais. Entre no canal de voz de novo para o bot criar outra.</p>
      <p class="muted"><a href="${escapeHtml(downloadUrl)}">Baixar o PartilharTela para Windows</a></p>`;

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>PartilharTela · Sala ${escapeHtml(code)}</title>
<style>
  :root { color-scheme: dark; --bg: #1b1c20; --panel: #26272d; --text: #ececf1; --muted: #a3a4ad; --accent: #5d61e8; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  main { width: min(440px, 100%); background: var(--panel); border-radius: 14px; padding: 28px; display: grid; gap: 14px; }
  h1 { margin: 0; font-size: 1.35rem; }
  p { margin: 0; }
  .muted { color: var(--muted); font-size: .92rem; }
  a { color: #9ea1ff; }
  .btn { display: block; text-align: center; padding: 12px 16px; border-radius: 10px; text-decoration: none;
    color: var(--text); background: #33343b; font-weight: 600; }
  .btn.primary { background: var(--accent); color: #fff; }
</style>
</head>
<body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body>
</html>`;
  return { html, script };
}
