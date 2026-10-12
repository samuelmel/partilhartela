import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track
} from 'livekit-client';
import './styles.css';

declare global {
  interface Window {
    partilharTela?: {
      getSources: () => Promise<CaptureSource[]>;
      getAudioProcesses: () => Promise<Array<{ title: string; processId: string }>>;
      setCaptureSource: (sourceId: string) => Promise<void>;
      copyText: (text: string) => Promise<void>;
      startApplicationAudio: (processId: string) => Promise<void>;
      startSystemAudioExcluding: (processId: string) => Promise<void>;
      stopApplicationAudio: () => Promise<void>;
      onAudioData: (listener: (chunk: Uint8Array) => void) => () => void;
    };
  }
}

type ViewMode = 'home' | 'join' | 'presenter' | 'viewer';
type AudioMode = 'none' | 'system' | 'application' | 'system-excluding-discord';

type CaptureSource = {
  id: string;
  type: 'screen' | 'window';
  name: string;
  thumbnail: string;
  appIcon: string | null;
  processId?: string;
};

type QualityPreset = {
  label: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
};

const qualities: Record<string, QualityPreset> = {
  '720p30': { label: '720p 30fps', width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
  '1080p30': { label: '1080p 30fps', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  '1080p60': { label: '1080p 60fps', width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 }
};

type VideoStreamItem = {
  id: string;
  identity: string;
  name: string;
  track: RemoteVideoTrack;
  local?: boolean;
};

type ParticipantItem = {
  identity: string;
  name: string;
};

type AudioSettings = {
  volume: number;
  muted: boolean;
};

type WebRtcStats = {
  rttMs?: number;
  fps?: number;
  bitrateKbps?: number;
  resolution?: string;
  encoder?: string;
  packetLoss?: number;
};

const tokenServer = import.meta.env.VITE_TOKEN_SERVER_URL ?? 'http://localhost:8787';

async function postJson<T = any>(endpoint: string, data: any): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${tokenServer}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch {
    throw new Error('Servidor local indisponível. Execute "npm run dev:desktop" na pasta do projeto.');
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error ?? 'Servidor indisponível.');
  }

  return response.json();
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
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
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

  await starter();

  const track = destination.stream.getAudioTracks()[0];
  const localTrack = new LocalAudioTrack(track);

  track.addEventListener('ended', () => {
    unsubscribe();
    void audioContext.close();
  });

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
  if (trackRef.current && room) {
    try {
      await room.localParticipant.unpublishTrack(trackRef.current);
      trackRef.current.stop();
    } catch (err) {
      console.warn('[PartilharTela] Erro ao despublicar track:', err);
    } finally {
      trackRef.current = undefined;
    }
  }
}

async function readWebRtcStats(
  room: Room,
  statsHistoryRef: React.MutableRefObject<{ bytes: number; time: number } | undefined>,
  setStats: React.Dispatch<React.SetStateAction<WebRtcStats>>
) {
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

async function toggleFullscreen(element: HTMLElement | null) {
  if (!element) return;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await element.requestFullscreen();
  }
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="error">{message}</p>;
}

function Topbar({
  roomCode,
  viewerCount,
  connectionState,
  statsOpen,
  onToggleSidebar,
  onToggleStats,
  onCopy
}: {
  roomCode: string;
  viewerCount: number;
  connectionState: string;
  statsOpen: boolean;
  onToggleSidebar: () => void;
  onToggleStats: () => void;
  onCopy: () => void;
}) {
  return (
    <header className="topbar">
      <button className="icon-button" onClick={onToggleSidebar} aria-label="Mostrar ou ocultar participantes">
        ☰
      </button>
      <div className="brand compact">
        <span className="brand-mark" aria-hidden="true">◈</span>
        <strong>PartilharTela</strong>
      </div>
      <div className="room-meta">
        <span>Sala <strong>{roomCode}</strong></span>
        <button className="small" onClick={onCopy}>Copiar</button>
        <span className={connectionState === 'Reconectando...' ? 'connection warning' : 'connection'}>
          ● {connectionState}
        </span>
        <span>{viewerCount} participante{viewerCount === 1 ? '' : 's'}</span>
        <button
          className={`small ${statsOpen ? 'active' : ''}`}
          onClick={onToggleStats}
          aria-label={statsOpen ? 'Ocultar estatísticas' : 'Mostrar estatísticas'}
        >
          ▣ Estatísticas
        </button>
      </div>
    </header>
  );
}

