import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets
} from 'livekit-client';
import type { DesktopSource } from '../preload/preload';
import './styles.css';

const tokenServer = import.meta.env.VITE_TOKEN_SERVER_URL ?? 'http://localhost:8787';
type Quality = '720p30' | '1080p30' | '1080p60';
type AudioMode = 'none' | 'system' | 'application' | 'system-excluding-discord';
type MediaStats = {
  rttMs?: number;
  fps?: number;
  bitrateKbps?: number;
  resolution?: string;
  encoder?: string;
  packetLoss?: number;
};
type ParticipantInfo = { identity: string; name: string };
type AudioSettings = { volume: number; muted: boolean };
const qualities: Record<Quality, { width: number; height: number; fps: number; bitrate: number }> = {
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 }
};

async function requestToken(path: string, body: object): Promise<{ token: string; livekitUrl: string; code: string }> {
  let response: Response;
  try {
    response = await fetch(`${tokenServer}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error('Servidor local indisponível. Execute "npm run dev:desktop" na pasta do projeto.');
  }
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'Servidor indisponível.');
  return response.json() as Promise<{ token: string; livekitUrl: string; code: string }>;
}

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<'home' | 'join' | 'presenter' | 'viewer'>('home');
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [quality, setQuality] = useState<Quality>('1080p30');
  const [motion, setMotion] = useState(true);
  const [audioMode, setAudioMode] = useState<AudioMode>('none');
  const [audioProcesses, setAudioProcesses] = useState<Array<{ title: string; processId: string }>>([]);
  const [excludedAudioProcessId, setExcludedAudioProcessId] = useState('');
  const [sources, setSources] = useState<DesktopSource[]>([]);
  const [selectedSource, setSelectedSource] = useState('');
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [remoteTracks, setRemoteTracks] = useState<Array<{ id: string; identity: string; name: string; track: RemoteVideoTrack }>>([]);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [remoteAudioTracks, setRemoteAudioTracks] = useState<Record<string, RemoteAudioTrack>>({});
  const [audioSettings, setAudioSettings] = useState<Record<string, AudioSettings>>({});
  const [mediaStats, setMediaStats] = useState<MediaStats>({});
  const [connectionState, setConnectionState] = useState('Conectado');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [statsOpen, setStatsOpen] = useState(false);
  const [focusedStreamId, setFocusedStreamId] = useState<string>();
  const [previewVersion, setPreviewVersion] = useState(0);
  const roomRef = useRef<Room>();
  const localPreviewRef = useRef<HTMLVideoElement>(null);
  const localPreviewStreamRef = useRef<MediaStream>();
  const localVideoRef = useRef<LocalVideoTrack>();
  const localAudioRef = useRef<LocalAudioTrack>();
  const publishingRef = useRef(false);
  const statsSnapshotRef = useRef<{ bytes: number; time: number }>();
  const audioContextRef = useRef<AudioContext>();
  const audioNodeRef = useRef<AudioWorkletNode>();
  const removeAudioListenerRef = useRef<(() => void)>();
  const audioModeRef = useRef<AudioMode>(audioMode);
  const excludedAudioProcessRef = useRef(excludedAudioProcessId);

  useEffect(() => { audioModeRef.current = audioMode; }, [audioMode]);
  useEffect(() => { excludedAudioProcessRef.current = excludedAudioProcessId; }, [excludedAudioProcessId]);

  // Clean up room connection on unmount
  useEffect(() => () => { roomRef.current?.disconnect(); }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFocusedStreamId(undefined);
        if (document.fullscreenElement) void document.exitFullscreen();
      }
      if (event.key.toLowerCase() === 'f' && focusedStreamId) {
        const tile = document.querySelector(`[data-stream-id="${focusedStreamId}"]`);
        if (tile instanceof HTMLElement) void toggleFullscreen(tile);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusedStreamId]);

  // Update participant list when room changes
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    setParticipants(Array.from(room.remoteParticipants.values()).map((participant) => ({
      identity: participant.identity,
      name: participant.name || participant.identity
    })));
    const tracks: Array<{ id: string; identity: string; name: string; track: RemoteVideoTrack }> = [];
    const audioTracks: Record<string, RemoteAudioTrack> = {};
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track?.kind === Track.Kind.Video && publication.track instanceof RemoteVideoTrack) {
          tracks.push({
            id: publication.track.sid ?? publication.track.mediaStreamTrack.id,
            identity: participant.identity,
            name: participant.name || participant.identity,
            track: publication.track
          });
        }
        if (publication.track instanceof RemoteAudioTrack) audioTracks[participant.identity] = publication.track;
      }
    }
    setRemoteTracks(tracks);
    setRemoteAudioTracks(audioTracks);
  }, [screen]);

  async function connect(role: 'presenter' | 'viewer', roomInfo: { token: string; livekitUrl: string; code: string }): Promise<void> {
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h1080.resolution, facingMode: 'user' },
      // H.264 com simulcast de tela pode gerar quadro preto em alguns Chromium/Electron.
      publishDefaults: { simulcast: false, videoCodec: 'h264' }
    });
    const statsTimer = window.setInterval(() => {
      void collectStats(room).catch((reason) => console.warn('[PartilharTela] Não foi possível ler estatísticas WebRTC:', reason));
    }, 2000);
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind === Track.Kind.Video && track instanceof RemoteVideoTrack) {
        setRemoteTracks((current) => [...current.filter((item) => item.id !== track.sid), {
          id: track.sid ?? track.mediaStreamTrack.id,
          identity: participant.identity,
          name: participant.name || participant.identity,
          track
        }]);
      }
      if (track.kind === Track.Kind.Audio && track instanceof RemoteAudioTrack) {
        setRemoteAudioTracks((current) => ({ ...current, [participant.identity]: track }));
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
      if (track.kind === Track.Kind.Video) setRemoteTracks((current) => current.filter((item) => item.id !== track.sid));
      if (track.kind === Track.Kind.Audio) {
        setRemoteAudioTracks((current) => {
          const next = { ...current };
          for (const [identity, audioTrack] of Object.entries(next)) {
            if (audioTrack.sid === track.sid) {
              delete next[identity];
            }
          }
          return next;
        });
      }
    });
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      setViewerCount(room.remoteParticipants.size);
      setParticipants((current) => [
        ...current.filter((item) => item.identity !== participant.identity),
        { identity: participant.identity, name: participant.name || participant.identity }
      ]);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      setViewerCount(room.remoteParticipants.size);
      setParticipants((current) => current.filter((item) => item.identity !== participant.identity));
    });
    room.on(RoomEvent.Reconnecting, () => setConnectionState('Reconectando...'));
    room.on(RoomEvent.Reconnected, () => setConnectionState('Conectado'));
    room.on(RoomEvent.Disconnected, () => {
      window.clearInterval(statsTimer);
      setConnectionState('Desconectado');
      setParticipants([]);
      setRemoteAudioTracks({});
      setAudioSettings({});
      if (screen !== 'home') setError('A conexão foi perdida. Tente entrar novamente.');
    });
    try {
      await room.connect(roomInfo.livekitUrl, roomInfo.token, { autoSubscribe: true });
      const audioRoom = room as Room & { canPlaybackAudio?: boolean; startAudio?: () => Promise<void> };
      if (audioRoom.canPlaybackAudio === false && audioRoom.startAudio) {
        await audioRoom.startAudio().catch((reason) => {
          console.warn('[PartilharTela] O áudio remoto aguarda interação do usuário:', reason);
        });
      }
    } catch {
      room.disconnect();
      throw new Error('Servidor de mídia LiveKit indisponível. Inicie o Docker Desktop e execute "docker compose -f infra\\docker-compose.yml up -d".');
    }
    roomRef.current = room;
    setRoomCode(roomInfo.code);
    setViewerCount(room.remoteParticipants.size);
    setScreen(role);
  }

  async function createRoom(): Promise<void> {
    setError('');
    try {
      const roomInfo = await requestToken('/rooms', { nickname });
      await connect('presenter', roomInfo);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível criar a sala.'); }
  }

  async function joinRoom(): Promise<void> {
    setError('');
    try {
      const normalized = code.trim().toUpperCase();
      const roomInfo = await requestToken(`/rooms/${normalized}/token`, { nickname });
      await connect('viewer', roomInfo);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível entrar na sala.'); }
  }

  async function refreshSources(): Promise<void> {
    setLoadingSources(true);
    setError('');
    try {
      const available = await window.partilharTela.getSources();
      setSources(available);
      if (!selectedSource && available[0]) setSelectedSource(available[0].id);
      if (available.length === 0) {
        setError('Nenhuma tela ou janela disponível para captura.');
      }

    } catch (reason) {
      setError(reason instanceof Error ? `Não foi possível listar as telas e janelas disponíveis: ${reason.message}` : 'Não foi possível listar as telas e janelas disponíveis.');
    } finally {
      setLoadingSources(false);
    }
  }

  async function refreshAudioProcesses(): Promise<void> {
    try {
      const processes = await window.partilharTela.getAudioProcesses();
      setAudioProcesses(processes);
      const discord = processes.find((item) => item.title.toLowerCase().includes('discord'));
      if (!excludedAudioProcessId && discord) setExcludedAudioProcessId(discord.processId);
    } catch (reason) {
      setError(reason instanceof Error ? `Não foi possível listar os processos de áudio: ${reason.message}` : 'Não foi possível listar os processos de áudio.');
    }
  }

  async function publishScreen(sourceId = selectedSource, qualityOverride = quality): Promise<void> {
    if (publishingRef.current) return;
    const room = roomRef.current;
    if (!room) {
      setError('A sala ainda não está conectada.');
      return;
    }
    if (!sourceId) {
      setError('Selecione uma tela ou janela para compartilhar.');
      return;
    }
    publishingRef.current = true;
    const settings = qualities[qualityOverride];
    let stream: MediaStream | undefined;
    try {
      await stopApplicationAudio();
      await unpublishLocalTrack(localVideoRef, Track.Source.ScreenShare);
      await unpublishLocalTrack(localAudioRef, Track.Source.ScreenShareAudio);
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('A captura de tela não está disponível nesta janela do Electron.');
      }
      await window.partilharTela.setCaptureSource(sourceId);
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: settings.width, max: settings.width },
          height: { ideal: settings.height, max: settings.height },
          frameRate: { ideal: settings.fps, max: settings.fps }
        },
        audio: audioModeRef.current === 'system'
      });
      console.info('[PartilharTela] Fonte capturada:', sourceId);
      const rawVideo = stream.getVideoTracks()[0];
      if (!rawVideo) {
        throw new Error('A fonte selecionada não forneceu vídeo. Escolha outra tela ou janela.');
      }
      await rawVideo.applyConstraints({
        width: { ideal: settings.width, max: settings.width },
        height: { ideal: settings.height, max: settings.height },
        frameRate: { ideal: settings.fps, max: settings.fps }
      });
      console.info('[PartilharTela] Resolução capturada:', rawVideo.getSettings());
      const videoTrack = new LocalVideoTrack(rawVideo);
      rawVideo.contentHint = motion ? 'motion' : 'detail';
      rawVideo.addEventListener('ended', () => {
        setIsSharing(false);
        localVideoRef.current = undefined;
      }, { once: true });
      localVideoRef.current = videoTrack;
      localPreviewStreamRef.current = stream;
      setPreviewVersion((value) => value + 1);
      if (localPreviewRef.current) localPreviewRef.current.srcObject = stream;
      const applicationProcessId = sources.find((source) => source.id === sourceId)?.processId;
      let audioTrack: LocalAudioTrack | undefined;
      if (audioModeRef.current === 'application') {
        if (!applicationProcessId) throw new Error('Esta fonte não é uma janela de aplicativo com PID detectável. Escolha uma janela para capturar o áudio dela.');
        audioTrack = await createApplicationAudio(applicationProcessId);
      } else if (audioModeRef.current === 'system-excluding-discord') {
        await stopApplicationAudio();
        if (!excludedAudioProcessRef.current) throw new Error('Escolha o processo que deve ser excluído da captura.');
        audioTrack = await createPcmAudio(() => window.partilharTela.startSystemAudioExcluding(excludedAudioProcessRef.current));
      } else {
        audioTrack = audioModeRef.current === 'system'
        ? stream.getAudioTracks()[0] ? new LocalAudioTrack(stream.getAudioTracks()[0]) : undefined
        : undefined;
      }
      if (audioTrack) {
        audioTrack.mediaStreamTrack.enabled = true;
        localAudioRef.current = audioTrack;
        await room.localParticipant.publishTrack(localAudioRef.current, { source: Track.Source.ScreenShareAudio });
        console.info('[PartilharTela] Áudio publicado no LiveKit.');
      }
      await room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare,
        simulcast: false,
        videoEncoding: { maxBitrate: settings.bitrate, maxFramerate: settings.fps },
        degradationPreference: motion ? 'maintain-framerate' : 'maintain-resolution'
      });
      console.info('[PartilharTela] Tela publicada no LiveKit.');
    } catch (reason) {
      await stopApplicationAudio();
      stream?.getTracks().forEach((track) => track.stop());
      localPreviewStreamRef.current = undefined;
      setPreviewVersion((value) => value + 1);
      const message = reason instanceof Error ? reason.message : 'Não foi possível capturar a fonte selecionada.';
      console.error('[PartilharTela] Falha ao compartilhar:', reason);
      setError(message.toLowerCase().includes('permission') || message.toLowerCase().includes('notallowed')
        ? 'Permissão de captura negada. Escolha uma tela ou janela e tente novamente.'
        : `Falha ao compartilhar: ${message}`);
      return;
    } finally {
      publishingRef.current = false;
    }
    setIsSharing(true);
    setShareDialogOpen(false);
  }

  async function openShareDialog(): Promise<void> {
    setError('');
    await refreshSources();
    setShareDialogOpen(true);
  }

  async function stopSharing(): Promise<void> {
    await unpublishLocalTrack(localVideoRef, Track.Source.ScreenShare);
    await unpublishLocalTrack(localAudioRef, Track.Source.ScreenShareAudio);
    await stopApplicationAudio();
    setIsSharing(false);
  }

  async function copyLink(): Promise<void> {
    try {
      await window.partilharTela.copyText(roomCode);
      setError('Código copiado para a área de transferência.');
    } catch {
      setError('Não foi possível copiar o código. Selecione e copie manualmente: ' + roomCode);
    }

  }

  async function collectStats(room: Room): Promise<void> {
    const publisherReport = room.engine.pcManager?.publisher.getStats();
    const subscriberReport = room.engine.pcManager?.subscriber?.getStats();
    const reports = [publisherReport, subscriberReport].filter((report): report is Promise<RTCStatsReport> => Boolean(report));
    const snapshots = await Promise.all(reports);
    const values = snapshots.flatMap((report) => Array.from(report.values()));
    type RtpStats = RTCStats & { kind?: string; mediaType?: string };
    const isVideoRtp = (item: RTCStats): item is RtpStats => {
      const rtp = item as RtpStats;
      return rtp.kind === 'video' || rtp.mediaType === 'video';
    };
    const outboundReports = values.filter((item) => item.type === 'outbound-rtp' && isVideoRtp(item));
    const inboundReports = values.filter((item) => item.type === 'inbound-rtp' && isVideoRtp(item));
    const outbound = outboundReports[0];
    const inbound = inboundReports[0];
    const candidate = values.find((item) => item.type === 'candidate-pair' && item.state === 'succeeded');
    const codec = values.find((item) => item.type === 'codec' && item.mimeType?.toLowerCase().startsWith('video/'));
    const previous = statsSnapshotRef.current;
    const now = performance.now();
    const outboundBytes = outboundReports.reduce((total, item) => total + (typeof item.bytesSent === 'number' ? item.bytesSent : 0), 0);
    const inboundBytes = inboundReports.reduce((total, item) => total + (typeof item.bytesReceived === 'number' ? item.bytesReceived : 0), 0);
    const bytes = outboundBytes > 0 ? outboundBytes : inboundBytes > 0 ? inboundBytes : undefined;
    const elapsed = previous && bytes !== undefined ? (now - previous.time) / 1000 : 0;
    setMediaStats({
      rttMs: typeof candidate?.currentRoundTripTime === 'number' ? Math.round(candidate.currentRoundTripTime * 1000) : undefined,
      fps: typeof inbound?.framesPerSecond === 'number' ? Math.round(inbound.framesPerSecond) : typeof outbound?.framesPerSecond === 'number' ? Math.round(outbound.framesPerSecond) : undefined,
      bitrateKbps: elapsed > 0 && previous?.bytes !== undefined && bytes !== undefined ? Math.round(((bytes - previous.bytes) * 8) / elapsed / 1000) : undefined,
      resolution: typeof inbound?.frameWidth === 'number' ? `${inbound.frameWidth}x${inbound.frameHeight}` : typeof outbound?.frameWidth === 'number' ? `${outbound.frameWidth}x${outbound.frameHeight}` : undefined,
      encoder: typeof outbound?.encoderImplementation === 'string'
        ? outbound.encoderImplementation
        : typeof codec?.mimeType === 'string' ? codec.mimeType : undefined,
      packetLoss: typeof inbound?.packetsLost === 'number' ? inbound.packetsLost : undefined
    });
    if (bytes !== undefined) statsSnapshotRef.current = { bytes, time: now };
  }

  if (screen === 'home') return (
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
          onChange={(event) => setNickname(event.target.value)}
          placeholder="Como você quer aparecer?"
          onKeyDown={(event) => { if (event.key === 'Enter' && nickname.trim()) void createRoom(); }}
          aria-label="Seu apelido na transmissão"
        />
      </label>
      <div className="actions">
        <button
          className="primary"
          disabled={!nickname.trim()}
          onClick={() => void createRoom()}
          aria-label="Criar nova sala de transmissão"
        >
          Criar sala
        </button>
        <button
          onClick={() => setScreen('join')}
          aria-label="Entrar em uma sala existente"
        >
          Entrar na sala
        </button>
      </div>
      <FormError message={error} />
    </main>
  );

  if (screen === 'join') return (
    <main className="shell centered" role="main">
      <section className="card">
        <button className="back" onClick={() => setScreen('home')}>
          ← Voltar
        </button>
        <h2>Entrar em uma sala</h2>
        <p className="muted">Digite o código recebido do apresentador.</p>
        <label>
          Código da sala
          <input
            value={code}
            maxLength={6}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="ABC123"
            aria-label="Código da sala com 6 caracteres"
          />
        </label>
        <label>
          Seu apelido
          <input
            value={nickname}
            maxLength={32}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="Visitante"
            aria-label="Seu apelido na transmissão"
          />
        </label>
        <button
          className="primary full"
          disabled={code.length !== 6}
          onClick={() => void joinRoom()}
          aria-label="Entrar na sala para assistir"
        >
          Assistir
        </button>
        <FormError message={error} />
      </section>
    </main>
  );

  const selectedQuality = qualities[quality];
  const canShare = screen === 'presenter' || screen === 'viewer';
  const streams = [
    ...(isSharing ? [{ id: 'local', name: nickname.trim() || 'Você', local: true as const }] : []),
    ...remoteTracks.map((item) => ({ ...item, local: false as const }))
  ];
  const focused = streams.find((stream) => stream.id === focusedStreamId);

  return (
    <main className="room" role="main">
      <TopBar
        roomCode={roomCode}
        viewerCount={viewerCount}
        connectionState={connectionState}
        statsOpen={statsOpen}
        onToggleSidebar={() => setSidebarOpen((value) => !value)}
        onToggleStats={() => setStatsOpen((value) => !value)}
        onCopy={() => void copyLink()}
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
            streams={streams}
          />
        )}
        <section className="stage">
          {focused ? (
            <div className="focus-layout">
              <div className="focus-main">
                <button
                  className="back-grid"
                  onClick={() => setFocusedStreamId(undefined)}
                  aria-label="Voltar à grade de vídeos"
                >
                  ← Voltar à grade
                </button>
                {focused.local ? (
                  <LocalTile
                    name={focused.name}
                    previewRef={localPreviewRef}
                    previewStream={localPreviewStreamRef.current}
                    previewVersion={previewVersion}
                    streamId="local"
                    onFocus={() => undefined}
                  />
                ) : (
                  <VideoTile
                    key={focused.id}
                    name={focused.name}
                    identity={focused.identity}
                    track={focused.track}
                    audioTrack={remoteAudioTracks[focused.identity]}
                    audioSettings={audioSettings[focused.identity]}
                    onAudioSettings={(settings) => setAudioSettings((current) => ({ ...current, [focused.identity]: settings }))}
                    streamId={focused.id}
                    onFocus={() => undefined}
                  />
                )}
              </div>
              <div className="focus-strip">
                {streams.filter((stream) => stream.id !== focused.id).map((stream) => (
                  stream.local ? (
                    <LocalTile
                      key={stream.id}
                      name={stream.name}
                      previewRef={localPreviewRef}
                      previewStream={localPreviewStreamRef.current}
                      previewVersion={previewVersion}
                      streamId={stream.id}
                      onFocus={() => setFocusedStreamId(stream.id)}
                    />
                  ) : (
                    <VideoTile
                      key={stream.id}
                      name={stream.name}
                      identity={stream.identity}
                      track={stream.track}
                      audioTrack={remoteAudioTracks[stream.identity]}
                      audioSettings={audioSettings[stream.identity]}
                      onAudioSettings={(settings) => setAudioSettings((current) => ({ ...current, [stream.identity]: settings }))}
                      streamId={stream.id}
                      onFocus={() => setFocusedStreamId(stream.id)}
                    />
                  )
                ))}
              </div>
            </div>
          ) : (
            <div className="tile-grid">
              {streams.map((stream) => (
                stream.local ? (
                  <LocalTile
                    key={stream.id}
                    name={stream.name}
                    previewRef={localPreviewRef}
                    previewStream={localPreviewStreamRef.current}
                    previewVersion={previewVersion}
                    streamId={stream.id}
                    onFocus={() => setFocusedStreamId(stream.id)}
                  />
                ) : (
                  <VideoTile
                    key={stream.id}
                    name={stream.name}
                    identity={stream.identity}
                    track={stream.track}
                    audioTrack={remoteAudioTracks[stream.identity]}
                    audioSettings={audioSettings[stream.identity]}
                    onAudioSettings={(settings) => setAudioSettings((current) => ({ ...current, [stream.identity]: settings }))}
                    streamId={stream.id}
                    onFocus={() => setFocusedStreamId(stream.id)}
                  />
                )
              }
                )
              }
              {streams.length === 0 ? (
                <EmptyState
                  canShare={canShare}
                  roomCode={roomCode}
                  onShare={() => void openShareDialog()}
                />
              ) : null}
            </div>
          )}
          <AudioRenderer tracks={remoteAudioTracks} settings={audioSettings} />
          {statsOpen && (
            <StatsOverlay
              stats={mediaStats}
              fallback={`${selectedQuality.width}x${selectedQuality.height}`}
            />
          )}
        </section>
      </div>
      {canShare && (
        <ControlBar
          quality={quality}
          motion={motion}
          audioMode={audioMode}
          audioProcesses={audioProcesses}
          excludedAudioProcessId={excludedAudioProcessId}
          isSharing={isSharing}
          onQuality={(next) => {
            setQuality(next);
            if (isSharing) void publishScreen(selectedSource, next);
          }}
          onMotion={setMotion}
          onAudio={(mode) => {
            setAudioMode(mode);
            if (mode === 'system-excluding-discord' && audioProcesses.length === 0) void refreshAudioProcesses();
          }}
          onExcludedAudio={setExcludedAudioProcessId}
          onShare={() => void openShareDialog()}
          onStop={() => void stopSharing()}
        />
      )}
      {shareDialogOpen && (
        <SourcePickerModal
          sources={sources}
          selectedSource={selectedSource}
          loading={loadingSources}
          error={error}
          onClose={() => setShareDialogOpen(false)}
          onRefresh={() => void refreshSources()}
          onSelect={(sourceId) => {
            setSelectedSource(sourceId);
            void publishScreen(sourceId);
          }}
        />
      )}
    </main>
  );
}

function TopBar({ roomCode, viewerCount, connectionState, statsOpen, onToggleSidebar, onToggleStats, onCopy }: { roomCode: string; viewerCount: number; connectionState: string; statsOpen: boolean; onToggleSidebar: () => void; onToggleStats: () => void; onCopy: () => void }): React.JSX.Element {
  return (
    <header className="topbar">
      <button
        className="icon-button"
        onClick={onToggleSidebar}
        aria-label="Mostrar ou ocultar participantes"
      >
        ☰
      </button>
      <div className="brand compact">
        <span className="brand-mark" aria-hidden="true">◈</span>
        <strong>PartilharTela</strong>
      </div>
      <div className="room-meta">
        <span>Sala <strong>{roomCode}</strong></span>
        <button className="small" onClick={onCopy}>
          Copiar
        </button>
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

function Sidebar({ nickname, participants, streams }: { nickname: string; participants: ParticipantInfo[]; streams: Array<{ id: string; name: string; local: boolean; identity?: string }> }): React.JSX.Element {
  const liveIdentities = new Set(streams.filter((stream) => !stream.local).map((stream) => stream.identity).filter((identity): identity is string => Boolean(identity)));
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
        {participants.map((participant) => (
          <div className="participant" key={participant.identity}>
            <span className={`status-dot ${liveIdentities.has(participant.identity) ? 'live' : ''}`} />
            {participant.name || participant.identity}
            {liveIdentities.has(participant.identity) && <span className="live-mini">AO VIVO</span>}
          </div>
        ))}
      </div>
    </aside>
  );
}

function LocalTile({ name, previewRef, previewStream, previewVersion, streamId, onFocus }: { name: string; previewRef: React.RefObject<HTMLVideoElement>; previewStream?: MediaStream; previewVersion: number; streamId: string; onFocus: () => void }): React.JSX.Element {
  useEffect(() => {
    const video = previewRef.current;
    if (!video || !previewStream) return;
    let cancelled = false;
    const startPreview = () => {
      if (cancelled) return;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      if (video.srcObject !== previewStream) video.srcObject = previewStream;
      void video.play().catch((reason) => {
        console.warn('[PartilharTela] Não foi possível iniciar o preview local:', reason);
      });
    };
    video.addEventListener('loadedmetadata', startPreview);
    startPreview();
    const retry = window.setTimeout(startPreview, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      video.removeEventListener('loadedmetadata', startPreview);
    };
  }, [previewRef, previewStream, previewVersion]);

  return (
    <div
      className="video-tile local-tile"
      data-stream-id={streamId}
      onClick={onFocus}
      onDoubleClick={(event) => void toggleFullscreen(event.currentTarget)}
    >
      <video ref={previewRef} autoPlay muted playsInline />
      <div className="tile-gradient" />
      <div className="tile-caption">
        <span>{name}</span>
        <b>AO VIVO</b>
      </div>
      <button
        className="tile-fullscreen"
        onClick={(event) => {
          event.stopPropagation();
          void toggleFullscreen(event.currentTarget.parentElement!);
        }}
        aria-label="Alternar tela cheia"
      >
        ⛶
      </button>
    </div>
  );
}

function StatsOverlay({ stats, fallback }: { stats: MediaStats; fallback: string }): React.JSX.Element {
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

function EmptyState({ canShare, roomCode, onShare }: { canShare: boolean; roomCode: string; onShare: () => void }): React.JSX.Element {
  return (
    <div className="empty-stage">
      <div className="empty-icon" aria-hidden="true">▧</div>
      <h2>Ninguém está transmitindo</h2>
      <p>
        {canShare ? (
          <>
            Clique em <strong>Compartilhar tela</strong> para começar.
          </>
        ) : (
          <>
            Aguardando alguém compartilhar a tela na sala <strong>{roomCode}</strong>.
          </>
        )}
      </p>
      {canShare && (
        <button
          className="primary"
          onClick={onShare}
          aria-label="Compartilhar sua tela"
        >
          Compartilhar tela
        </button>
      )}
    </div>
  );
}

function ControlBar({ quality, motion, audioMode, audioProcesses, excludedAudioProcessId, isSharing, onQuality, onMotion, onAudio, onExcludedAudio, onShare, onStop }: { quality: Quality; motion: boolean; audioMode: AudioMode; audioProcesses: Array<{ title: string; processId: string }>; excludedAudioProcessId: string; isSharing: boolean; onQuality: (quality: Quality) => void; onMotion: (motion: boolean) => void; onAudio: (mode: AudioMode) => void; onExcludedAudio: (id: string) => void; onShare: () => void; onStop: () => void }): React.JSX.Element {
  return (
    <footer className="controls">
      <div className="control-actions">
        {isSharing ? (
          <>
            <button onClick={onShare}>
              ↔ Trocar fonte
            </button>
            <button className="danger" onClick={onStop}>
              ■ Parar
            </button>
          </>
        ) : (
          <button
            className="primary"
            onClick={onShare}
            aria-label="Compartilhar tela"
          >
            ▣ Compartilhar tela
          </button>
        )}
      </div>
      <label>
        Qualidade
        <select
          value={quality}
          onChange={(event) => onQuality(event.target.value as Quality)}
          aria-label="Qualidade da transmissão"
        >
          <option value="720p30">720p30</option>
          <option value="1080p30">1080p30</option>
          <option value="1080p60">1080p60</option>
        </select>
      </label>
      <label>
        Modo
        <select
          value={motion ? 'motion' : 'detail'}
          onChange={(event) => onMotion(event.target.value === 'motion')}
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
          onChange={(event) => onAudio(event.target.value as AudioMode)}
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
            onChange={(event) => onExcludedAudio(event.target.value)}
            aria-label="Processo de áudio para excluir"
          >
            <option value="">Escolha</option>
            {audioProcesses.map((item) => (
              <option key={item.processId} value={item.processId}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
    </footer>
  );
}

function SourcePickerModal({ sources, selectedSource, loading, error, onClose, onRefresh, onSelect }: { sources: DesktopSource[]; selectedSource: string; loading: boolean; error: string; onClose: () => void; onRefresh: () => void; onSelect: (id: string) => void }): React.JSX.Element {
  const [tab, setTab] = useState<'screens' | 'windows'>('screens');
  const filtered = sources.filter((source) => tab === 'screens' ? source.type === 'screen' : source.type === 'window');
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
    >
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
          <button
            className={tab === 'screens' ? 'active' : ''}
            onClick={() => setTab('screens')}
          >
            Telas
          </button>
          <button
            className={tab === 'windows' ? 'active' : ''}
            onClick={() => setTab('windows')}
          >
            Janelas
          </button>
        </div>
        {loading ? (
          <p className="muted">Carregando fontes...</p>
        ) : filtered.length === 0 ? (
          <div className="empty-sources">
            <p>Nenhuma fonte encontrada nesta aba.</p>
            <button onClick={onRefresh}>
              Atualizar
            </button>
          </div>
        ) : (
          <div className="sources">
            {filtered.map((source) => (
              <button
                className={`source ${selectedSource === source.id ? 'selected' : ''}`}
                key={source.id}
                onClick={() => onSelect(source.id)}
              >
                <img src={source.thumbnail} alt="" />
                <span>{source.name}</span>
                {selectedSource === source.id && <b>Selecionada</b>}
              </button>
            ))}
          </div>
        )}
        <FormError message={error} />
      </section>
    </div>
  );
}

function AudioRenderer({ tracks, settings }: { tracks: Record<string, RemoteAudioTrack>; settings: Record<string, AudioSettings> }): React.JSX.Element {
  return (
    <div
      className="remote-audio-renderer"
      aria-hidden="true"
    >
      {Object.entries(tracks).map(([identity, track]) => (
        <RemoteAudioElement
          key={`${identity}-${track.sid}`}
          identity={identity}
          track={track}
          settings={settings[identity]}
        />
      ))}
    </div>
  );
}

function RemoteAudioElement({ identity, track, settings }: { identity: string; track: RemoteAudioTrack; settings?: AudioSettings }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    track.attach(audio);
    audio.autoplay = true;
    audio.preload = 'auto';
    const playAudio = () => {
      void audio.play().catch((reason) => {
        console.warn(`[PartilharTela] Reprodução da faixa de áudio de ${identity} aguardando desbloqueio:`, reason);
      });
    };
    audio.addEventListener('canplay', playAudio);
    audio.addEventListener('loadeddata', playAudio);
    playAudio();
    const retry = window.setInterval(playAudio, 300);
    return () => {
      window.clearInterval(retry);
      audio.removeEventListener('canplay', playAudio);
      audio.removeEventListener('loadeddata', playAudio);
      track.detach(audio);
    };
  }, [identity, track]);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.muted = settings?.muted ?? false;
    audioRef.current.volume = settings?.muted ? 0 : settings?.volume ?? 1;
  }, [settings]);

  return (
    <audio
      ref={audioRef}
      autoPlay
      preload="auto"
    />
  );
}

function VideoTile({ name, identity, track, audioTrack, audioSettings, onAudioSettings, streamId, onFocus }: { name: string; identity: string; track: RemoteVideoTrack; audioTrack?: RemoteAudioTrack; audioSettings?: AudioSettings; onAudioSettings: (settings: AudioSettings) => void; streamId: string; onFocus: () => void }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const volume = audioSettings?.volume ?? 1;
  const muted = audioSettings?.muted ?? false;
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  useEffect(() => {
    if (!videoRef.current) return;
    track.attach(videoRef.current);
    return () => { track.detach(videoRef.current!); };
  }, [track]);

  return (
    <div
      className="video-tile"
      data-stream-id={streamId}
      onClick={onFocus}
      onDoubleClick={(event) => void toggleFullscreen(event.currentTarget)}
      onContextMenu={(event) => {
        event.preventDefault();
        setAudioMenuOpen(true);
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
          onClick={(event) => {
            event.stopPropagation();
            setAudioMenuOpen(true);
          }}
          aria-label="Configurações de áudio"
        >
          🔊
        </button>
        <button
          onClick={(event) => {
            event.stopPropagation();
            onFocus();
          }}
          aria-label="Focar neste vídeo"
        >
          ◉
        </button>
        <button
          onClick={(event) => {
            event.stopPropagation();
            void toggleFullscreen(event.currentTarget.parentElement?.parentElement!);
          }}
          aria-label="Alternar tela cheia"
        >
          ⛶
        </button>
      </div>
      {audioMenuOpen && (
        <div
          className="audio-context-menu"
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
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
                  onChange={(event) => onAudioSettings({ volume: Number(event.target.value), muted: false })}
                />
              </label>
            </>
          ) : (
            <span className="audio-unavailable">Esta transmissão ainda não tem áudio.</span>
          )}
          <button
            type="button"
            onClick={() => setAudioMenuOpen(false)}
          >
            Fechar
          </button>
        </div>
      )}
    </div>
  );
}

async function toggleFullscreen(element: HTMLElement): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await element.requestFullscreen();
  }
}

function FormError({ message }: { message: string }): React.JSX.Element | null {
  return message ? <p className="error">{message}</p> : null;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);