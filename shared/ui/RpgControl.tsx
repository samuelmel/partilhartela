import { useEffect, useRef, useState, type JSX } from 'react';
import { disableRpg, enableRpg, loadLastRpgImage, type RpgState } from './rpgMode';

/** Painel do criador da sala: escolhe a imagem e liga/desliga o modo RPG para todos. */
export function RpgControl({
  tokenServer,
  code,
  hostKey,
  rpg
}: {
  tokenServer: string;
  code: string;
  hostKey: string;
  rpg: RpgState;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  // Última imagem usada: dá para reativar o modo sem abrir o seletor de arquivos.
  const lastImageRef = useRef<Blob>();
  const previewUrlRef = useRef<string>();
  const [lastPreview, setLastPreview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function remember(image: Blob | undefined): void {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = image ? URL.createObjectURL(image) : undefined;
    setLastPreview(previewUrlRef.current);
  }

  useEffect(() => {
    let cancelled = false;
    void loadLastRpgImage().then((image) => {
      if (cancelled || !image || lastImageRef.current) return;
      lastImageRef.current = image;
      remember(image);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = undefined;
    },
    []
  );

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível mudar o modo RPG.');
    } finally {
      setBusy(false);
    }
  }

  async function apply(image: Blob): Promise<void> {
    await run(async () => {
      lastImageRef.current = await enableRpg(tokenServer, code, hostKey, image);
      remember(lastImageRef.current);
    });
  }

  async function pick(file: File | undefined): Promise<void> {
    if (file && !file.type.startsWith('image/')) setError('Escolha um arquivo de imagem.');
    else if (file) await apply(file);
    // Só limpa depois de enviar: escolher a mesma imagem de novo volta a disparar o onChange.
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <section className="rpg-control" aria-label="Modo RPG">
      <h2 className="side-group">Modo RPG {rpg.active && <span className="rpg-on">Ligado</span>}</h2>
      <p className="side-empty">
        {rpg.active
          ? 'Quem assiste só ouve a transmissão e vê a imagem abaixo, sem spoiler.'
          : 'Esconde a tela de quem assiste: fica só o áudio e uma imagem que você escolher.'}
      </p>
      {rpg.active && rpg.imageUrl && <img className="rpg-thumb" src={rpg.imageUrl} alt="Imagem do modo RPG" />}
      {!rpg.active && lastPreview && (
        <figure className="rpg-last">
          <img className="rpg-thumb" src={lastPreview} alt="Última imagem usada no modo RPG" />
          <figcaption className="side-note">Última imagem usada</figcaption>
        </figure>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => void pick(event.target.files?.[0])}
      />
      <div className="rpg-actions">
        {rpg.active ? (
          <button type="button" className="btn btn-block" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? 'Enviando…' : 'Trocar imagem'}
          </button>
        ) : lastPreview ? (
          <>
            <button
              type="button"
              className="btn btn-block btn-primary"
              disabled={busy}
              onClick={() => {
                const image = lastImageRef.current;
                if (image) void apply(image);
              }}
            >
              {busy ? 'Enviando…' : 'Usar última imagem'}
            </button>
            <button type="button" className="btn btn-block" disabled={busy} onClick={() => inputRef.current?.click()}>
              Escolher outra imagem
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-block btn-primary"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? 'Enviando…' : 'Ativar modo RPG'}
          </button>
        )}
        {rpg.active && (
          <button type="button" className="btn btn-block" disabled={busy} onClick={() => void run(() => disableRpg(tokenServer, code, hostKey))}>
            Desativar modo RPG
          </button>
        )}
      </div>
      {error && <p className="side-note is-error" role="alert">{error}</p>}
    </section>
  );
}
