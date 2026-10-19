import { useRef, useState, type JSX } from 'react';
import { disableRpg, enableRpg, type RpgState } from './rpgMode';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  async function pick(file: File | undefined): Promise<void> {
    if (file && !file.type.startsWith('image/')) setError('Escolha um arquivo de imagem.');
    else if (file) await run(() => enableRpg(tokenServer, code, hostKey, file));
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
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => void pick(event.target.files?.[0])}
      />
      <div className="rpg-actions">
        <button
          type="button"
          className={`btn btn-block ${rpg.active ? '' : 'btn-primary'}`}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Enviando…' : rpg.active ? 'Trocar imagem' : 'Ativar modo RPG'}
        </button>
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
