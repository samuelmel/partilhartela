import { useEffect, useRef, useState, type JSX } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Room } from 'livekit-client';
import { AlertIcon, ScreenIcon, StopIcon, VolumeIcon, VolumeOffIcon } from '../../../shared/ui/icons';
import { qualities, qualityKeys, isQualityKey, type QualityKey } from '../../../shared/ui/qualities';
import { announceScreenRepublish } from '../../../shared/ui/shareSounds';
import { requestShareGrant } from './session';
import { SourcePicker, type CaptureSource } from './SourcePicker';

type AudioMode = 'none' | 'system' | 'application' | 'system-excluding';
type AudioProcess = { pid: number; name: string };
type ShareState = 'idle' | 'starting' | 'live';
type ShareEvent = { state: 'starting' | 'live' | 'stopped' | 'error'; message?: string };

function errorText(error: unknown): string {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : 'Não foi possível transmitir a tela.';
}

/**
 * "Texto e código" manda menos quadros por segundo com o mesmo bitrate: cada quadro fica mais nítido
 * (leitura). "Movimento e jogos" mantém a taxa de quadros do preset.
 */
function presetFor(key: QualityKey, motion: boolean): { width: number; height: number; fps: number; bitrate: number } {
  const preset = qualities[key];
  return { width: preset.width, height: preset.height, fps: motion ? preset.fps : Math.min(preset.fps, 15), bitrate: preset.bitrate };
}

const modeHints = {
  motion: 'Movimento e jogos: mantém todos os quadros por segundo da qualidade escolhida. Bom para jogos, vídeos e cutscenes; texto pequeno pode ficar um pouco borrado quando a imagem muda muito.',
  detail: 'Texto e código: manda no máximo 15 quadros por segundo, mas cada quadro fica mais nítido. Bom para ler documentos, código e fichas; movimento rápido fica mais travado.'
} as const;

