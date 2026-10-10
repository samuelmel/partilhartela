import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LocalAudioTrack,
  LocalVideoTrack,
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
  const [systemAudio, setSystemAudio] = useState(false);
  const [sources, setSources] = useState<DesktopSource[]>([]);
  const [selectedSource, setSelectedSource] = useState('');
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [loadingSources, setLoadingSources] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [remoteTracks, setRemoteTracks] = useState<Array<{ id: string; identity: string; track: RemoteVideoTrack }>>([]);
  const roomRef = useRef<Room>();
  const localPreviewRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<LocalVideoTrack>();
  const localAudioRef = useRef<LocalAudioTrack>();
  const publishingRef = useRef(false);

  useEffect(() => () => { roomRef.current?.disconnect(); }, []);

  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    const tracks: Array<{ id: string; identity: string; track: RemoteVideoTrack }> = [];
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track?.kind === Track.Kind.Video && publication.track instanceof RemoteVideoTrack) {
          tracks.push({ id: publication.track.sid ?? publication.track.mediaStreamTrack.id, identity: participant.identity, track: publication.track });
        }
      }
    }
    setRemoteTracks(tracks);
  }, [screen]);

  async function connect(role: 'presenter' | 'viewer', roomInfo: { token: string; livekitUrl: string; code: string }): Promise<void> {
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h1080.resolution, facingMode: 'user' },
      publishDefaults: { simulcast: false, videoCodec: 'h264' }
    });
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind === Track.Kind.Video && track instanceof RemoteVideoTrack) {
        setRemoteTracks((current) => [...current.filter((item) => item.id !== track.sid), {
          id: track.sid ?? track.mediaStreamTrack.id,
          identity: participant.identity,
          track
        }]);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
      if (track.kind === Track.Kind.Video) setRemoteTracks((current) => current.filter((item) => item.id !== track.sid));
    });
    room.on(RoomEvent.ParticipantConnected, () => setViewerCount(room.remoteParticipants.size));
    room.on(RoomEvent.ParticipantDisconnected, () => setViewerCount(room.remoteParticipants.size));
    room.on(RoomEvent.Disconnected, () => { if (screen !== 'home') setError('A conexão foi perdida. Tente entrar novamente.'); });
    try {
      await room.connect(roomInfo.livekitUrl, roomInfo.token, { autoSubscribe: true });
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
    try {
      const currentVideoPublication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      if (currentVideoPublication?.track) {
        await room.localParticipant.unpublishTrack(currentVideoPublication.track);
        currentVideoPublication.track.stop();
      }
      localVideoRef.current = undefined;
      const currentAudioPublication = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      if (currentAudioPublication?.track) {
        await room.localParticipant.unpublishTrack(currentAudioPublication.track);
        currentAudioPublication.track.stop();
      }
      localAudioRef.current = undefined;
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('A captura de tela não está disponível nesta janela do Electron.');
      }
      await window.partilharTela.setCaptureSource(sourceId);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: settings.width, max: settings.width },
          height: { ideal: settings.height, max: settings.height },
          frameRate: { ideal: settings.fps, max: settings.fps }
        },
        audio: systemAudio
      });
      console.info('[PartilharTela] Fonte capturada:', sourceId);
      const rawVideo = stream.getVideoTracks()[0];
      if (!rawVideo) {
        throw new Error('A fonte selecionada não forneceu vídeo. Escolha outra tela ou janela.');
      }
      await rawVideo.applyConstraints({
        width: { exact: settings.width },
        height: { exact: settings.height },
        frameRate: { exact: settings.fps }
      }).catch(async () => {
        await rawVideo.applyConstraints({
          width: { ideal: settings.width },
          height: { ideal: settings.height },
          frameRate: { ideal: settings.fps }
        });
      });
      console.info('[PartilharTela] Resolução capturada:', rawVideo.getSettings());
      const videoTrack = new LocalVideoTrack(rawVideo);
      rawVideo.contentHint = motion ? 'motion' : 'detail';
      localVideoRef.current = videoTrack;
      if (localPreviewRef.current) videoTrack.attach(localPreviewRef.current);
      await room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare,
        simulcast: false,
        videoEncoding: { maxBitrate: settings.bitrate, maxFramerate: settings.fps },
        degradationPreference: motion ? 'maintain-framerate' : 'maintain-resolution'
      });
      console.info('[PartilharTela] Tela publicada no LiveKit.');
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        localAudioRef.current = new LocalAudioTrack(audioTrack);
        await room.localParticipant.publishTrack(localAudioRef.current, { source: Track.Source.ScreenShareAudio });
      }
    } catch (reason) {
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
    const room = roomRef.current;
    if (!room) return;
    if (localVideoRef.current) {
      await room.localParticipant.unpublishTrack(localVideoRef.current);
      localVideoRef.current.detach();
      localVideoRef.current.stop();
      localVideoRef.current = undefined;
    }
    if (localAudioRef.current) {
      await room.localParticipant.unpublishTrack(localAudioRef.current);
      localAudioRef.current.stop();
      localAudioRef.current = undefined;
    }
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

  if (screen === 'home') return <main className="shell home"><div className="brand"><span className="brand-mark">◈</span><h1>PartilharTela</h1><p>Compartilhe sua tela ao vivo, sem complicação.</p></div><div className="actions"><button className="primary" onClick={() => void createRoom()}>Criar sala</button><button onClick={() => setScreen('join')}>Entrar na sala</button></div><FormError message={error} /></main>;
  if (screen === 'join') return <main className="shell centered"><section className="card"><button className="back" onClick={() => setScreen('home')}>← Voltar</button><h2>Entrar em uma sala</h2><p className="muted">Digite o código recebido do apresentador.</p><label>Código da sala<input value={code} maxLength={6} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ABC123" /></label><label>Seu apelido<input value={nickname} maxLength={32} onChange={(event) => setNickname(event.target.value)} placeholder="Visitante" /></label><button className="primary full" disabled={code.length !== 6} onClick={() => void joinRoom()}>Assistir</button><FormError message={error} /></section></main>;

  const selectedQuality = qualities[quality];
  const canShare = screen === 'presenter' || screen === 'viewer';
  return <main className="room"><header><div className="brand compact"><span className="brand-mark">◈</span><strong>PartilharTela</strong>{(isSharing || remoteTracks.length > 0) && <span className="live-pill">AO VIVO</span>}</div><div className="room-meta">Código da sala <strong>{roomCode}</strong><button className="small" onClick={() => void copyLink()}>Copiar código</button><span className="connection">● Conectado</span></div></header><section className="stage"><div className="tile-grid">{isSharing && <div className="video-tile local-tile"><video ref={localPreviewRef} autoPlay muted playsInline /><span>Você</span><button className="tile-fullscreen" onClick={(event) => void toggleFullscreen(event.currentTarget.parentElement!)}>Tela cheia</button></div>}{remoteTracks.map((item) => <VideoTile key={item.id} identity={item.identity} track={item.track} />)}{!isSharing && remoteTracks.length === 0 && canShare && <div className="empty-stage"><h2>{screen === 'presenter' ? 'Sala criada' : 'Você entrou na sala'}</h2><p>Compartilhe o código <strong>{roomCode}</strong> e clique em <strong>Compartilhar tela</strong> quando quiser transmitir.</p></div>}{!isSharing && remoteTracks.length === 0 && !canShare && <div className="empty-stage"><h2>Aguardando compartilhamento</h2><p>Quando alguém compartilhar a tela, ela aparecerá aqui.</p></div>}</div><div className="overlay"><span>● Conexão ativa</span><span>{isSharing || remoteTracks.length > 0 ? `${selectedQuality.width}x${selectedQuality.height} · ${selectedQuality.fps} fps` : 'Aguardando compartilhamento'}</span><span>{`${viewerCount} participante(s)`}</span></div></section>{canShare && <aside className="controls"><div className="control-row"><label>Qualidade<select value={quality} onChange={(event) => { const next = event.target.value as Quality; setQuality(next); if (isSharing) void publishScreen(selectedSource, next); }}><option value="720p30">720p · 30 fps</option><option value="1080p30">1080p · 30 fps</option><option value="1080p60">1080p · 60 fps</option></select></label><label>Conteúdo<select value={motion ? 'motion' : 'detail'} onChange={(event) => setMotion(event.target.value === 'motion')}><option value="motion">Movimento / jogos</option><option value="detail">Texto / código</option></select></label><label className="toggle"><input type="checkbox" checked={systemAudio} onChange={(event) => setSystemAudio(event.target.checked)} /> Áudio do sistema</label>{isSharing ? <><button onClick={() => void openShareDialog()}>Trocar fonte</button><button onClick={() => void stopSharing()}>Parar compartilhamento</button></> : <button className="primary" onClick={() => void openShareDialog()}>Compartilhar tela</button>}</div><FormError message={error} /></aside>}{shareDialogOpen && <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="share-modal"><div className="modal-header"><div><h2>Escolha o que compartilhar</h2><p className="muted">Selecione uma tela inteira ou uma janela.</p></div><button className="close" onClick={() => setShareDialogOpen(false)}>×</button></div>{loadingSources ? <p className="muted">Carregando telas e janelas...</p> : sources.length === 0 ? <div className="empty-sources"><p>Nenhuma fonte foi encontrada.</p><button onClick={() => void refreshSources()}>Tentar novamente</button></div> : <div className="sources">{sources.map((source) => <button className={`source ${selectedSource === source.id ? 'selected' : ''}`} key={source.id} onClick={() => { setSelectedSource(source.id); void publishScreen(source.id); }}><img src={source.thumbnail} alt="" /><span>{source.name}</span></button>)}</div>}<FormError message={error} /></section></div>}</main>;
}

function VideoTile({ identity, track }: { identity: string; track: RemoteVideoTrack }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!videoRef.current) return;
    track.attach(videoRef.current);
    return () => { track.detach(videoRef.current!); };
  }, [track]);
  return <div className="video-tile"><video ref={videoRef} autoPlay playsInline /><span>{identity}</span><button className="tile-fullscreen" onClick={(event) => void toggleFullscreen(event.currentTarget.parentElement!)}>Tela cheia</button></div>;
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
