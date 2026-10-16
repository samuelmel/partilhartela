import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track
} from 'livekit-client';
import {
  AlertIcon,
  BrandMark,
  CloseIcon,
  RefreshIcon,
  ScreenIcon,
  StatsIcon,
  StopIcon,
  SwapIcon,
  UsersIcon,
  VolumeIcon,
  VolumeOffIcon
} from '../../../../shared/ui/icons';
import { qualities, qualityKeys, isQualityKey, type QualityKey } from '../../../../shared/ui/qualities';
import {
  describeConnectError,
  setShareAudioMuted,
  useConnectionState,
  useRoomSnapshot,
  type LocalShare
} from '../../../../shared/ui/roomState';
import { RoomSidebar } from '../../../../shared/ui/RoomSidebar';
import { Stage } from '../../../../shared/ui/Stage';
import { leaveFullscreen } from '../../../../shared/ui/useFullscreen';
import '../../../../shared/ui/base.css';
import '../../../../shared/ui/room.css';
import './styles.css';

type AudioMode = 'none' | 'system' | 'application' | 'system-excluding-discord';

type CaptureSource = {
  id: string;
  type: 'screen' | 'window';
  name: string;
  thumbnail: string;
  appIcon: string | null;
  processId?: string;
};

type WebRtcStats = {
  rttMs?: number;
  fps?: number;
  bitrateKbps?: number;
  resolution?: string;
  encoder?: string;
  packetLoss?: number;
};

type RoomGrant = { code: string; roomName: string; token: string; livekitUrl: string };

const audioModes: Array<{ value: AudioMode; label: string }> = [
  { value: 'none', label: 'Sem áudio' },
  { value: 'system', label: 'Todo o sistema' },
  { value: 'application', label: 'Só a janela transmitida' },
  { value: 'system-excluding-discord', label: 'Sistema, exceto um app' }
];

const tokenServer = import.meta.env.VITE_TOKEN_SERVER_URL ?? 'http://localhost:8787';
const webAppUrl = import.meta.env.VITE_WEB_APP_URL?.replace(/\/+$/, '');
const codePattern = /^[A-Z0-9]{6}$/;
const nicknameKey = 'partilhartela.nickname';

function readNickname(): string {
  try {
    return window.localStorage.getItem(nicknameKey) ?? '';
  } catch {
    return '';
  }
}

function storeNickname(value: string): void {
  try {
    window.localStorage.setItem(nicknameKey, value);
  } catch {
    // Sem armazenamento: só não lembra o apelido.
  }
}

async function postJson<T>(endpoint: string, data: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${tokenServer}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch {
    throw new Error(`Não foi possível acessar o servidor de salas (${tokenServer}). Verifique sua internet ou tente novamente.`);
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(errorBody?.error ?? 'Servidor indisponível.');
  }

  return response.json() as Promise<T>;
}

async function stopApplicationAudio(): Promise<void> {
  try {
    if (window.partilharTela?.stopApplicationAudio) {
      await window.partilharTela.stopApplicationAudio();
    }
  } catch (err) {
    console.warn('[PartilharTela] Erro ao parar áudio:', err);
  }
}

async function createPcmAudio(starter: () => Promise<void>): Promise<LocalAudioTrack> {
  const audioContext = new AudioContext({ sampleRate: 48000 });
  const destination = audioContext.createMediaStreamDestination();
  const sampleRate = audioContext.sampleRate;
  const channels = 2;

  let scheduledTime = audioContext.currentTime;

  const unsubscribe = window.partilharTela.onAudioData((chunk: Uint8Array) => {
    try {
      const pcm16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
      const frameCount = pcm16.length / channels;
      if (frameCount <= 0) return;

      const audioBuffer = audioContext.createBuffer(channels, frameCount, sampleRate);
      const leftChannel = audioBuffer.getChannelData(0);
      const rightChannel = channels > 1 ? audioBuffer.getChannelData(1) : leftChannel;

      for (let i = 0; i < frameCount; i++) {
        leftChannel[i] = pcm16[i * channels] / 32768;
        if (channels > 1) {
          rightChannel[i] = pcm16[i * channels + 1] / 32768;
        }
      }

      const sourceNode = audioContext.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(destination);

      const currentTime = audioContext.currentTime;
      if (scheduledTime < currentTime) {
        scheduledTime = currentTime + 0.02;
      }
      sourceNode.start(scheduledTime);
      scheduledTime += audioBuffer.duration;
    } catch (e) {
      console.warn('[PartilharTela] Erro ao processar chunk de áudio PCM:', e);
    }
  });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    unsubscribe();
    void audioContext.close();
  };

  try {
    await starter();
  } catch (err) {
    release();
    throw err;
  }

  const track = destination.stream.getAudioTracks()[0];
  const localTrack = new LocalAudioTrack(track);

  // MediaStreamTrack.stop() não dispara 'ended'; libera o contexto quando a track for parada.
  // Mutar não chama stop(): a captura segue viva e desmutar só reabilita a mesma track.
  track.addEventListener('ended', release);
  const stopTrack = localTrack.stop.bind(localTrack);
  localTrack.stop = () => {
    release();
    stopTrack();
  };

  return localTrack;
}

