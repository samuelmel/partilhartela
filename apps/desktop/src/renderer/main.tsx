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
  GearIcon,
  LeaveIcon,
  RefreshIcon,
  ScreenIcon,
  StatsIcon,
  StopIcon,
  SwapIcon,
  UsersIcon,
  VolumeIcon,
  VolumeOffIcon
} from '../../../../shared/ui/icons';
import { Avatar } from '../../../../shared/ui/Avatar';
import { ConfirmDialog } from '../../../../shared/ui/ConfirmDialog';
import { qualities, qualityKeys, isQualityKey, type QualityKey } from '../../../../shared/ui/qualities';
import {
  describeConnectError,
  setShareAudioMuted,
  useConnectionState,
  useRoomSnapshot,
  type LocalShare
} from '../../../../shared/ui/roomState';
import { RoomSidebar } from '../../../../shared/ui/RoomSidebar';
import { RpgControl } from '../../../../shared/ui/RpgControl';
import { useRpgMode } from '../../../../shared/ui/rpgMode';
import { Stage } from '../../../../shared/ui/Stage';
import { announceScreenRepublish, attachShareSounds } from '../../../../shared/ui/shareSounds';
import { leaveFullscreen } from '../../../../shared/ui/useFullscreen';
import '../../../../shared/ui/base.css';
import '../../../../shared/ui/room.css';
import './styles.css';
import { useDiscordSession, type DiscordUser } from './discordSession';

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

/** `hostKey` só vem para quem criou a sala: autoriza o modo RPG. */
type RoomGrant = { code: string; roomName: string; token: string; livekitUrl: string; hostKey?: string };

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
const videoCodecKey = 'partilhartela.videoCodec';

type VideoCodecKey = 'h264' | 'vp8' | 'vp9' | 'av1';

const videoCodecs: Array<{ value: VideoCodecKey; label: string; mimeType: string }> = [
  { value: 'h264', label: 'H.264', mimeType: 'video/h264' },
  { value: 'vp8', label: 'VP8', mimeType: 'video/vp8' },
  { value: 'vp9', label: 'VP9', mimeType: 'video/vp9' },
  { value: 'av1', label: 'AV1', mimeType: 'video/av1' }
];

function isVideoCodecKey(value: string): value is VideoCodecKey {
  return videoCodecs.some((c) => c.value === value);
}

/** Codecs que este Electron consegue enviar via WebRTC. */
function supportedVideoCodecs(): Set<VideoCodecKey> {
  const mimeTypes = new Set(
    (RTCRtpSender.getCapabilities?.('video')?.codecs ?? []).map((c) => c.mimeType.toLowerCase())
  );
  return new Set(videoCodecs.filter((c) => mimeTypes.has(c.mimeType)).map((c) => c.value));
}

function readVideoCodec(): VideoCodecKey {
  try {
    const value = window.localStorage.getItem(videoCodecKey) ?? '';
    return isVideoCodecKey(value) ? value : 'h264';
  } catch {
    return 'h264';
  }
}

function storeVideoCodec(value: VideoCodecKey): void {
  try {
    window.localStorage.setItem(videoCodecKey, value);
  } catch {
    // Sem armazenamento: volta para H.264 na próxima abertura.
  }
}

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

/** O servidor recusou a sessão do Discord (401): ela precisa ser apagada e o login refeito. */
class SessionExpiredError extends Error {}

