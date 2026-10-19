import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import type { LocalVideoTrack, RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
import type { StreamItem } from './roomState';
import type { RpgState } from './rpgMode';
import { leaveFullscreen, useFullscreen } from './useFullscreen';
import { canSetElementVolume, readStoredVolume, storeVolume, VolumeControl, type ListenerLevel } from './VolumeControl';
import { CollapseIcon, ExpandIcon, VolumeOffIcon } from './icons';

type StageItem = {
  id: string;
  identity: string;
  name: string;
  local: boolean;
  track: RemoteVideoTrack | LocalVideoTrack;
};

const localId = 'local-preview';

/**
 * Palco da sala: uma transmissão em destaque num viewport fixo (é ele que entra em
 * tela cheia, então trocar o destaque não derruba o fullscreen) e as demais numa faixa.
 * O áudio de cada tela toca num <audio> próprio com volume/mute locais deste aparelho.
 * No modo RPG as telas dos outros somem (o vídeo nem é recebido) e o viewport mostra a imagem
 * escolhida pelo criador, com o controle de volume de cada áudio.
 */
export function Stage({
  streams,
  audio,
  local,
  empty,
  overlayExtra,
  rpg,
  names = {}
}: {
  streams: StreamItem[];
  audio: Record<string, RemoteAudioTrack>;
  local?: { track: LocalVideoTrack; name: string };
  empty: ReactNode;
  overlayExtra?: ReactNode;
  rpg?: RpgState;
  /** Nome de cada participante por identity (rótulo do volume no modo RPG). */
  names?: Record<string, string>;
}): JSX.Element {
  const rpgActive = rpg?.active ?? false;
  const items = useMemo<StageItem[]>(() => [
    ...(rpgActive ? [] : streams.map((stream) => ({ ...stream, local: false }))),
    ...(local ? [{ id: localId, identity: localId, name: local.name, local: true, track: local.track }] : [])
  ], [streams, local, rpgActive]);

  const [featuredId, setFeaturedId] = useState<string>();
  const featured = items.find((item) => item.id === featuredId) ?? items[0];

  const viewportRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fullscreen = useFullscreen(viewportRef, videoRef);
  const hasMediaRef = useRef(false);
  const showRpg = rpgActive && !featured;
  hasMediaRef.current = Boolean(featured) || showRpg;

  const [levels, setLevels] = useState<Record<string, ListenerLevel>>({});
  const defaultVolume = useRef(readStoredVolume());
  const levelOf = (identity: string): ListenerLevel => levels[identity] ?? { volume: defaultVolume.current, muted: false };

  function changeLevel(identity: string, next: ListenerLevel): void {
    setLevels((current) => ({ ...current, [identity]: next }));
    if (!next.muted) {
      defaultVolume.current = next.volume;
      storeVolume(next.volume);
    }
  }

  const featuredTrack = featured?.track;
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !featuredTrack) return;
    featuredTrack.attach(element);
    return () => {
      featuredTrack.detach(element);
    };
  }, [featuredTrack]);

  // Em tela cheia os controles somem depois de alguns segundos parado.
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number>();
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);
  useEffect(() => {
    if (fullscreen.active) wake();
  }, [fullscreen.active, wake]);

  const toggleFullscreen = fullscreen.toggle;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Navegadores tratam Esc sozinhos; o Electron não, então a página sai da tela cheia.
      if (event.key === 'Escape') {
        void leaveFullscreen();
        return;
      }
      if (event.key.toLowerCase() !== 'f' || event.ctrlKey || event.metaKey || event.altKey || !hasMediaRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      void toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleFullscreen]);

  const others = items.filter((item) => item.id !== featured?.id);
  const featuredAudio = featured && !featured.local ? audio[featured.identity] : undefined;

  return (
    <section className="stage" aria-label="Transmissões">
      <div
        ref={viewportRef}
        className={`viewport ${fullscreen.active ? 'is-fullscreen' : ''} ${fullscreen.active && idle ? 'is-idle' : ''}`}
        onPointerMove={fullscreen.active ? wake : undefined}
        onDoubleClick={featured || showRpg ? () => void toggleFullscreen() : undefined}
      >
        <video ref={videoRef} autoPlay playsInline muted hidden={!featured} />

        {!featured && !showRpg && <div className="viewport-empty">{empty}</div>}

        {/* Quem transmite vê a mesma imagem que os espectadores: a prévia ficaria preta (vídeo pausado). */}
        {rpgActive && (showRpg || featured?.local) && (
          <div className="rpg-screen">
            {rpg?.imageUrl ? (
              <>
                <img className="rpg-backdrop" src={rpg.imageUrl} alt="" aria-hidden="true" />
                <img className="rpg-image" src={rpg.imageUrl} alt="Imagem do modo RPG" />
              </>
            ) : (
              <span className="spinner" aria-label="Carregando imagem do modo RPG" />
            )}
          </div>
        )}

        {showRpg && (
          <div className="overlay">
            <div className="overlay-top">
              <span className="rpg-tag">Modo RPG</span>
              <span className="overlay-title">Só o áudio, sem spoiler</span>
            </div>
            <div className="overlay-bottom" onFocus={wake}>
              <div className="rpg-volumes">
                {Object.keys(audio).length > 0 ? (
                  Object.keys(audio).map((identity) => (
                    <VolumeControl
                      key={identity}
                      name={names[identity] ?? 'Transmissão'}
                      level={levelOf(identity)}
                      onChange={(next) => changeLevel(identity, next)}
                    />
                  ))
                ) : (
                  <span className="media-chip"><VolumeOffIcon size={16} />Nenhum som sendo transmitido agora</span>
                )}
              </div>
              <button
                type="button"
                className="icon-btn on-media"
                onClick={() => void toggleFullscreen()}
                aria-label={fullscreen.active ? 'Sair da tela cheia' : 'Tela cheia'}
                title={fullscreen.active ? 'Sair da tela cheia (Esc)' : 'Tela cheia (F)'}
              >
                {fullscreen.active ? <CollapseIcon /> : <ExpandIcon />}
              </button>
            </div>
            {fullscreen.error && <p className="media-toast" role="alert">{fullscreen.error}</p>}
          </div>
        )}

        {featured && (
          <div className="overlay">
            <div className="overlay-top">
              <span className="live-tag"><span className="live-dot" aria-hidden="true" />Ao vivo</span>
              <span className="overlay-title">{featured.local ? 'Sua tela' : featured.name}</span>
              {overlayExtra}
            </div>
            <div className="overlay-bottom" onFocus={wake}>
              {featured.local && rpgActive ? (
                <span className="media-chip">Modo RPG: quem assiste vê esta imagem e só ouve o som; sua tela não é enviada</span>
              ) : featured.local ? (
                <span className="media-chip">Prévia da sua tela, sem som aqui para evitar eco</span>
              ) : featuredAudio ? (
                <VolumeControl
                  name={featured.name}
                  level={levelOf(featured.identity)}
                  onChange={(next) => changeLevel(featured.identity, next)}
                />
              ) : (
                <span className="media-chip"><VolumeOffIcon size={16} />Esta transmissão está sem som</span>
              )}
              <button
                type="button"
                className="icon-btn on-media"
                onClick={() => void toggleFullscreen()}
                aria-label={fullscreen.active ? 'Sair da tela cheia' : 'Tela cheia'}
                title={fullscreen.active ? 'Sair da tela cheia (Esc)' : 'Tela cheia (F)'}
              >
                {fullscreen.active ? <CollapseIcon /> : <ExpandIcon />}
              </button>
            </div>
            {fullscreen.error && <p className="media-toast" role="alert">{fullscreen.error}</p>}
          </div>
        )}
      </div>

      {others.length > 0 && (
        <div className="strip" aria-label="Outras transmissões">
          {others.map((item) => (
            <button
              key={item.id}
              type="button"
              className="thumb"
              onClick={() => setFeaturedId(item.id)}
              aria-label={`Assistir ${item.local ? 'sua tela' : `a tela de ${item.name}`} em destaque`}
            >
              <ThumbVideo track={item.track} />
              <span className="thumb-name">{item.local ? 'Sua tela' : item.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="audio-sink" aria-hidden="true">
        {Object.entries(audio).map(([identity, track]) => (
          <RemoteAudioPlayer key={`${identity}-${track.sid}`} track={track} level={levelOf(identity)} />
        ))}
      </div>
    </section>
  );
}

function ThumbVideo({ track }: { track: RemoteVideoTrack | LocalVideoTrack }): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted />;
}

function RemoteAudioPlayer({ track, level }: { track: RemoteAudioTrack; level: ListenerLevel }): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  // Volume e mute aplicados só no elemento deste aparelho; a publicação não muda.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.muted = level.muted;
    if (canSetElementVolume()) element.volume = level.volume;
  }, [track, level.muted, level.volume]);

  return <audio ref={ref} autoPlay />;
}