async function createApplicationAudio(processId: string): Promise<LocalAudioTrack> {
  await stopApplicationAudio();
  return createPcmAudio(() => window.partilharTela.startApplicationAudio(processId));
}

async function unpublishLocalTrack(
  trackRef: React.MutableRefObject<LocalVideoTrack | LocalAudioTrack | undefined>,
  room: Room | undefined
) {
  const track = trackRef.current;
  trackRef.current = undefined;
  if (!track) return;
  try {
    if (room) await room.localParticipant.unpublishTrack(track);
  } catch (err) {
    console.warn('[PartilharTela] Erro ao despublicar track:', err);
  } finally {
    track.stop();
  }
}

async function readWebRtcStats(
  room: Room,
  statsHistoryRef: React.MutableRefObject<{ bytes: number; time: number } | undefined>,
  setStats: React.Dispatch<React.SetStateAction<WebRtcStats>>
) {
  // API interna do SDK (sem tipos públicos): só leitura de getStats().
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const engine = (room as any).engine;
  const pcManager = engine?.pcManager;
  const publisherStats = await pcManager?.publisher?.getStats();
  const subscriberStats = await pcManager?.subscriber?.getStats();
  const reports = [publisherStats, subscriberStats].filter(Boolean);
  if (reports.length === 0) return;

  const statsList: any[] = (await Promise.all(reports)).flatMap((r) => Array.from(r.values()));
  const isVideo = (entry: any) => entry.kind === 'video' || entry.mediaType === 'video';

  const outbound = statsList.filter((e) => e.type === 'outbound-rtp' && isVideo(e));
  const inbound = statsList.filter((e) => e.type === 'inbound-rtp' && isVideo(e));
  const activeCandidate = statsList.find((e) => e.type === 'candidate-pair' && (e.state === 'succeeded' || e.nominated));
  const codec = statsList.find((e) => e.type === 'codec' && e.mimeType?.toLowerCase().startsWith('video/'));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const now = performance.now();
  const bytesSent = outbound.reduce((sum, e) => sum + (typeof e.bytesSent === 'number' ? e.bytesSent : 0), 0);
  const bytesReceived = inbound.reduce((sum, e) => sum + (typeof e.bytesReceived === 'number' ? e.bytesReceived : 0), 0);
  const totalBytes = bytesSent > 0 ? bytesSent : bytesReceived > 0 ? bytesReceived : undefined;

  const history = statsHistoryRef.current;
  const deltaSeconds = history && totalBytes !== undefined ? (now - history.time) / 1000 : 0;
  const bitrateKbps =
    deltaSeconds > 0 && history?.bytes !== undefined && totalBytes !== undefined
      ? Math.round(((totalBytes - history.bytes) * 8) / deltaSeconds / 1000)
      : undefined;

  const primaryOut = outbound[0];
  const primaryIn = inbound[0];

  setStats({
    rttMs: typeof activeCandidate?.currentRoundTripTime === 'number' ? Math.round(activeCandidate.currentRoundTripTime * 1000) : undefined,
    fps: typeof primaryIn?.framesPerSecond === 'number' ? Math.round(primaryIn.framesPerSecond) : typeof primaryOut?.framesPerSecond === 'number' ? Math.round(primaryOut.framesPerSecond) : undefined,
    bitrateKbps,
    resolution: typeof primaryIn?.frameWidth === 'number' ? `${primaryIn.frameWidth}x${primaryIn.frameHeight}` : typeof primaryOut?.frameWidth === 'number' ? `${primaryOut.frameWidth}x${primaryOut.frameHeight}` : undefined,
    encoder: typeof primaryOut?.encoderImplementation === 'string' ? primaryOut.encoderImplementation : typeof codec?.mimeType === 'string' ? codec.mimeType : undefined,
    packetLoss: typeof primaryIn?.packetsLost === 'number' ? primaryIn.packetsLost : undefined
  });

  if (totalBytes !== undefined) {
    statsHistoryRef.current = { bytes: totalBytes, time: now };
  }
}