function Sidebar({
  nickname,
  participants,
  streams
}: {
  nickname: string;
  participants: ParticipantItem[];
  streams: VideoStreamItem[];
}) {
  const liveIdentities = new Set(streams.filter((s) => !s.local).map((s) => s.identity).filter(Boolean));

  return (
    <aside className="sidebar">
      <div className="sidebar-title">
        <span>Participantes</span>
        <strong>{participants.length + 1}</strong>
      </div>
      <div className="participant-list">
        <div className="participant">
          <span className="status-dot" />
          {nickname.trim() || 'Você'}
          <span className="participant-muted">você</span>
        </div>
        {participants.map((p) => (
          <div key={p.identity} className="participant">
            <span className={`status-dot ${liveIdentities.has(p.identity) ? 'live' : ''}`} />
            {p.name || p.identity}
            {liveIdentities.has(p.identity) && <span className="live-mini">AO VIVO</span>}
          </div>
        ))}
      </div>
    </aside>
  );
}

function LocalTile({
  name,
  previewRef,
  previewStream,
  previewVersion,
  streamId,
  onFocus
}: {
  name: string;
  previewRef: React.RefObject<HTMLVideoElement>;
  previewStream: MediaStream | undefined;
  previewVersion: number;
  streamId: string;
  onFocus: () => void;
}) {
  useEffect(() => {
    const el = previewRef.current;
    if (!el || !previewStream) return;
    let cancelled = false;

    const play = () => {
      if (cancelled) return;
      el.muted = true;
      el.playsInline = true;
      el.autoplay = true;
      if (el.srcObject !== previewStream) {
        el.srcObject = previewStream;
      }
      el.play().catch((err) => {
        console.warn('[PartilharTela] Não foi possível iniciar o preview local:', err);
      });
    };

    el.addEventListener('loadedmetadata', play);
    play();
    const timer = window.setTimeout(play, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      el.removeEventListener('loadedmetadata', play);
    };
  }, [previewRef, previewStream, previewVersion]);

  return (
    <div
      className="video-tile local-tile"
      data-stream-id={streamId}
      onClick={onFocus}
      onDoubleClick={(e) => void toggleFullscreen(e.currentTarget)}
    >
      <video ref={previewRef} autoPlay muted playsInline />
      <div className="tile-gradient" />
      <div className="tile-caption">
        <span>{name}</span>
        <b>AO VIVO</b>
      </div>
      <button
        className="tile-fullscreen"
        onClick={(e) => {
          e.stopPropagation();
          void toggleFullscreen(e.currentTarget.parentElement);
        }}
        aria-label="Alternar tela cheia"
      >
        ⛶
      </button>
    </div>
  );
}

function RemoteTile({
  name,
  identity,
  track,
  audioTrack,
  audioSettings,
  onAudioSettings,
  streamId,
  onFocus
}: {
  name: string;
  identity: string;
  track: RemoteVideoTrack;
  audioTrack?: RemoteAudioTrack;
  audioSettings?: AudioSettings;
  onAudioSettings: (settings: AudioSettings) => void;
  streamId: string;
  onFocus: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const volume = audioSettings?.volume ?? 1;
  const muted = audioSettings?.muted ?? false;
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <div
      className="video-tile"
      data-stream-id={streamId}
      onClick={onFocus}
      onDoubleClick={(e) => void toggleFullscreen(e.currentTarget)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      <video ref={videoRef} autoPlay playsInline />
      <div className="tile-gradient" />
      <div className="tile-caption">
        <span>{name || identity}</span>
        <b>AO VIVO</b>
      </div>
      <div className="tile-actions">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(true);
          }}
          aria-label="Configurações de áudio"
        >
          🔊
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onFocus();
          }}
          aria-label="Focar neste vídeo"
        >
          ◉
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            void toggleFullscreen(e.currentTarget.parentElement?.parentElement ?? null);
          }}
          aria-label="Alternar tela cheia"
        >
          ⛶
        </button>
      </div>

      {menuOpen && (
        <div
          className="audio-context-menu"
          role="menu"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <strong>Áudio de {name || identity}</strong>
          {audioTrack ? (
            <>
              <button
                type="button"
                onClick={() => onAudioSettings({ volume, muted: !muted })}
              >
                {muted ? 'Ativar áudio' : 'Mutar'}
              </button>
              <label>
                Volume
                <input
                  aria-label={`Volume da transmissão de ${name || identity}`}
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={muted ? 0 : volume}
                  onChange={(e) => onAudioSettings({ volume: Number(e.target.value), muted: false })}
                />
              </label>
            </>
          ) : (
            <span className="audio-unavailable">Esta transmissão ainda não tem áudio.</span>
          )}
          <button type="button" onClick={() => setMenuOpen(false)}>
            Fechar
          </button>
        </div>
      )}
    </div>
  );
}

