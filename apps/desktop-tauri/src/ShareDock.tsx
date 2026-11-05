import { useEffect, useRef, useState, type JSX } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Room } from 'livekit-client';
import { AlertIcon, ScreenIcon, StopIcon, VolumeIcon, VolumeOffIcon } from '../../../shared/ui/icons';
import { qualities, qualityKeys, isQualityKey, type QualityKey } from '../../../shared/ui/qualities';
import { requestShareGrant } from './session';

type ShareState = 'idle' | 'starting' | 'live';
type ShareEvent = { state: 'starting' | 'live' | 'stopped' | 'error'; message?: string };

function errorText(error: unknown): string {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : 'Não foi possível transmitir a tela.';
}

/** Controles da transmissão feita pelo Rust (captura + LiveKit nativos). */
export function ShareDock({ room, code }: { room: Room; code: string }): JSX.Element {
  const [quality, setQuality] = useState<QualityKey>('1080p30');
  const [withAudio, setWithAudio] = useState(true);
  const [state, setState] = useState<ShareState>('idle');
  const [muted, setMuted] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);

  useEffect(() => {
    const unlisten = listen<ShareEvent>('share:state', ({ payload }) => {
      if (payload.state === 'starting') setState('starting');
      else if (payload.state === 'live') setState('live');
      else {
        setState('idle');
        setMuted(false);
        if (payload.state === 'error' && payload.message) setNotice(payload.message);
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  async function start(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setNotice('');
    try {
      const preset = qualities[quality];
      const grant = await requestShareGrant(code, room.localParticipant.name || 'Visitante', room.localParticipant.identity);
      await invoke('start_share', {
        url: grant.url,
        token: grant.token,
        quality: { width: preset.width, height: preset.height, fps: preset.fps, bitrate: preset.bitrate },
        audio: withAudio ? 'system' : 'none'
      });
      setHasAudio(withAudio);
      setMuted(false);
    } catch (error) {
      setState('idle');
      setNotice(errorText(error));
    } finally {
      busyRef.current = false;
    }
  }

  async function stop(): Promise<void> {
    try {
      await invoke('stop_share');
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  async function toggleMuted(): Promise<void> {
    try {
      await invoke('set_share_audio_muted', { muted: !muted });
      setMuted(!muted);
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  const starting = state === 'starting';

  return (
    <footer className="dock" aria-label="Sua transmissão">
      {notice && (
        <p className="notice notice-error" role="alert">
          <AlertIcon size={18} />
          <span>{notice}</span>
          <button type="button" className="btn btn-quiet" onClick={() => setNotice('')}>Ok</button>
        </p>
      )}

      {state === 'live' ? (
        <>
          <div className="dock-state" role="status">
            <span className="dock-live" aria-hidden="true" />
            <span>
              <strong>Você está transmitindo</strong>
              {hasAudio ? (muted ? ', som mutado para todos' : ', com som') : ', sem som'}
            </span>
          </div>
          <div className="dock-actions">
            {hasAudio && (
              <button type="button" className={`btn ${muted ? 'btn-toggle' : ''}`} aria-pressed={muted} onClick={() => void toggleMuted()}>
                {muted ? <VolumeOffIcon size={18} /> : <VolumeIcon size={18} />}
                {muted ? 'Ativar som' : 'Mutar som'}
              </button>
            )}
            <button type="button" className="btn btn-danger" onClick={() => void stop()}>
              <StopIcon size={18} />Parar transmissão
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="dock-state">
            <label className="check">
              <input type="checkbox" checked={withAudio} onChange={(event) => setWithAudio(event.target.checked)} disabled={starting} />
              Incluir o som do sistema
            </label>
          </div>
          <div className="dock-settings">
            <label className="sr-only" htmlFor="tauri-quality">Qualidade</label>
            <select
              id="tauri-quality"
              className="select select-sm"
              value={quality}
              onChange={(event) => isQualityKey(event.target.value) && setQuality(event.target.value)}
              disabled={starting}
            >
              {qualityKeys.map((key) => <option key={key} value={key}>{qualities[key].label}</option>)}
            </select>
          </div>
          <div className="dock-actions">
            <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={starting} aria-busy={starting}>
              {starting ? <span className="spinner" aria-hidden="true" /> : <ScreenIcon size={18} />}
              {starting ? 'Iniciando…' : 'Compartilhar tela'}
            </button>
          </div>
        </>
      )}
    </footer>
  );
}