async function postJson<T>(endpoint: string, data: unknown, sessionToken?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${tokenServer}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
      body: JSON.stringify(data)
    });
  } catch {
    throw new Error(`Não foi possível acessar o servidor de salas (${tokenServer}). Verifique sua internet ou tente novamente.`);
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as { error?: string } | null;
    if (response.status === 401) throw new SessionExpiredError(errorBody?.error ?? 'Sua sessão do Discord expirou. Entre de novo.');
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
  notice,
  discordUser,
  discordLoading,
  onCreate,
  onJoin,
  onDiscordLogin,
  onDiscordLogout,
  onJoinVoice
}: {
  initialCode: string;
  error: string;
  /** Entrada em andamento vinda de um link partilhartela://join. */
  notice: string;
  discordUser?: DiscordUser;
  discordLoading: boolean;
  onCreate: (nickname: string) => Promise<void>;
  onJoin: (code: string, nickname: string) => Promise<void>;
  onDiscordLogin: () => Promise<void>;
  onDiscordLogout: () => Promise<void>;
  onJoinVoice: () => Promise<void>;
}) {
  const [nickname, setNickname] = useState(readNickname);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState<'create' | 'join' | 'discord' | 'voice' | null>(null);
  const [localError, setLocalError] = useState('');
  const [nicknameMissing, setNicknameMissing] = useState(false);
  const shownError = localError || error;

  async function runDiscord(kind: 'discord' | 'voice') {
    setLocalError('');
    setBusy(kind);
    try {
      if (kind === 'discord') await onDiscordLogin();
      else await onJoinVoice();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Não foi possível falar com o Discord.');
    } finally {
      setBusy(null);
    }
  }

  async function run(kind: 'create' | 'join') {
    // Com login, o nome vem do Discord (o servidor ignora o apelido).
    const name = discordUser?.name ?? nickname.trim();
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
    if (!discordUser) storeNickname(name);
    setBusy(kind);
    try {
      if (kind === 'create') await onCreate(name);
      else await onJoin(normalized, name);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Não foi possível entrar na sala.');
      setBusy(null);
    }
  }

  const working = busy !== null || Boolean(notice);

  return (
    <div className="d-home">
      <header className="d-home-head">
        <span className="brand"><BrandMark />PartilharTela</span>
      </header>
      <main className="d-home-body">
        <section className="d-start" aria-labelledby="start-title">
          <h1 id="start-title">Compartilhe sua tela</h1>
          <p className="d-lead">Crie uma sala e passe o código. Quem entrar assiste por este app ou pelo navegador.</p>

          <div className="d-discord">
            {discordUser ? (
              <>
                <div className="d-discord-user">
                  <Avatar identity={discordUser.id} name={discordUser.name} url={discordUser.avatarUrl} />
                  <span className="d-discord-name">
                    <strong>{discordUser.name}</strong>
                    <span>Conectado com o Discord</span>
                  </span>
                  <button type="button" className="btn btn-quiet" onClick={() => void onDiscordLogout()} disabled={working}>
                    Sair
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-lg btn-block"
                  onClick={() => void runDiscord('voice')}
                  disabled={working}
                  aria-busy={busy === 'voice'}
                >
                  {busy === 'voice' ? <span className="spinner" aria-hidden="true" /> : <UsersIcon size={18} />}
                  {busy === 'voice' ? 'Procurando sua call…' : 'Entrar na call atual'}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-lg btn-block"
                onClick={() => void runDiscord('discord')}
                disabled={working || discordLoading}
                aria-busy={busy === 'discord'}
              >
                {busy === 'discord' && <span className="spinner" aria-hidden="true" />}
                {busy === 'discord' ? 'Aguardando o Discord no navegador…' : 'Entrar com Discord'}
              </button>
            )}
          </div>

          {!discordUser && <div className="field">
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
          </div>}

          <button
            type="button"
            className={`btn btn-lg btn-block ${discordUser ? '' : 'btn-primary'}`}
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
            {notice && <p className="notice notice-ok" role="status"><span className="spinner" aria-hidden="true" />{notice}</p>}
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
  videoCodec,
  audioMode,
  audioProcesses,
  excludedAudioProcessId,
  onQuality,
  onMotion,
  onVideoCodec,
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
  videoCodec: VideoCodecKey;
  audioMode: AudioMode;
  audioProcesses: Array<{ title: string; processId: string }>;
  excludedAudioProcessId: string;
  onQuality: (q: QualityKey) => void;
  onMotion: (m: boolean) => void;
  onVideoCodec: (c: VideoCodecKey) => void;
  onAudio: (m: AudioMode) => void;
  onExcludedAudio: (pid: string) => void;
  onShare: () => void;
  onStop: () => void;
  onToggleAudio: () => void;
}) {
  const sharing = Boolean(local.video);
  const disabled = busy !== null;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [codecSupport] = useState(supportedVideoCodecs);

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
        <button
          type="button"
          className="icon-btn"
          aria-pressed={advancedOpen}
          aria-label="Configurações avançadas"
          title="Configurações avançadas"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <GearIcon size={18} />
        </button>
        {advancedOpen && (
          <label className="dock-field">
            <span>Codificador</span>
            <select className="select select-sm" value={videoCodec} onChange={(e) => isVideoCodecKey(e.target.value) && onVideoCodec(e.target.value)} disabled={disabled}>
              {videoCodecs.map((c) => (
                <option key={c.value} value={c.value} disabled={!codecSupport.has(c.value)}>
                  {codecSupport.has(c.value) ? c.label : `${c.label} (indisponível)`}
                </option>
              ))}
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
  const [hostKey, setHostKey] = useState<string>();
  const [errorMessage, setErrorMessage] = useState('');
  const [quality, setQuality] = useState<QualityKey>('1080p30');
  const [motion, setMotion] = useState(true);
  const [videoCodec, setVideoCodec] = useState<VideoCodecKey>(readVideoCodec);
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
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [linkNotice, setLinkNotice] = useState('');
  // Link de outra sala chegou com esta aberta: pergunta antes de trocar.
  const [switchCode, setSwitchCode] = useState<string>();
  const [switching, setSwitching] = useState(false);
  const discord = useDiscordSession(tokenServer);

  const snapshot = useRoomSnapshot(room);
  const connection = useConnectionState(room);
  const rpg = useRpgMode(room, tokenServer, roomCode);

  const roomRef = useRef<Room>();
  const localVideoTrackRef = useRef<LocalVideoTrack>();
  const localAudioTrackRef = useRef<LocalAudioTrack>();
  const publishingRef = useRef(false);
  const statsHistoryRef = useRef<{ bytes: number; time: number }>();
  // Preferência de mute do apresentador; reaplicada quando a transmissão é republicada (qualidade, fonte).
  const shareAudioMutedRef = useRef(false);

  const videoCodecRef = useRef(videoCodec);
  videoCodecRef.current = videoCodec;
  const audioModeRef = useRef(audioMode);
  audioModeRef.current = audioMode;
  const excludedAudioProcessIdRef = useRef(excludedAudioProcessId);
  excludedAudioProcessIdRef.current = excludedAudioProcessId;
  const lostConnectionRef = useRef<(code: string, reason?: DisconnectReason) => void>(() => undefined);
  const viewRef = useRef(view);
  viewRef.current = view;
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;
  const joinFromLinkRef = useRef<(code: string) => void>(() => undefined);

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
    setHostKey(undefined);
    setStats({});
    setStatsOpen(false);
    setPanelOpen(false);
    setLeaveConfirmOpen(false);
    setLeaving(false);
    setIsShareModalOpen(false);
    setBusy(null);
    setErrorMessage('');
    setView('home');
  }

  lostConnectionRef.current = (code: string, reason?: DisconnectReason) => {
    void stopApplicationAudio();
    void leaveFullscreen();
    resetRoomState();
    // Sala de canal do Discord: o bot encerra quando o canal de voz esvazia.
    if (reason === DisconnectReason.ROOM_DELETED) {
      setHomeCode('');
      setHomeError(`A sala ${code} foi encerrada.`);
      return;
    }
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
        lostConnectionRef.current(data.code, reason);
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

    // Depois do connect: transmissões que já estavam na sala não tocam aviso.
    attachShareSounds(nextRoom);
    roomRef.current = nextRoom;
    setRoom(nextRoom);
    setRoomCode(data.code);
    setHostKey(data.hostKey);
    setHomeError('');
    setErrorMessage('');
    setView('room');
  }

  /** Com sessão do Discord o token sai com o id, o nome e o avatar dela. */
  async function requestGrant(endpoint: string, nickname: string): Promise<RoomGrant> {
    try {
      return await postJson<RoomGrant>(endpoint, { nickname }, discord.sessionRef.current?.sessionToken);
    } catch (err) {
      if (err instanceof SessionExpiredError) await discord.expire();
      throw err;
    }
  }

  async function handleCreateRoom(nickname: string) {
    await connectToRoom(await requestGrant('/rooms', nickname));
  }

  async function handleJoinRoom(code: string, nickname: string) {
    await connectToRoom(await requestGrant(`/rooms/${code}/token`, nickname));
  }

  async function handleJoinVoice() {
    const voice = await discord.findVoiceRoom();
    await handleJoinRoom(voice.code, discord.sessionRef.current?.user.name ?? '');
  }

  async function joinByLink(code: string) {
    const name = discord.sessionRef.current?.user.name ?? readNickname().trim();
    if (!name) {
      setHomeCode(code);
      setHomeError(`Escolha um apelido e clique em Entrar para assistir a sala ${code}.`);
      return;
    }
    setHomeError('');
    setLinkNotice(`Entrando na sala ${code}…`);
    try {
      await handleJoinRoom(code, name);
    } catch (err) {
      setHomeCode(code);
      setHomeError(err instanceof Error ? err.message : 'Não foi possível entrar na sala.');
    } finally {
      setLinkNotice('');
    }
  }

  joinFromLinkRef.current = (code: string) => {
    if (viewRef.current === 'room') {
      if (roomCodeRef.current !== code) setSwitchCode(code);
      return;
    }
    void joinByLink(code);
  };

  // Links partilhartela://join/CODIGO (botão do bot no Discord). Espera a sessão carregar para entrar com ela.
  useEffect(() => {
    if (discord.loading) return;
    const check = () => {
      void window.partilharTela.consumePendingJoin().then((code) => {
        if (code) joinFromLinkRef.current(code);
      });
    };
    check();
    return window.partilharTela.onJoinRequest(check);
  }, [discord.loading]);

  async function confirmSwitch() {
    const code = switchCode;
    if (!code) return;
    setSwitching(true);
    try {
      await leaveRoom();
    } finally {
      setSwitching(false);
      setSwitchCode(undefined);
    }
    await joinByLink(code);
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
      // Já transmitindo = republicação (qualidade, codec ou fonte): avisa a sala para não tocar "parou"/"começou".
      if (localVideoTrackRef.current) await announceScreenRepublish(currentRoom);
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

      const codec = videoCodecRef.current;
      await currentRoom.localParticipant.publishTrack(localVideoTrack, {
        source: Track.Source.ScreenShare,
        simulcast: false,
        videoCodec: codec,
        // VP9/AV1 usam SVC no LiveKit (padrão L3T3: 3 resoluções codificadas). L1T3 = uma resolução só, menos CPU.
        ...(codec === 'vp9' || codec === 'av1' ? { scalabilityMode: 'L1T3' as const } : {}),
        videoEncoding: { maxBitrate: settings.bitrate, maxFramerate: settings.fps },
        degradationPreference: motion ? 'maintain-framerate' : 'maintain-resolution'
      });

      console.info('[PartilharTela] Tela publicada no LiveKit com codec', codec);
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

  function requestLeave() {
    setLeaveConfirmOpen(true);
  }

  async function confirmLeave() {
    setLeaving(true);
    try {
      await leaveRoom();
    } finally {
      setLeaving(false);
      setLeaveConfirmOpen(false);
    }
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
        notice={linkNotice}
        discordUser={discord.session?.user}
        discordLoading={discord.loading}
        onCreate={handleCreateRoom}
        onJoin={handleJoinRoom}
        onDiscordLogin={discord.login}
        onDiscordLogout={discord.logout}
        onJoinVoice={handleJoinVoice}
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
        onLeave={requestLeave}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
      >
        {hostKey && <RpgControl tokenServer={tokenServer} code={roomCode} hostKey={hostKey} rpg={rpg} />}
      </RoomSidebar>
      {panelOpen && <button type="button" className="side-backdrop" aria-label="Fechar painel da sala" onClick={() => setPanelOpen(false)} />}

      <main className="room-main">
        <header className="room-head">
          <button
            type="button"
            className="room-brand"
            onClick={requestLeave}
            aria-label="Voltar ao início (sair da sala)"
            title="Voltar ao início"
          >
            <BrandMark size={24} />
          </button>
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
          <button type="button" className="btn btn-quiet only-wide" onClick={requestLeave}>
            <LeaveIcon size={16} />Sair da sala
          </button>
          <button type="button" className="icon-btn only-narrow" onClick={requestLeave} aria-label="Sair da sala">
            <LeaveIcon />
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
          rpg={rpg}
          names={Object.fromEntries(snapshot.members.map((m) => [m.identity, m.name]))}
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
          videoCodec={videoCodec}
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
          onVideoCodec={(c) => {
            setVideoCodec(c);
            videoCodecRef.current = c;
            storeVideoCodec(c);
            if (sharing) void publishScreen(selectedSourceId);
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

      <ConfirmDialog
        open={leaveConfirmOpen}
        title="Sair da sala?"
        description={`Você vai sair da sala ${roomCode}. Se estiver transmitindo, a transmissão é encerrada para todos.`}
        confirmLabel="Sair da sala"
        busy={leaving}
        onConfirm={() => void confirmLeave()}
        onCancel={() => setLeaveConfirmOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(switchCode)}
        title="Trocar de sala?"
        description={`Você vai sair da sala ${roomCode} e entrar na sala ${switchCode ?? ''}. Se estiver transmitindo, a transmissão é encerrada.`}
        confirmLabel="Trocar de sala"
        busy={switching}
        onConfirm={() => void confirmSwitch()}
        onCancel={() => setSwitchCode(undefined)}
      />
    </div>
  );
}

export default App;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