function StatsOverlay({ stats, fallback }: { stats: WebRtcStats; fallback: string }) {
  return (
    <div className="stats-overlay">
      <strong>Estatísticas</strong>
      <span>Resolução <b>{stats.resolution ?? fallback}</b></span>
      <span>FPS <b>{stats.fps ?? '--'}</b></span>
      <span>Codec <b>{stats.encoder ?? '--'}</b></span>
      <span>Bitrate <b>{stats.bitrateKbps ? `${stats.bitrateKbps} kbps` : '--'}</b></span>
      <span>RTT <b>{stats.rttMs !== undefined ? `${stats.rttMs} ms` : '--'}</b></span>
    </div>
  );
}

function EmptyStage({
  canShare,
  roomCode,
  onShare
}: {
  canShare: boolean;
  roomCode: string;
  onShare: () => void;
}) {
  return (
    <div className="empty-stage">
      <div className="empty-icon" aria-hidden="true">▧</div>
      <h2>Ninguém está transmitindo</h2>
      <p>
        {canShare ? (
          <>Clique em <strong>Compartilhar tela</strong> para começar.</>
        ) : (
          <>Aguardando alguém compartilhar a tela na sala <strong>{roomCode}</strong>.</>
        )}
      </p>
      {canShare && (
        <button className="primary" onClick={onShare} aria-label="Compartilhar sua tela">
          Iniciar compartilhamento
        </button>
      )}
    </div>
  );
}