/** Controles da transmissão feita pelo Rust (captura + LiveKit nativos). */
export function ShareDock({ room, code }: { room: Room; code: string }): JSX.Element {
  const [quality, setQuality] = useState<QualityKey>('1080p30');
  const [motion, setMotion] = useState(true);
  const [applying, setApplying] = useState(false);
  const lastSourceRef = useRef<CaptureSource>();
  const [audioMode, setAudioMode] = useState<AudioMode>('system');
  const [processes, setProcesses] = useState<AudioProcess[]>([]);
  const [audioPid, setAudioPid] = useState<number | null>(null);
  const [state, setState] = useState<ShareState>('idle');
  const [muted, setMuted] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);
  const [picker, setPicker] = useState<{ sources: CaptureSource[]; loading: boolean; error: string } | null>(null);

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

  async function loadProcesses(): Promise<void> {
    try {
      const list = await invoke<AudioProcess[]>('list_audio_processes');
      setProcesses(list);
      setAudioPid((current) => (current !== null && list.some((item) => item.pid === current) ? current : null));
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  function changeAudioMode(mode: AudioMode): void {
    setAudioMode(mode);
    if (mode === 'application' || mode === 'system-excluding') void loadProcesses();
  }

  async function openPicker(): Promise<void> {
    setNotice('');
    if (audioMode === 'application' || audioMode === 'system-excluding') void loadProcesses();
    setPicker({ sources: [], loading: true, error: '' });
    try {
      const sources = await invoke<CaptureSource[]>('list_sources');
      setPicker({ sources, loading: false, error: '' });
    } catch (error) {
      setPicker({ sources: [], loading: false, error: errorText(error) });
    }
  }

  async function start(source: CaptureSource, overrides?: { quality: QualityKey; motion: boolean }): Promise<void> {
    if (busyRef.current) return;
    // Som de um aplicativo: sem escolha própria, sugere o dono da janela transmitida.
    const pid = audioPid ?? (audioMode === 'application' ? source.pid ?? null : null);
    if ((audioMode === 'application' || audioMode === 'system-excluding') && pid === null) {
      setPicker((current) => (current ? { ...current, error: 'Escolha o aplicativo do som antes de transmitir.' } : current));
      return;
    }
    busyRef.current = true;
    setNotice('');
    try {
      const preset = presetFor(overrides?.quality ?? quality, overrides?.motion ?? motion);
      const grant = await requestShareGrant(code, room.localParticipant.name || 'Visitante', room.localParticipant.identity);
      await invoke('start_share', {
        url: grant.url,
        token: grant.token,
        quality: preset,
        audio: audioMode,
        audioPid: pid,
        source: source.id
      });
      lastSourceRef.current = source;
      setPicker(null);
      setHasAudio(audioMode !== 'none');
      setMuted(false);
    } catch (error) {
      setState('idle');
      if (picker) setPicker((current) => (current ? { ...current, error: errorText(error) } : current));
      else setNotice(errorText(error));
    } finally {
      busyRef.current = false;
    }
  }

  /** Troca qualidade ou modo com a transmissão no ar: republica a mesma fonte e o mesmo som com os novos valores. */
  async function changeLive(nextQuality: QualityKey, nextMotion: boolean): Promise<void> {
    setQuality(nextQuality);
    setMotion(nextMotion);
    const source = lastSourceRef.current;
    if (state !== 'live' || !source || applying || busyRef.current) return;
    setApplying(true);
    setNotice('');
    try {
      await announceScreenRepublish(room);
      await invoke('stop_share');
      await start(source, { quality: nextQuality, motion: nextMotion });
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setApplying(false);
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

      {state === 'live' || applying ? (
        <>
          <div className="dock-state" role="status">
            <span className="dock-live" aria-hidden="true" />
            <span>
              <strong>{applying ? 'Aplicando a mudança…' : 'Você está transmitindo'}</strong>
              {!applying && (hasAudio ? (muted ? ', som mutado para todos' : ', com som') : ', sem som')}
            </span>
          </div>
          <div className="dock-settings">
            <label className="sr-only" htmlFor="tauri-live-quality">Qualidade</label>
            <select
              id="tauri-live-quality"
              className="select select-sm"
              value={quality}
              onChange={(event) => isQualityKey(event.target.value) && void changeLive(event.target.value, motion)}
              disabled={applying}
            >
              {qualityKeys.map((key) => <option key={key} value={key}>{qualities[key].label}</option>)}
            </select>
            <label className="sr-only" htmlFor="tauri-live-mode">Modo</label>
            <select
              id="tauri-live-mode"
              className="select select-sm"
              value={motion ? 'motion' : 'detail'}
              onChange={(event) => void changeLive(quality, event.target.value === 'motion')}
              disabled={applying}
            >
              <option value="motion">Movimento e jogos</option>
              <option value="detail">Texto e código</option>
            </select>
          </div>
          <div className="dock-actions">
            {hasAudio && (
              <button type="button" className={`btn ${muted ? 'btn-toggle' : ''}`} aria-pressed={muted} onClick={() => void toggleMuted()} disabled={applying}>
                {muted ? <VolumeOffIcon size={18} /> : <VolumeIcon size={18} />}
                {muted ? 'Ativar som' : 'Mutar som'}
              </button>
            )}
            <button type="button" className="btn btn-danger" onClick={() => void stop()} disabled={applying}>
              <StopIcon size={18} />Parar transmissão
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="dock-state">
            <label className="sr-only" htmlFor="tauri-audio">Som</label>
            <select
              id="tauri-audio"
              className="select select-sm"
              value={audioMode}
              onChange={(event) => changeAudioMode(event.target.value as AudioMode)}
              disabled={starting}
            >
              <option value="none">Sem som</option>
              <option value="system">Som do sistema</option>
              <option value="application">Som de um aplicativo</option>
              <option value="system-excluding">Sistema, menos um aplicativo</option>
            </select>
            {(audioMode === 'application' || audioMode === 'system-excluding') && (
              <>
                <label className="sr-only" htmlFor="tauri-audio-app">Aplicativo</label>
                <select
                  id="tauri-audio-app"
                  className="select select-sm"
                  value={audioPid ?? ''}
                  onChange={(event) => setAudioPid(event.target.value ? Number(event.target.value) : null)}
                  disabled={starting}
                >
                  <option value="">{audioMode === 'application' ? 'Dono da janela escolhida' : 'Escolha o aplicativo'}</option>
                  {processes.map((item) => <option key={item.pid} value={item.pid}>{item.name}</option>)}
                </select>
              </>
            )}
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
            <label className="sr-only" htmlFor="tauri-mode">Modo</label>
            <select
              id="tauri-mode"
              className="select select-sm"
              value={motion ? 'motion' : 'detail'}
              onChange={(event) => setMotion(event.target.value === 'motion')}
              disabled={starting}
            >
              <option value="motion">Movimento e jogos</option>
              <option value="detail">Texto e código</option>
            </select>
          </div>
          <div className="dock-actions">
            <button type="button" className="btn btn-primary" onClick={() => void openPicker()} disabled={starting} aria-busy={starting}>
              {starting ? <span className="spinner" aria-hidden="true" /> : <ScreenIcon size={18} />}
              {starting ? 'Iniciando…' : 'Compartilhar tela'}
            </button>
          </div>
        </>
      )}
      <p className="dock-hint">{modeHints[motion ? 'motion' : 'detail']}</p>
      {picker && (
        <SourcePicker
          sources={picker.sources}
          loading={picker.loading}
          starting={starting}
          error={picker.error}
          onClose={() => !starting && setPicker(null)}
          onRefresh={() => void openPicker()}
          onSelect={(source) => void start(source)}
        />
      )}
    </footer>
  );
}