function StatsOverlay({ stats, fallback }: { stats: WebRtcStats; fallback: string }) {
  return (
    <dl className="stats">
      <div><dt>Resolução</dt><dd>{stats.resolution ?? fallback}</dd></div>
      <div><dt>FPS</dt><dd>{stats.fps ?? '–'}</dd></div>
      <div><dt>Codec</dt><dd>{stats.encoder ?? '–'}</dd></div>
      <div><dt>Bitrate</dt><dd>{stats.bitrateKbps ? `${stats.bitrateKbps} kbps` : '–'}</dd></div>
      <div><dt>Latência</dt><dd>{stats.rttMs !== undefined ? `${stats.rttMs} ms` : '–'}</dd></div>
    </dl>
  );
}

function Home({
  initialCode,
  error,
  onCreate,
  onJoin
}: {
  initialCode: string;
  error: string;
  onCreate: (nickname: string) => Promise<void>;
  onJoin: (code: string, nickname: string) => Promise<void>;
}) {
  const [nickname, setNickname] = useState(readNickname);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [localError, setLocalError] = useState('');
  const [nicknameMissing, setNicknameMissing] = useState(false);
  const shownError = localError || error;

  async function run(kind: 'create' | 'join') {
    const name = nickname.trim();
    const normalized = code.trim().toUpperCase();
    setLocalError('');
    if (!name) {
      setNicknameMissing(true);
      setLocalError('Escolha um apelido para aparecer na sala.');
      document.getElementById('nickname')?.focus();
      return;
    }
    if (kind === 'join' && !codePattern.test(normalized)) {
      setLocalError('O código tem 6 letras ou números, como K7RM2Q.');
      document.getElementById('room-code')?.focus();
      return;
    }
    storeNickname(name);
    setBusy(kind);
    try {
      if (kind === 'create') await onCreate(name);
      else await onJoin(normalized, name);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Não foi possível entrar na sala.');
      setBusy(null);
    }
  }

  const working = busy !== null;

  return (
    <div className="d-home">
      <header className="d-home-head">
        <span className="brand"><BrandMark />PartilharTela</span>
      </header>
      <main className="d-home-body">
        <section className="d-start" aria-labelledby="start-title">
          <h1 id="start-title">Compartilhe sua tela</h1>
          <p className="d-lead">Crie uma sala e passe o código. Quem entrar assiste por este app ou pelo navegador.</p>

          <div className="field">
            <label className="field-label" htmlFor="nickname">Seu apelido</label>
            <input
              id="nickname"
              className="input"
              value={nickname}
              maxLength={32}
              placeholder="Como você quer aparecer"
              aria-invalid={nicknameMissing && !nickname.trim()}
              onChange={(e) => {
                setNickname(e.target.value);
                setNicknameMissing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run('create');
              }}
              disabled={working}
            />
          </div>

          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            onClick={() => void run('create')}
            disabled={working}
            aria-busy={busy === 'create'}
          >
            {busy === 'create' && <span className="spinner" aria-hidden="true" />}
            {busy === 'create' ? 'Criando sala…' : 'Criar sala'}
          </button>

          <form
            className="d-join"
            onSubmit={(e) => {
              e.preventDefault();
              void run('join');
            }}
          >
            <label className="field-label" htmlFor="room-code">Ou entre com um código</label>
            <div className="d-join-row">
              <input
                id="room-code"
                className="input code-input"
                value={code}
                maxLength={6}
                spellCheck={false}
                placeholder="CÓDIGO"
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                disabled={working}
              />
              <button type="submit" className="btn" disabled={working} aria-busy={busy === 'join'}>
                {busy === 'join' && <span className="spinner" aria-hidden="true" />}
                {busy === 'join' ? 'Entrando…' : 'Entrar'}
              </button>
            </div>
          </form>

          <div aria-live="assertive">
            {shownError && <p className="notice notice-error"><AlertIcon size={18} />{shownError}</p>}
          </div>
        </section>

        <section className="d-modes" aria-labelledby="modes-title">
          <h2 id="modes-title">O som que vai junto</h2>
          <p className="d-modes-intro">Você escolhe na sala e pode trocar durante a transmissão.</p>
          <dl>
            <div><dt>Sem áudio</dt><dd>Só a imagem.</dd></div>
            <div><dt>Todo o sistema</dt><dd>Tudo o que toca no computador, inclusive chamadas de voz.</dd></div>
            <div><dt>Só a janela transmitida</dt><dd>Apenas o som do programa que você mostra. O melhor para jogos.</dd></div>
            <div><dt>Sistema, exceto um app</dt><dd>Tudo menos o programa que você escolher, como o Discord, para sua conversa não vazar.</dd></div>
          </dl>
        </section>
      </main>
    </div>
  );
}