function Controls({
  quality,
  motion,
  audioMode,
  audioProcesses,
  excludedAudioProcessId,
  isSharing,
  onQuality,
  onMotion,
  onAudio,
  onExcludedAudio,
  onShare,
  onStop
}: {
  quality: string;
  motion: boolean;
  audioMode: AudioMode;
  audioProcesses: Array<{ title: string; processId: string }>;
  excludedAudioProcessId: string;
  isSharing: boolean;
  onQuality: (q: string) => void;
  onMotion: (m: boolean) => void;
  onAudio: (m: AudioMode) => void;
  onExcludedAudio: (pid: string) => void;
  onShare: () => void;
  onStop: () => void;
}) {
  return (
    <footer className="controls">
      <div className="control-actions">
        {isSharing ? (
          <>
            <button onClick={onShare}>↔ Trocar fonte</button>
            <button className="danger" onClick={onStop}>■ Parar</button>
          </>
        ) : (
          <button className="primary" onClick={onShare} aria-label="Compartilhar tela">
            ▣ Compartilhar tela
          </button>
        )}
      </div>

      <label>
        Qualidade
        <select value={quality} onChange={(e) => onQuality(e.target.value)} aria-label="Qualidade da transmissão">
          <option value="720p30">720p30</option>
          <option value="1080p30">1080p30</option>
          <option value="1080p60">1080p60</option>
        </select>
      </label>

      <label>
        Modo
        <select
          value={motion ? 'motion' : 'detail'}
          onChange={(e) => onMotion(e.target.value === 'motion')}
          aria-label="Modo de captura de vídeo"
        >
          <option value="motion">Movimento / jogos</option>
          <option value="detail">Texto / código</option>
        </select>
      </label>

      <label>
        Áudio
        <select
          value={audioMode}
          onChange={(e) => onAudio(e.target.value as AudioMode)}
          aria-label="Modo de captura de áudio"
        >
          <option value="none">Sem áudio</option>
          <option value="system">Todo o sistema</option>
          <option value="application">Janela escolhida</option>
          <option value="system-excluding-discord">Sistema, exceto processo</option>
        </select>
      </label>

      {audioMode === 'system-excluding-discord' && (
        <label>
          Excluir
          <select
            value={excludedAudioProcessId}
            onChange={(e) => onExcludedAudio(e.target.value)}
            aria-label="Processo de áudio para excluir"
          >
            <option value="">Escolha</option>
            {audioProcesses.map((p) => (
              <option key={p.processId} value={p.processId}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      )}
    </footer>
  );
}

function ShareModal({
  sources,
  selectedSource,
  loading,
  error,
  onClose,
  onRefresh,
  onSelect
}: {
  sources: CaptureSource[];
  selectedSource: string;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<'screens' | 'windows'>('screens');
  const filtered = sources.filter((s) => (tab === 'screens' ? s.type === 'screen' : s.type === 'window'));

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="share-modal">
        <div className="modal-header">
          <div>
            <h2>Escolha a fonte</h2>
            <p className="muted">Selecione uma tela ou janela para transmitir.</p>
          </div>
          <button className="close" onClick={onClose} aria-label="Fechar">
            ×
          </button>
        </div>

        <div className="source-tabs">
          <button className={tab === 'screens' ? 'active' : ''} onClick={() => setTab('screens')}>
            Telas
          </button>
          <button className={tab === 'windows' ? 'active' : ''} onClick={() => setTab('windows')}>
            Janelas
          </button>
        </div>

        {loading ? (
          <p className="muted">Carregando fontes...</p>
        ) : filtered.length === 0 ? (
          <div className="empty-sources">
            <p>Nenhuma fonte encontrada nesta aba.</p>
            <button onClick={onRefresh}>Atualizar</button>
          </div>
        ) : (
          <div className="sources">
            {filtered.map((s) => (
              <button
                key={s.id}
                className={`source ${selectedSource === s.id ? 'selected' : ''}`}
                onClick={() => onSelect(s.id)}
              >
                <img src={s.thumbnail} alt="" />
                <span>{s.name}</span>
                {selectedSource === s.id && <b>Selecionada</b>}
              </button>
            ))}
          </div>
        )}

        <ErrorBanner message={error} />
      </section>
    </div>
  );
}

function RemoteAudioRenderer({
  tracks,
  settings
}: {
  tracks: Record<string, RemoteAudioTrack>;
  settings: Record<string, AudioSettings>;
}) {
  return (
    <div className="remote-audio-renderer" aria-hidden="true">
      {Object.entries(tracks).map(([identity, track]) => (
        <RemoteAudioItem
          key={`${identity}-${track.sid}`}
          identity={identity}
          track={track}
          settings={settings[identity]}
        />
      ))}
    </div>
  );
}

function RemoteAudioItem({
  identity,
  track,
  settings
}: {
  identity: string;
  track: RemoteAudioTrack;
  settings?: AudioSettings;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    track.attach(el);
    el.autoplay = true;
    el.preload = 'auto';

    const play = () => {
      el.play().catch((err) => {
        console.warn(`[PartilharTela] Reprodução da faixa de áudio de ${identity} aguardando desbloqueio:`, err);
      });
    };

    el.addEventListener('canplay', play);
    el.addEventListener('loadeddata', play);
    play();
    const interval = window.setInterval(play, 300);

    return () => {
      window.clearInterval(interval);
      el.removeEventListener('canplay', play);
      el.removeEventListener('loadeddata', play);
      track.detach(el);
    };
  }, [identity, track]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.muted = settings?.muted ?? false;
      audioRef.current.volume = settings?.muted ? 0 : settings?.volume ?? 1;
    }
  }, [settings]);

  return <audio ref={audioRef} autoPlay preload="auto" />;
}

