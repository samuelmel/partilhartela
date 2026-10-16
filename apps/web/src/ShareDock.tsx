import { useEffect, useRef, useState, type JSX } from 'react';
import { Track, type Room } from 'livekit-client';
import { AlertIcon, ScreenIcon, StopIcon, VolumeIcon, VolumeOffIcon } from '../../../shared/ui/icons';
import { qualities, qualityKeys, isQualityKey, type QualityKey } from '../../../shared/ui/qualities';
import { setShareAudioMuted, type LocalShare } from '../../../shared/ui/roomState';
import { describeCaptureError, type CaptureSupport, type Notice } from './capture';

type Busy = 'start' | 'stop' | 'audio' | null;

/** Controles da transmissão deste navegador. Tudo publicado de verdade via LiveKit. */
export function ShareDock({ room, local, support }: { room: Room; local: LocalShare; support: CaptureSupport }): JSX.Element {
  const [quality, setQuality] = useState<QualityKey>('1080p30');
  const [withAudio, setWithAudio] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busyRef = useRef(false);
  const expectStopRef = useRef(false);
  const wasSharingRef = useRef(false);
  const sharing = Boolean(local.video);

  // Encerramento pelo controle do navegador/sistema: o SDK já despublica o vídeo;
  // aqui avisamos e garantimos que o áudio da tela não fique publicado sozinho.
  useEffect(() => {
    if (wasSharingRef.current && !sharing) {
      if (!expectStopRef.current) setNotice({ tone: 'info', text: 'A transmissão foi encerrada pelo navegador.' });
      expectStopRef.current = false;
    }
    wasSharingRef.current = sharing;

    if (!sharing && local.hasAudio && !busyRef.current) {
      const orphan = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
      if (orphan) void room.localParticipant.unpublishTrack(orphan);
    }
  }, [sharing, local.hasAudio, room]);

  async function start(): Promise<void> {
    if (busyRef.current || !support.ok) return;
    busyRef.current = true;
    setBusy('start');
    setNotice(null);
    const preset = qualities[quality];
    const askAudio = support.audio && withAudio;

    try {
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: askAudio,
          systemAudio: 'include',
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          suppressLocalAudioPlayback: false,
          contentHint: preset.fps >= 60 ? 'motion' : 'detail',
          resolution: { width: preset.width, height: preset.height, frameRate: preset.fps }
        },
        {
          videoCodec: 'h264',
          simulcast: false,
          screenShareEncoding: { maxBitrate: preset.bitrate, maxFramerate: preset.fps },
          degradationPreference: preset.fps >= 60 ? 'maintain-framerate' : 'maintain-resolution'
        }
      );
      const audioPublished = Boolean(room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track);
      if (askAudio && !audioPublished && room.localParticipant.getTrackPublication(Track.Source.ScreenShare)) {
        setNotice({
          tone: 'warn',
          text: 'Transmitindo sem som: a fonte escolhida não enviou áudio. Para ter som, escolha uma aba (ou a tela inteira, no Windows) e marque "Compartilhar áudio" no seletor.'
        });
      }
    } catch (error) {
      console.warn('[PartilharTela] Falha ao compartilhar pela web:', error);
      setNotice(describeCaptureError(error));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function stop(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    expectStopRef.current = true;
    setBusy('stop');
    setNotice(null);
    try {
      await room.localParticipant.setScreenShareEnabled(false);
    } catch (error) {
      expectStopRef.current = false;
      setNotice({ tone: 'error', text: `Não foi possível parar a transmissão${error instanceof Error ? ` (${error.message})` : ''}. Tente de novo.` });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function toggleAudio(): Promise<void> {
    setBusy('audio');
    try {
      await setShareAudioMuted(room, !local.audioMuted);
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível mudar o som da transmissão.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <footer className="dock" aria-label="Sua transmissão">
      {notice && (
        <p className={`notice notice-${notice.tone === 'info' ? 'plain' : notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          <AlertIcon size={18} />
          <span>{notice.text}</span>
          <button type="button" className="btn btn-quiet" onClick={() => setNotice(null)}>Ok</button>
        </p>
      )}

      {!support.ok ? (
        <div className="dock-state">
          <AlertIcon size={18} />
          <span className="only-wide">{support.reason}</span>
          <span className="only-narrow">Daqui você assiste. Para transmitir, use um computador.</span>
        </div>
      ) : sharing ? (
        <>
          <div className="dock-state" role="status">
            <span className="dock-live" aria-hidden="true" />
            <span>
              <strong>Você está transmitindo</strong>
              {local.hasAudio ? (local.audioMuted ? ', som mutado para todos' : ', com som') : ', sem som'}
            </span>
          </div>
          <div className="dock-actions">
            {local.hasAudio && (
              <button
                type="button"
                className={`btn ${local.audioMuted ? 'btn-toggle' : ''}`}
                aria-pressed={local.audioMuted}
                onClick={() => void toggleAudio()}
                disabled={busy !== null}
              >
                {local.audioMuted ? <VolumeOffIcon size={18} /> : <VolumeIcon size={18} />}
                {local.audioMuted ? 'Ativar som' : 'Mutar som'}
              </button>
            )}
            <button type="button" className="btn btn-danger" onClick={() => void stop()} disabled={busy !== null} aria-busy={busy === 'stop'}>
              {busy === 'stop' ? <span className="spinner" aria-hidden="true" /> : <StopIcon size={18} />}
              Parar transmissão
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="dock-state">
            {support.audio ? (
              <label className="check">
                <input type="checkbox" checked={withAudio} onChange={(event) => setWithAudio(event.target.checked)} disabled={busy !== null} />
                Incluir som da aba ou do sistema
              </label>
            ) : (
              <span>Este navegador transmite só a imagem, sem som.</span>
            )}
          </div>
          <div className="dock-settings">
            <label className="sr-only" htmlFor="web-quality">Qualidade</label>
            <select
              id="web-quality"
              className="select select-sm"
              value={quality}
              onChange={(event) => isQualityKey(event.target.value) && setQuality(event.target.value)}
              disabled={busy !== null}
            >
              {qualityKeys.map((key) => <option key={key} value={key}>{qualities[key].label}</option>)}
            </select>
          </div>
          <div className="dock-actions">
            <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={busy !== null} aria-busy={busy === 'start'}>
              {busy === 'start' ? <span className="spinner" aria-hidden="true" /> : <ScreenIcon size={18} />}
              {busy === 'start' ? 'Escolha a tela no navegador…' : 'Compartilhar minha tela'}
            </button>
          </div>
        </>
      )}
    </footer>
  );
}
