import { useEffect, useState, type JSX } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { AlertIcon } from '../../../shared/ui/icons';

/**
 * Atualização automática (tauri-plugin-updater): procura uma versão nova ao abrir e oferece instalar.
 * Falhas na busca (sem internet, sem release publicada) ficam só no console: não atrapalham o uso.
 */
export function UpdateBanner(): JSX.Element | null {
  const [update, setUpdate] = useState<Update>();
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number>();
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      check()
        .then((found) => {
          if (!cancelled && found) setUpdate(found);
        })
        .catch((reason) => console.warn('[PartilharTela] Não foi possível procurar atualização:', reason));
    }, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  async function install(): Promise<void> {
    if (!update || busy) return;
    setBusy(true);
    setError('');
    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        if (event.event === 'Progress') {
          received += event.data.chunkLength;
          if (total > 0) setPercent(Math.min(100, Math.round((received / total) * 100)));
        }
      });
      await relaunch();
    } catch (reason) {
      console.warn('[PartilharTela] Falha ao atualizar:', reason);
      setError('Não foi possível instalar a atualização. Tente de novo em instantes.');
      setBusy(false);
    }
  }

  if (!update || dismissed) return null;
  return (
    <div className="update-banner notice" role="status">
      <AlertIcon size={18} />
      <span>
        {error || (busy
          ? `Baixando a versão ${update.version}${percent === undefined ? '…' : ` (${percent}%)`}`
          : `Há uma versão nova do PartilharTela (${update.version}).`)}
      </span>
      {!busy && <button type="button" className="btn btn-primary" onClick={() => void install()}>Atualizar agora</button>}
      {!busy && <button type="button" className="btn btn-quiet" onClick={() => setDismissed(true)}>Depois</button>}
    </div>
  );
}