function ShareModal({
  sources,
  selectedSource,
  loading,
  publishing,
  preferWindows,
  onClose,
  onRefresh,
  onSelect
}: {
  sources: CaptureSource[];
  selectedSource: string;
  loading: boolean;
  publishing: boolean;
  preferWindows: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<'screens' | 'windows'>(preferWindows ? 'windows' : 'screens');
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const filtered = sources.filter((s) => (tab === 'screens' ? s.type === 'screen' : s.type === 'window'));

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={dialogRef} className="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title" tabIndex={-1}>
        <header className="modal-head">
          <div>
            <h2 id="share-title">O que você quer transmitir?</h2>
            <p>
              {preferWindows
                ? 'Para mandar só o som de um programa, escolha a janela dele.'
                : 'Clique numa tela ou janela para começar.'}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
            <CloseIcon />
          </button>
        </header>

        <div className="modal-tabs" role="tablist" aria-label="Tipo de fonte">
          <button type="button" role="tab" aria-selected={tab === 'screens'} onClick={() => setTab('screens')}>Telas</button>
          <button type="button" role="tab" aria-selected={tab === 'windows'} onClick={() => setTab('windows')}>Janelas</button>
          <button type="button" className="btn btn-quiet modal-refresh" onClick={onRefresh} disabled={loading}>
            <RefreshIcon size={16} />Atualizar lista
          </button>
        </div>

        <div className="modal-body" role="tabpanel" aria-busy={loading || publishing}>
          {loading ? (
            <p className="modal-empty"><span className="spinner" aria-hidden="true" />Procurando telas e janelas…</p>
          ) : filtered.length === 0 ? (
            <p className="modal-empty">Nenhuma {tab === 'screens' ? 'tela' : 'janela'} encontrada. Abra o programa e clique em Atualizar lista.</p>
          ) : (
            <div className="sources">
              {filtered.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="source"
                  aria-current={selectedSource === s.id}
                  onClick={() => onSelect(s.id)}
                  disabled={publishing}
                >
                  <img src={s.thumbnail} alt="" />
                  <span className="source-name">
                    {s.appIcon && <img src={s.appIcon} alt="" />}
                    <span>{s.name}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {publishing && <p className="modal-foot" role="status"><span className="spinner" aria-hidden="true" />Iniciando a transmissão…</p>}
      </section>
    </div>
  );
}

function Dock({
  local,
  sourceName,
  busy,
  quality,
  motion,
  audioMode,
  audioProcesses,
  excludedAudioProcessId,
  onQuality,
  onMotion,
  onAudio,
  onExcludedAudio,
  onShare,
  onStop,
  onToggleAudio
}: {
  local: LocalShare;
  sourceName?: string;
  busy: 'publish' | 'stop' | 'audio' | null;
  quality: QualityKey;
  motion: boolean;
  audioMode: AudioMode;
  audioProcesses: Array<{ title: string; processId: string }>;
  excludedAudioProcessId: string;
  onQuality: (q: QualityKey) => void;
  onMotion: (m: boolean) => void;
  onAudio: (m: AudioMode) => void;
  onExcludedAudio: (pid: string) => void;
  onShare: () => void;
  onStop: () => void;
  onToggleAudio: () => void;
}) {
  const sharing = Boolean(local.video);
  const disabled = busy !== null;

  return (
    <footer className="dock" aria-label="Sua transmissão">
      <div className="dock-state" role="status">
        {sharing ? (
          <>
            <span className="dock-live" aria-hidden="true" />
            <span className="dock-state-text">
              <strong>{sourceName ? `Transmitindo ${sourceName}` : 'Você está transmitindo'}</strong>
              {audioMode === 'none' ? ', sem som' : local.hasAudio ? (local.audioMuted ? ', som mutado para todos' : ', com som') : ', som indisponível'}
            </span>
          </>
        ) : (
          <span>Você não está transmitindo. Ajuste abaixo e clique em <strong>Compartilhar tela</strong>.</span>
        )}
      </div>

      <div className="dock-actions">
        {sharing ? (
          <>
            <button type="button" className="btn" onClick={onShare} disabled={disabled}>
              <SwapIcon size={18} />Trocar fonte
            </button>
            {local.hasAudio && (
              <button
                type="button"
                className={`btn ${local.audioMuted ? 'btn-toggle' : ''}`}
                aria-pressed={local.audioMuted}
                onClick={onToggleAudio}
                disabled={disabled}
              >
                {local.audioMuted ? <VolumeOffIcon size={18} /> : <VolumeIcon size={18} />}
                {local.audioMuted ? 'Ativar som' : 'Mutar som'}
              </button>
            )}
            <button type="button" className="btn btn-danger" onClick={onStop} disabled={disabled} aria-busy={busy === 'stop'}>
              {busy === 'stop' ? <span className="spinner" aria-hidden="true" /> : <StopIcon size={18} />}
              Parar transmissão
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onShare} disabled={disabled} aria-busy={busy === 'publish'}>
            {busy === 'publish' ? <span className="spinner" aria-hidden="true" /> : <ScreenIcon size={18} />}
            Compartilhar tela
          </button>
        )}
      </div>

      <div className="dock-settings">
        <label className="dock-field">
          <span>Qualidade</span>
          <select className="select select-sm" value={quality} onChange={(e) => isQualityKey(e.target.value) && onQuality(e.target.value)} disabled={disabled}>
            {qualityKeys.map((key) => <option key={key} value={key}>{qualities[key].label}</option>)}
          </select>
        </label>
        <label className="dock-field">
          <span>Conteúdo</span>
          <select className="select select-sm" value={motion ? 'motion' : 'detail'} onChange={(e) => onMotion(e.target.value === 'motion')} disabled={disabled}>
            <option value="motion">Movimento e jogos</option>
            <option value="detail">Texto e código</option>
          </select>
        </label>
        <label className="dock-field">
          <span>Som</span>
          <select className="select select-sm" value={audioMode} onChange={(e) => onAudio(e.target.value as AudioMode)} disabled={disabled}>
            {audioModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
        </label>
        {audioMode === 'system-excluding-discord' && (
          <label className="dock-field">
            <span>Deixar de fora</span>
            <select className="select select-sm" value={excludedAudioProcessId} onChange={(e) => onExcludedAudio(e.target.value)} disabled={disabled}>
              <option value="">Escolha um app</option>
              {audioProcesses.map((p) => <option key={p.processId} value={p.processId}>{p.title}</option>)}
            </select>
          </label>
        )}
      </div>
    </footer>
  );
}

export function App() {
  const [view, setView] = useState<'home' | 'room'>('home');
  const [homeCode, setHomeCode] = useState('');
  const [homeError, setHomeError] = useState('');
  const [room, setRoom] = useState<Room>();
  const [roomCode, setRoomCode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [quality, setQuality] = useState<QualityKey>('1080p30');
  const [motion, setMotion] = useState(true);
  const [audioMode, setAudioMode] = useState<AudioMode>('none');
  const [audioProcesses, setAudioProcesses] = useState<Array<{ title: string; processId: string }>>([]);
  const [excludedAudioProcessId, setExcludedAudioProcessId] = useState('');
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);
  const [busy, setBusy] = useState<'publish' | 'stop' | 'audio' | null>(null);
  const [stats, setStats] = useState<WebRtcStats>({});
  const [statsOpen, setStatsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const snapshot = useRoomSnapshot(room);
  const connection = useConnectionState(room);

  const roomRef = useRef<Room>();
  const localVideoTrackRef = useRef<LocalVideoTrack>();
  const localAudioTrackRef = useRef<LocalAudioTrack>();
  const publishingRef = useRef(false);
  const statsHistoryRef = useRef<{ bytes: number; time: number }>();
  // Preferência de mute do apresentador; reaplicada quando a transmissão é republicada (qualidade, fonte).
  const shareAudioMutedRef = useRef(false);

  const audioModeRef = useRef(audioMode);
  audioModeRef.current = audioMode;
  const excludedAudioProcessIdRef = useRef(excludedAudioProcessId);
  excludedAudioProcessIdRef.current = excludedAudioProcessId;
  const lostConnectionRef = useRef<(code: string) => void>(() => undefined);

  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
    };
  }, []);

  function resetRoomState() {
    roomRef.current = undefined;
    localVideoTrackRef.current = undefined;
    localAudioTrackRef.current = undefined;
    shareAudioMutedRef.current = false;
    statsHistoryRef.current = undefined;
    setRoom(undefined);
    setStats({});
    setStatsOpen(false);
    setPanelOpen(false);
    setIsShareModalOpen(false);
    setBusy(null);
    setErrorMessage('');
    setView('home');
  }

  lostConnectionRef.current = (code: string) => {
    void stopApplicationAudio();
    void leaveFullscreen();
    resetRoomState();
    setHomeCode(code);
    setHomeError(`A conexão com a sala caiu. Entre de novo com o código ${code}.`);
  };

  async function connectToRoom(data: RoomGrant) {
    const nextRoom = new Room({
      adaptiveStream: true,
      dynacast: true,
      publishDefaults: {
        simulcast: false,
        videoCodec: 'h264'
      }
    });

    const statsInterval = window.setInterval(() => {
      readWebRtcStats(nextRoom, statsHistoryRef, setStats).catch((err) =>
        console.warn('[PartilharTela] Não foi possível ler estatísticas WebRTC:', err)
      );
    }, 2000);

    nextRoom.on(RoomEvent.Disconnected, (reason) => {
      window.clearInterval(statsInterval);
      // Handlers são registrados uma vez por conexão: usa ref, não estado React.
      if (reason !== DisconnectReason.CLIENT_INITIATED) {
        lostConnectionRef.current(data.code);
      }
    });

    try {
      await nextRoom.connect(data.livekitUrl, data.token, { autoSubscribe: true });
      if (!nextRoom.canPlaybackAudio) {
        await nextRoom.startAudio().catch((err: unknown) => {
          console.warn('[PartilharTela] O áudio remoto aguarda interação do usuário:', err);
        });
      }
    } catch (err) {
      window.clearInterval(statsInterval);
      await nextRoom.disconnect();
      const message = describeConnectError(err);
      throw new Error(
        import.meta.env.DEV
          ? `${message} Em desenvolvimento, confira se o LiveKit local está rodando: docker compose -f infra\\docker-compose.yml up -d`
          : message
      );
    }

    roomRef.current = nextRoom;
    setRoom(nextRoom);
    setRoomCode(data.code);
    setHomeError('');
    setErrorMessage('');
    setView('room');
  }

  async function handleCreateRoom(nickname: string) {
    const data = await postJson<RoomGrant>('/rooms', { nickname });
    await connectToRoom(data);
  }

  async function handleJoinRoom(code: string, nickname: string) {
    const data = await postJson<RoomGrant>(`/rooms/${code}/token`, { nickname });
    await connectToRoom(data);
  }

  async function loadSources() {
    setLoadingSources(true);
    try {
      const list = await window.partilharTela.getSources();
      const uniqueSources = Array.from(new Map(list.map((s) => [s.id, s])).values());
      setSources(uniqueSources);
      if (!selectedSourceId && uniqueSources[0]) {
        setSelectedSourceId(uniqueSources[0].id);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `Não foi possível listar as telas e janelas disponíveis: ${err.message}`
          : 'Não foi possível listar as telas e janelas disponíveis.'
      );
    } finally {
      setLoadingSources(false);
    }
  }

  async function loadAudioProcesses() {
    try {
      const list = await window.partilharTela.getAudioProcesses();
      setAudioProcesses(list);
      const discord = list.find((p) => p.title.toLowerCase().includes('discord'));
      if (!excludedAudioProcessIdRef.current && discord) {
        excludedAudioProcessIdRef.current = discord.processId;
        setExcludedAudioProcessId(discord.processId);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `Não foi possível listar os processos de áudio: ${err.message}`
          : 'Não foi possível listar os processos de áudio.'
      );
    }
  }

  async function publishScreen(sourceId = selectedSourceId, targetQuality = quality) {
    if (publishingRef.current) return;
    const currentRoom = roomRef.current;
    if (!currentRoom) {
      setErrorMessage('A sala ainda não está conectada.');
      return;
    }
    if (!sourceId) {
      setErrorMessage('Selecione uma tela ou janela para compartilhar.');
      return;
    }

    publishingRef.current = true;
    setBusy('publish');
    setErrorMessage('');
    const settings = qualities[targetQuality];
    let mediaStream: MediaStream | undefined;

    try {
      await stopApplicationAudio();
      await unpublishLocalTrack(localVideoTrackRef, currentRoom);
      await unpublishLocalTrack(localAudioTrackRef, currentRoom);

      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('A captura de tela não está disponível nesta janela do Electron.');
      }

      await window.partilharTela.setCaptureSource(sourceId);

      mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: settings.width, max: settings.width },
          height: { ideal: settings.height, max: settings.height },
          frameRate: { ideal: settings.fps, max: settings.fps }
        },
        audio: audioModeRef.current === 'system'
      });

      console.info('[PartilharTela] Fonte capturada:', sourceId);

      const videoTrack = mediaStream.getVideoTracks()[0];
      if (!videoTrack) {
        throw new Error('A fonte selecionada não forneceu vídeo. Escolha outra tela ou janela.');
      }

      await videoTrack.applyConstraints({
        width: { ideal: settings.width, max: settings.width },
        height: { ideal: settings.height, max: settings.height },
        frameRate: { ideal: settings.fps, max: settings.fps }
      });

      console.info('[PartilharTela] Resolução capturada:', videoTrack.getSettings());

      const localVideoTrack = new LocalVideoTrack(videoTrack);
      videoTrack.contentHint = motion ? 'motion' : 'detail';
      // A janela capturada foi fechada (ou a captura caiu): encerra tudo, inclusive o áudio PCM.
      videoTrack.addEventListener('ended', () => {
        if (localVideoTrackRef.current === localVideoTrack) {
          setErrorMessage('A fonte transmitida foi fechada, então a transmissão parou.');
          void stopSharing();
        }
      }, { once: true });

      localVideoTrackRef.current = localVideoTrack;

      const sourceInfo = sources.find((s) => s.id === sourceId);
      const targetPid = sourceInfo?.processId;
      let localAudioTrack: LocalAudioTrack | undefined;

      if (audioModeRef.current === 'application') {
        if (!targetPid) {
          throw new Error('Esta fonte não é uma janela de aplicativo com PID detectável. Escolha uma janela para capturar o áudio dela.');
        }
        localAudioTrack = await createApplicationAudio(targetPid);
      } else if (audioModeRef.current === 'system-excluding-discord') {
        await stopApplicationAudio();
        if (!excludedAudioProcessIdRef.current) {
          throw new Error('Escolha o app que deve ficar fora do som.');
        }
        localAudioTrack = await createPcmAudio(() =>
          window.partilharTela.startSystemAudioExcluding(excludedAudioProcessIdRef.current)
        );
      } else if (audioModeRef.current === 'system' && mediaStream.getAudioTracks()[0]) {
        localAudioTrack = new LocalAudioTrack(mediaStream.getAudioTracks()[0]);
      }

      if (localAudioTrack) {
        localAudioTrack.mediaStreamTrack.enabled = true;
        localAudioTrackRef.current = localAudioTrack;
        if (shareAudioMutedRef.current) await localAudioTrack.mute();
        await currentRoom.localParticipant.publishTrack(localAudioTrack, {
          source: Track.Source.ScreenShareAudio
        });
        console.info('[PartilharTela] Áudio publicado no LiveKit.');
      } else if (audioModeRef.current !== 'none') {
        setErrorMessage('A fonte escolhida não entregou áudio; a transmissão segue só com a imagem.');
      }

      await currentRoom.localParticipant.publishTrack(localVideoTrack, {
        source: Track.Source.ScreenShare,
        simulcast: false,
        videoEncoding: { maxBitrate: settings.bitrate, maxFramerate: settings.fps },
        degradationPreference: motion ? 'maintain-framerate' : 'maintain-resolution'
      });

      console.info('[PartilharTela] Tela publicada no LiveKit.');
      setSelectedSourceId(sourceId);
      setIsShareModalOpen(false);
    } catch (err) {
      await stopApplicationAudio();
      await unpublishLocalTrack(localAudioTrackRef, currentRoom);
      await unpublishLocalTrack(localVideoTrackRef, currentRoom);
      mediaStream?.getTracks().forEach((t) => t.stop());

      const msg = err instanceof Error ? err.message : 'Não foi possível capturar a fonte selecionada.';
      console.error('[PartilharTela] Falha ao compartilhar:', err);
      setErrorMessage(
        msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('notallowed')
          ? 'Permissão de captura negada. Escolha uma tela ou janela e tente novamente.'
          : `Falha ao compartilhar: ${msg}`
      );
      setIsShareModalOpen(false);
    } finally {
      publishingRef.current = false;
      setBusy(null);
    }
  }

  async function openShareModal() {
    setErrorMessage('');
    setIsShareModalOpen(true);
    await loadSources();
  }

  async function stopSharing() {
    const currentRoom = roomRef.current;
    await unpublishLocalTrack(localVideoTrackRef, currentRoom);
    await unpublishLocalTrack(localAudioTrackRef, currentRoom);
    await stopApplicationAudio();
    shareAudioMutedRef.current = false;
  }

  async function handleStop() {
    setBusy('stop');
    try {
      await stopSharing();
    } finally {
      setBusy(null);
    }
  }

  async function toggleShareAudio() {
    const currentRoom = roomRef.current;
    if (!currentRoom) return;
    const next = !snapshot.local.audioMuted;
    setBusy('audio');
    try {
      await setShareAudioMuted(currentRoom, next);
      shareAudioMutedRef.current = next;
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Não foi possível mudar o som da transmissão.');
    } finally {
      setBusy(null);
    }
  }

  async function leaveRoom() {
    await leaveFullscreen();
    await stopSharing();
    const currentRoom = roomRef.current;
    resetRoomState();
    setHomeCode('');
    setHomeError('');
    await currentRoom?.disconnect();
  }

  async function copyInvite() {
    const text = webAppUrl ? `${webAppUrl}/?room=${roomCode}` : roomCode;
    try {
      await window.partilharTela.copyText(text);
    } catch {
      throw new Error(`Copie manualmente: ${text}`);
    }
  }

  if (view === 'home' || !room) {
    return (
      <Home
        key={`${homeCode}-${homeError}`}
        initialCode={homeCode}
        error={homeError}
        onCreate={handleCreateRoom}
        onJoin={handleJoinRoom}
      />
    );
  }

  const sharing = Boolean(snapshot.local.video);
  const currentQuality = qualities[quality];
  const reconnecting = connection === ConnectionState.Reconnecting || connection === ConnectionState.SignalReconnecting;
  const me = snapshot.members.find((m) => m.isLocal)?.name ?? 'Você';
  const selectedSource = sources.find((s) => s.id === selectedSourceId);
  const sourceName = selectedSource?.type === 'screen' ? 'sua tela' : selectedSource?.name;

  return (
    <div className="room-shell">
      <RoomSidebar
        code={roomCode}
        members={snapshot.members}
        connection={connection}
        copyLabel={webAppUrl ? 'Copiar link de convite' : 'Copiar código'}
        onCopy={copyInvite}
        onLeave={() => void leaveRoom()}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
      />
      {panelOpen && <button type="button" className="side-backdrop" aria-label="Fechar painel da sala" onClick={() => setPanelOpen(false)} />}

      <main className="room-main">
        <header className="room-head">
          <button type="button" className="icon-btn only-narrow" onClick={() => setPanelOpen(true)} aria-label="Código da sala e participantes">
            <UsersIcon />
          </button>
          <h1>
            Sala {roomCode}
            <span> {snapshot.members.length} {snapshot.members.length === 1 ? 'pessoa' : 'pessoas'}</span>
          </h1>
          <button type="button" className="btn btn-quiet" aria-pressed={statsOpen} onClick={() => setStatsOpen((v) => !v)}>
            <StatsIcon size={16} />{statsOpen ? 'Ocultar estatísticas' : 'Estatísticas'}
          </button>
        </header>

        <div className="banners">
          {reconnecting && (
            <p className="notice notice-warn" role="status"><span className="spinner" aria-hidden="true" />Conexão instável. Reconectando à sala…</p>
          )}
          {errorMessage && (
            <p className="notice notice-error" role="alert">
              <AlertIcon size={18} />
              <span>{errorMessage}</span>
              <button type="button" className="btn btn-quiet" onClick={() => setErrorMessage('')}>Ok</button>
            </p>
          )}
        </div>

        <Stage
          streams={snapshot.streams}
          audio={snapshot.audio}
          local={snapshot.local.video ? { track: snapshot.local.video, name: me } : undefined}
          overlayExtra={statsOpen ? <StatsOverlay stats={stats} fallback={`${currentQuality.width}x${currentQuality.height}`} /> : undefined}
          empty={
            <div className="stage-empty">
              <ScreenIcon size={36} />
              <h2>Ninguém está transmitindo</h2>
              <p>Clique em <strong>Compartilhar tela</strong> ou passe o código <strong>{roomCode}</strong> para alguém transmitir.</p>
            </div>
          }
        />

        <Dock
          local={snapshot.local}
          sourceName={sharing ? sourceName : undefined}
          busy={busy}
          quality={quality}
          motion={motion}
          audioMode={audioMode}
          audioProcesses={audioProcesses}
          excludedAudioProcessId={excludedAudioProcessId}
          onQuality={(q) => {
            setQuality(q);
            if (sharing) void publishScreen(selectedSourceId, q);
          }}
          onMotion={(m) => {
            setMotion(m);
            const track = localVideoTrackRef.current?.mediaStreamTrack;
            if (track) track.contentHint = m ? 'motion' : 'detail';
          }}
          onAudio={(a) => {
            setAudioMode(a);
            audioModeRef.current = a;
            if (a === 'system-excluding-discord' && audioProcesses.length === 0) {
              void loadAudioProcesses().then(() => {
                if (sharing && excludedAudioProcessIdRef.current) void publishScreen();
              });
              return;
            }
            if (sharing) void publishScreen();
          }}
          onExcludedAudio={(pid) => {
            setExcludedAudioProcessId(pid);
            excludedAudioProcessIdRef.current = pid;
            if (sharing && pid) void publishScreen();
          }}
          onShare={() => void openShareModal()}
          onStop={() => void handleStop()}
          onToggleAudio={() => void toggleShareAudio()}
        />
      </main>

      {isShareModalOpen && (
        <ShareModal
          sources={sources}
          selectedSource={selectedSourceId}
          loading={loadingSources}
          publishing={busy === 'publish'}
          preferWindows={audioMode === 'application'}
          onClose={() => setIsShareModalOpen(false)}
          onRefresh={() => void loadSources()}
          onSelect={(id) => {
            setSelectedSourceId(id);
            void publishScreen(id);
          }}
        />
      )}
    </div>
  );
}

export default App;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
