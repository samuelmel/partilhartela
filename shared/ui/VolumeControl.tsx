import type { CSSProperties, JSX } from 'react';
import { VolumeIcon, VolumeLowIcon, VolumeOffIcon } from './icons';

export type ListenerLevel = { volume: number; muted: boolean };

const storageKey = 'partilhartela.listenerVolume';

/** Volume que este aparelho usa por padrão para novas transmissões. Só local, nunca enviado. */
export function readStoredVolume(): number {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
  } catch {
    return 1;
  }
}

export function storeVolume(volume: number): void {
  try {
    window.localStorage.setItem(storageKey, String(volume));
  } catch {
    // Armazenamento bloqueado: a preferência vale só nesta visita.
  }
}

let volumeSupportCache: boolean | undefined;

/** iOS ignora `HTMLMediaElement.volume` (sempre 1); lá só o mute funciona. */
export function canSetElementVolume(): boolean {
  if (volumeSupportCache === undefined) {
    const probe = document.createElement('audio');
    probe.volume = 0.5;
    volumeSupportCache = probe.volume === 0.5;
  }
  return volumeSupportCache;
}

export function VolumeControl({
  name,
  level,
  onChange
}: {
  name: string;
  level: ListenerLevel;
  onChange: (next: ListenerLevel) => void;
}): JSX.Element {
  const percent = Math.round(level.volume * 100);
  const silent = level.muted || percent === 0;
  const Icon = silent ? VolumeOffIcon : percent < 50 ? VolumeLowIcon : VolumeIcon;
  const adjustable = canSetElementVolume();

  return (
    <div className={`volume ${silent ? 'is-silent' : ''}`}>
      <button
        type="button"
        className="icon-btn on-media"
        onClick={() => onChange({ ...level, muted: !level.muted })}
        aria-pressed={level.muted}
        aria-label={level.muted ? `Ouvir ${name} de novo` : `Silenciar ${name} só para você`}
        title={level.muted ? 'Ativar som (só para você)' : 'Silenciar (só para você)'}
      >
        <Icon />
      </button>
      {adjustable ? (
        <>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            style={{ '--fill': `${level.muted ? 0 : percent}%` } as CSSProperties}
            onChange={(event) => onChange({ volume: Number(event.target.value) / 100, muted: false })}
            aria-label={`Volume de ${name}, só para você`}
            aria-valuetext={level.muted ? `${percent}%, silenciado` : `${percent}%`}
          />
          <output className="volume-value" aria-hidden="true">{level.muted ? 'Mudo' : `${percent}%`}</output>
        </>
      ) : (
        <span className="volume-value">Volume pelos botões do aparelho</span>
      )}
    </div>
  );
}
