/** Clipboard da webview; se a API moderna for bloqueada, cai para o textarea + execCommand. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // WebView sem a Clipboard API: tenta o método antigo.
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(area);
  if (!copied) throw new Error(`Copie manualmente: ${text}`);
}