export function App() {
  const [view, setView] = useState<ViewMode>('home');
  const [nickname, setNickname] = useState('');
  const [joinRoomCode, setJoinRoomCode] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [quality, setQuality] = useState('1080p30');
  const [motion, setMotion] = useState(true);
  const [audioMode, setAudioMode] = useState<AudioMode>('none');
  const [audioProcesses, setAudioProcesses] = useState<Array<{ title: string; processId: string }>>([]);
  const [excludedAudioProcessId, setExcludedAudioProcessId] = useState('');
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [videoStreams, setVideoStreams] = useState<VideoStreamItem[]>([]);
  const [participants, setParticipants] = useState<ParticipantItem[]>([]);
  const [audioTracks, setAudioTracks] = useState<Record<string, RemoteAudioTrack>>({});
  const [audioSettings, setAudioSettings] = useState<Record<string, AudioSettings>>({});
  const [stats, setStats] = useState<WebRtcStats>({});
  const [connectionState, setConnectionState] = useState('Conectado');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [statsOpen, setStatsOpen] = useState(false);
  const [focusedStreamId, setFocusedStreamId] = useState<string>();
  const [previewVersion, setPreviewVersion] = useState(0);

  const roomRef = useRef<Room>();
  const localPreviewVideoRef = useRef<HTMLVideoElement>(null);
  const localPreviewStreamRef = useRef<MediaStream>();
  const localVideoTrackRef = useRef<LocalVideoTrack>();
  const localAudioTrackRef = useRef<LocalAudioTrack>();
  const publishingRef = useRef(false);
  const statsHistoryRef = useRef<{ bytes: number; time: number }>();

  const audioModeRef = useRef(audioMode);
  audioModeRef.current = audioMode;
  const excludedAudioProcessIdRef = useRef(excludedAudioProcessId);
  excludedAudioProcessIdRef.current = excludedAudioProcessId;

  // Cleanup room connection on unmount
  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
    };
  }, []);

  // Keyboard shortcuts (Esc, F)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFocusedStreamId(undefined);
        if (document.fullscreenElement) {
          void document.exitFullscreen();
        }
      }
      if (e.key.toLowerCase() === 'f' && focusedStreamId) {
        const tile = document.querySelector(`[data-stream-id="${focusedStreamId}"]`);
        if (tile instanceof HTMLElement) {
          void toggleFullscreen(tile);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusedStreamId]);

  // Sync participants and tracks
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;

    setParticipants(
      Array.from(room.remoteParticipants.values()).map((p) => ({
        identity: p.identity,
        name: p.name || p.identity
      }))
    );

    const nextVideos: VideoStreamItem[] = [];
    const nextAudios: Record<string, RemoteAudioTrack> = {};

    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.track?.kind === Track.Kind.Video && pub.track instanceof RemoteVideoTrack) {
          nextVideos.push({
            id: pub.track.sid ?? pub.track.mediaStreamTrack.id,
            identity: p.identity,
            name: p.name || p.identity,
            track: pub.track
          });
        }
        if (pub.track instanceof RemoteAudioTrack) {
          nextAudios[p.identity] = pub.track;
        }
      }
    }

    setVideoStreams(nextVideos);
    setAudioTracks(nextAudios);
  }, [view]);

  async function connectToRoom(
    role: 'presenter' | 'viewer',
    data: { code: string; roomName: string; token: string; livekitUrl: string }
  ) {
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: { width: 1920, height: 1080, frameRate: 30 },
        facingMode: 'user'
      },
      publishDefaults: {
        simulcast: false,
        videoCodec: 'h264'
      }
    });

    const statsInterval = window.setInterval(() => {
      readWebRtcStats(room, statsHistoryRef, setStats).catch((err) =>
        console.warn('[PartilharTela] Não foi possível ler estatísticas WebRTC:', err)
      );
    }, 2000);

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Video && track instanceof RemoteVideoTrack) {
        setVideoStreams((prev) => [
          ...prev.filter((v) => v.id !== track.sid),
          {
            id: track.sid ?? track.mediaStreamTrack.id,
            identity: participant.identity,
            name: participant.name || participant.identity,
            track
          }
        ]);
      }
      if (track.kind === Track.Kind.Audio && track instanceof RemoteAudioTrack) {
        setAudioTracks((prev) => ({ ...prev, [participant.identity]: track }));
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
      if (track.kind === Track.Kind.Video) {
        setVideoStreams((prev) => prev.filter((v) => v.id !== track.sid));
      }
      if (track.kind === Track.Kind.Audio) {
        setAudioTracks((prev) => {
          const next = { ...prev };
          for (const [id, t] of Object.entries(next)) {
            if (t.sid === track.sid) delete next[id];
          }
          return next;
        });
      }
    });

    room.on(RoomEvent.ParticipantConnected, () => {
      setViewerCount(room.remoteParticipants.size);
      setParticipants(
        Array.from(room.remoteParticipants.values()).map((p) => ({
          identity: p.identity,
          name: p.name || p.identity
        }))
      );
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      setViewerCount(room.remoteParticipants.size);
      setParticipants((prev) => prev.filter((p) => p.identity !== participant.identity));
    });

    room.on(RoomEvent.Reconnecting, () => setConnectionState('Reconectando...'));
    room.on(RoomEvent.Reconnected, () => setConnectionState('Conectado'));
    room.on(RoomEvent.Disconnected, () => {
      window.clearInterval(statsInterval);
      setConnectionState('Desconectado');
      setParticipants([]);
      setAudioTracks({});
      setAudioSettings({});
      if (view !== 'home') {
        setErrorMessage('A conexão foi perdida. Tente entrar novamente.');
      }
    });

    try {
      await room.connect(data.livekitUrl, data.token, { autoSubscribe: true });
      if ((room as any).canPlaybackAudio === false && (room as any).startAudio) {
        await (room as any).startAudio().catch((err: unknown) => {
          console.warn('[PartilharTela] O áudio remoto aguarda interação do usuário:', err);
        });
      }
    } catch {
      room.disconnect();
      throw new Error(
        'Servidor de mídia LiveKit indisponível. Inicie o Docker Desktop e execute "docker compose -f infra\\docker-compose.yml up -d".'
      );
    }

    roomRef.current = room;
    setRoomCode(data.code);
    setViewerCount(room.remoteParticipants.size);
    setView(role);
  }

  async function handleCreateRoom() {
    setErrorMessage('');
    try {
      const data = await postJson('/rooms', { nickname });
      await connectToRoom('presenter', data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Não foi possível criar a sala.');
    }
  }

  async function handleJoinRoom() {
    setErrorMessage('');
    try {
      const code = joinRoomCode.trim().toUpperCase();
      const data = await postJson(`/rooms/${code}/token`, { nickname });
      await connectToRoom('viewer', data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Não foi possível entrar na sala.');
    }
  }

  async function loadSources() {
    setLoadingSources(true);
    setErrorMessage('');
    try {
      const list = await window.partilharTela.getSources();
      // Deduplicate by source.id
      const uniqueSources = Array.from(new Map(list.map((s) => [s.id, s])).values());
      setSources(uniqueSources);
      if (!selectedSourceId && uniqueSources[0]) {
        setSelectedSourceId(uniqueSources[0].id);
      }
      if (uniqueSources.length === 0) {
        setErrorMessage('Nenhuma tela ou janela disponível para captura.');
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
      if (!excludedAudioProcessId && discord) {
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
    const room = roomRef.current;
    if (!room) {
      setErrorMessage('A sala ainda não está conectada.');
      return;
    }
    if (!sourceId) {
      setErrorMessage('Selecione uma tela ou janela para compartilhar.');
      return;
    }

    publishingRef.current = true;
    const settings = qualities[targetQuality];
    let mediaStream: MediaStream | undefined;

    try {
      await stopApplicationAudio();
      await unpublishLocalTrack(localVideoTrackRef, room);
      await unpublishLocalTrack(localAudioTrackRef, room);

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
      videoTrack.addEventListener('ended', () => {
        setIsSharing(false);
        localVideoTrackRef.current = undefined;
      }, { once: true });

      localVideoTrackRef.current = localVideoTrack;
      localPreviewStreamRef.current = mediaStream;
      setPreviewVersion((v) => v + 1);

      if (localPreviewVideoRef.current) {
        localPreviewVideoRef.current.srcObject = mediaStream;
      }

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
          throw new Error('Escolha o processo que deve ser excluído da captura.');
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
        await room.localParticipant.publishTrack(localAudioTrack, {
          source: Track.Source.ScreenShareAudio
        });
        console.info('[PartilharTela] Áudio publicado no LiveKit.');
      }

      await room.localParticipant.publishTrack(localVideoTrack, {
        source: Track.Source.ScreenShare,
        simulcast: false,
        videoEncoding: { maxBitrate: settings.bitrate, maxFramerate: settings.fps },
        degradationPreference: motion ? 'maintain-framerate' : 'maintain-resolution'
      });

      console.info('[PartilharTela] Tela publicada no LiveKit.');
      setIsSharing(true);
    } catch (err) {
      await stopApplicationAudio();
      mediaStream?.getTracks().forEach((t) => t.stop());
      localPreviewStreamRef.current = undefined;
      setPreviewVersion((v) => v + 1);

      const msg = err instanceof Error ? err.message : 'Não foi possível capturar a fonte selecionada.';
      console.error('[PartilharTela] Falha ao compartilhar:', err);
      setErrorMessage(
        msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('notallowed')
          ? 'Permissão de captura negada. Escolha uma tela ou janela e tente novamente.'
          : `Falha ao compartilhar: ${msg}`
      );
    } finally {
      publishingRef.current = false;
      setIsShareModalOpen(false);
    }
  }

  async function openShareModal() {
    setErrorMessage('');
    await loadSources();
    setIsShareModalOpen(true);
  }

  async function stopSharing() {
    const room = roomRef.current;
    await unpublishLocalTrack(localVideoTrackRef, room);
    await unpublishLocalTrack(localAudioTrackRef, room);
    await stopApplicationAudio();
    setIsSharing(false);
  }

  async function copyRoomCode() {
    try {
      await window.partilharTela.copyText(roomCode);
      setErrorMessage('Código copiado para a área de transferência.');
    } catch {
      setErrorMessage(`Não foi possível copiar o código. Selecione e copie manualmente: ${roomCode}`);
    }
  }

  // Home view
  if (view === 'home') {
    return (
      <main className="shell home" role="main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">◈</span>
          <h1>PartilharTela</h1>
          <p>Compartilhe sua tela ao vivo, sem complicação.</p>
        </div>
        <label className="home-nickname">
          Seu apelido
          <input
            value={nickname}
            maxLength={32}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Como você quer aparecer?"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && nickname.trim()) void handleCreateRoom();
            }}
            aria-label="Seu apelido na transmissão"
          />
        </label>
        <div className="actions">
          <button
            className="primary"
            disabled={!nickname.trim()}
            onClick={() => void handleCreateRoom()}
            aria-label="Criar nova sala de transmissão"
          >
            Criar sala
          </button>
          <button onClick={() => setView('join')} aria-label="Entrar em uma sala existente">
            Entrar na sala
          </button>
        </div>
        <ErrorBanner message={errorMessage} />
      </main>
    );
  }

  // Join view
  if (view === 'join') {
    return (
      <main className="shell centered" role="main">
        <section className="card">
          <button className="back" onClick={() => setView('home')}>← Voltar</button>
          <h2>Entrar em uma sala</h2>
          <p className="muted">Digite o código recebido do apresentador.</p>
          <label>
            Código da sala
            <input
              value={joinRoomCode}
              maxLength={6}
              onChange={(e) => setJoinRoomCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              aria-label="Código da sala com 6 caracteres"
            />
          </label>
          <label>
            Seu apelido
            <input
              value={nickname}
              maxLength={32}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Visitante"
              aria-label="Seu apelido na transmissão"
            />
          </label>
          <button
            className="primary full"
            disabled={joinRoomCode.length !== 6}
            onClick={() => void handleJoinRoom()}
            aria-label="Entrar na sala para assistir"
          >
            Assistir
          </button>
          <ErrorBanner message={errorMessage} />
        </section>
      </main>
    );
  }

  // Room view (Presenter / Viewer)
  const currentQualitySetting = qualities[quality];
  const canShare = view === 'presenter' || view === 'viewer';
  const allStreams: VideoStreamItem[] = [
    ...(isSharing ? [{ id: 'local', name: nickname.trim() || 'Você', track: null as any, local: true }] : []),
    ...videoStreams.map((v) => ({ ...v, local: false }))
  ];
  const focusedStream = allStreams.find((s) => s.id === focusedStreamId);

  return (
    <main className="room" role="main">
      <Topbar
        roomCode={roomCode}
        viewerCount={viewerCount}
        connectionState={connectionState}
        statsOpen={statsOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleStats={() => setStatsOpen((v) => !v)}
        onCopy={() => void copyRoomCode()}
      />

      {connectionState === 'Reconectando...' && (
        <div className="reconnecting-banner" role="status">
          ● Reconectando à sala...
        </div>
      )}

      <div className="room-body">
        {sidebarOpen && (
          <Sidebar
            nickname={nickname}
            participants={participants}
            streams={allStreams}
          />
        )}

        <section className="stage">
          {focusedStream ? (
            <div className="focus-layout">
              <div className="focus-main">
                <button
                  className="back-grid"
                  onClick={() => setFocusedStreamId(undefined)}
                  aria-label="Voltar à grade de vídeos"
                >
                  ← Voltar à grade
                </button>
                {focusedStream.local ? (
                  <LocalTile
                    name={focusedStream.name}
                    previewRef={localPreviewVideoRef}
                    previewStream={localPreviewStreamRef.current}
                    previewVersion={previewVersion}
                    streamId="local"
                    onFocus={() => {}}
                  />
                ) : (
                  <RemoteTile
                    key={focusedStream.id}
                    name={focusedStream.name}
                    identity={focusedStream.identity}
                    track={focusedStream.track}
                    audioTrack={audioTracks[focusedStream.identity]}
                    audioSettings={audioSettings[focusedStream.identity]}
                    onAudioSettings={(s) => setAudioSettings((prev) => ({ ...prev, [focusedStream.identity]: s }))}
                    streamId={focusedStream.id}
                    onFocus={() => {}}
                  />
                )}
              </div>
              <div className="focus-strip">
                {allStreams
                  .filter((s) => s.id !== focusedStream.id)
                  .map((s) =>
                    s.local ? (
                      <LocalTile
                        key={s.id}
                        name={s.name}
                        previewRef={localPreviewVideoRef}
                        previewStream={localPreviewStreamRef.current}
                        previewVersion={previewVersion}
                        streamId={s.id}
                        onFocus={() => setFocusedStreamId(s.id)}
                      />
                    ) : (
                      <RemoteTile
                        key={s.id}
                        name={s.name}
                        identity={s.identity}
                        track={s.track}
                        audioTrack={audioTracks[s.identity]}
                        audioSettings={audioSettings[s.identity]}
                        onAudioSettings={(st) => setAudioSettings((prev) => ({ ...prev, [s.identity]: st }))}
                        streamId={s.id}
                        onFocus={() => setFocusedStreamId(s.id)}
                      />
                    )
                  )}
              </div>
            </div>
          ) : (
            <div className="tile-grid">
              {allStreams.map((s) =>
                s.local ? (
                  <LocalTile
                    key={s.id}
                    name={s.name}
                    previewRef={localPreviewVideoRef}
                    previewStream={localPreviewStreamRef.current}
                    previewVersion={previewVersion}
                    streamId={s.id}
                    onFocus={() => setFocusedStreamId(s.id)}
                  />
                ) : (
                  <RemoteTile
                    key={s.id}
                    name={s.name}
                    identity={s.identity}
                    track={s.track}
                    audioTrack={audioTracks[s.identity]}
                    audioSettings={audioSettings[s.identity]}
                    onAudioSettings={(st) => setAudioSettings((prev) => ({ ...prev, [s.identity]: st }))}
                    streamId={s.id}
                    onFocus={() => setFocusedStreamId(s.id)}
                  />
                )
              )}
              {allStreams.length === 0 && (
                <EmptyStage
                  canShare={canShare}
                  roomCode={roomCode}
                  onShare={() => void openShareModal()}
                />
              )}
            </div>
          )}

          <RemoteAudioRenderer tracks={audioTracks} settings={audioSettings} />

          {statsOpen && (
            <StatsOverlay
              stats={stats}
              fallback={`${currentQualitySetting.width}x${currentQualitySetting.height}`}
            />
          )}
        </section>
      </div>

      {canShare && (
        <Controls
          quality={quality}
          motion={motion}
          audioMode={audioMode}
          audioProcesses={audioProcesses}
          excludedAudioProcessId={excludedAudioProcessId}
          isSharing={isSharing}
          onQuality={(q) => {
            setQuality(q);
            if (isSharing) void publishScreen(selectedSourceId, q);
          }}
          onMotion={setMotion}
          onAudio={(a) => {
            setAudioMode(a);
            if (a === 'system-excluding-discord' && audioProcesses.length === 0) {
              void loadAudioProcesses();
            }
          }}
          onExcludedAudio={setExcludedAudioProcessId}
          onShare={() => void openShareModal()}
          onStop={() => void stopSharing()}
        />
      )}

      {isShareModalOpen && (
        <ShareModal
          sources={sources}
          selectedSource={selectedSourceId}
          loading={loadingSources}
          error={errorMessage}
          onClose={() => setIsShareModalOpen(false)}
          onRefresh={() => void loadSources()}
          onSelect={(id) => {
            setSelectedSourceId(id);
            void publishScreen(id);
          }}
        />
      )}
    </main>
  );
}

export default App;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);