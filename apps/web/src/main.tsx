import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track
} from 'livekit-client';
import './styles.css';

const tokenServer = import.meta.env.VITE_TOKEN_SERVER_URL ?? 'http://localhost:8787';
type VideoItem = { id: string; identity: string; name: string; track: RemoteVideoTrack };
type AudioItem = { identity: string; track: RemoteAudioTrack };

function App(): JSX.Element {
  const [code, setCode] = useState(new URLSearchParams(window.location.search).get('room')?.toUpperCase() ?? '');
  const [nickname, setNickname] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [audios, setAudios] = useState<AudioItem[]>([]);
  const [participants, setParticipants] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState('Desconectado');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [focusId, setFocusId] = useState<string>();
  const roomRef = useRef<Room>();

  // Clean up room connection on unmount
  useEffect(() => () => { roomRef.current?.disconnect(); }, []);

  async function enterRoom(): Promise<void> {
    setError('');
    setLoading(true);

    try {
      const normalized = code.trim().toUpperCase();
      const name = nickname.trim();

      // Validate room code
      if (!/^[A-Z0-9]{6}$/.test(normalized)) {
        setError('Digite um código de sala válido com 6 caracteres (ex: ABC123).');
        return;
      }

      // Validate nickname
      if (!name) {
        setError('Digite seu apelido para entrar na sala.');
        return;
      }

      // Fetch token from server
      const response = await fetch(`${tokenServer}/rooms/${normalized}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: name })
      });

      const data = await response.json() as { token?: string; livekitUrl?: string; code?: string; error?: string };

      if (!response.ok || !data.token || !data.livekitUrl) {
        throw new Error(data.error ?? 'Não foi possível entrar na sala. Verifique o código e tente novamente.');
      }

      // Connect to LiveKit room
      const room = new Room({ adaptiveStream: true, dynacast: true });

      // Set up event listeners
      room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        const participantName = participant.name || participant.identity;
        if (track.kind === Track.Kind.Video && track instanceof RemoteVideoTrack) {
          setVideos((current) => [...current.filter((item) => item.id !== track.sid), {
            id: track.sid ?? track.mediaStreamTrack.id,
            identity: participant.identity,
            name: participantName,
            track
          }]);
        }
        if (track.kind === Track.Kind.Audio && track instanceof RemoteAudioTrack) {
          setAudios((current) => [...current.filter((item) => item.identity !== participant.identity), { identity: participant.identity, track }]);
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach();
        if (track.kind === Track.Kind.Video) setVideos((current) => current.filter((item) => item.id !== track.sid));
        if (track.kind === Track.Kind.Audio) setAudios((current) => current.filter((item) => item.track.sid !== track.sid));
      });

      room.on(RoomEvent.ParticipantConnected, (participant) => {
        setParticipants((current) => [...new Set([...current, participant.name || participant.identity])]);
      });

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        setParticipants((current) => current.filter((name) => name !== (participant.name || participant.identity)));
      });

      room.on(RoomEvent.Reconnecting, () => setConnection('Reconectando...'));
      room.on(RoomEvent.Reconnected, () => setConnection('Conectado'));
      room.on(RoomEvent.Disconnected, () => {
        setConnection('Desconectado');
        setConnected(false);
        setError('Conexão perdida. Tentando reconectar...');
      });

      await room.connect(data.livekitUrl, data.token, { autoSubscribe: true });
      roomRef.current = room;
      setRoomCode(data.code ?? normalized);
      setParticipants(Array.from(room.remoteParticipants.values()).map((participant) => participant.name || participant.identity));
      setConnection('Conectado');
      setConnected(true);

      // Handle audio playback permissions
      const audioRoom = room as Room & { canPlaybackAudio?: boolean; startAudio?: () => Promise<void> };
      if (audioRoom.canPlaybackAudio === false) {
        setAudioEnabled(false);
      }
    } catch (reason) {
      roomRef.current?.disconnect();
      setError(reason instanceof Error ? reason.message : 'Não foi possível conectar à sala. Verifique seu conexão e tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  async function enableAudio(): Promise<void> {
    const room = roomRef.current as (Room & { startAudio?: () => Promise<void> }) | undefined;
    try {
      await room?.startAudio?.();
      setAudioEnabled(true);
      setError(''); // Clear any audio-related errors
    } catch {
      setError('Clique novamente em “Ativar áudio” para liberar a reprodução do navegador.');
    }
  }

  function leaveRoom(): void {
    roomRef.current?.disconnect();
    roomRef.current = undefined;
    setConnected(false);
    setVideos([]);
    setAudios([]);
    setParticipants([]);
    setRoomCode('');
    setConnection('Desconectado');
    setError('');
  }

  // Render disconnected state (home screen)
  if (!connected) {
    return (
      <main className="home" role="main">
        <div className="brand-mark" aria-hidden="true">◈</div>
        <h1>PartilharTela</h1>
        <p>Assista à transmissão direto do navegador.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void enterRoom();
          }}
          aria-label="Formulario para entrar na sala"
        >
          <div className="form-group">
            <label htmlFor="room-code">Código da sala</label>
            <input
              id="room-code"
              type="text"
              value={code}
              maxLength={6}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="ABC123"
              aria-label="Código da sala com 6 caracteres"
              disabled={loading}
            />
          </div>
          <div className="form-group">
            <label htmlFor="nickname">Seu apelido</label>
            <input
              id="nickname"
              type="text"
              value={nickname}
              maxLength={32}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="Como você quer aparecer?"
              aria-label="Seu apelido na transmissão"
              disabled={loading}
            />
          </div>
          <button
            className="primary"
            type="submit"
            disabled={loading}
          >
            {loading ? 'Entrando...' : 'Entrar para assistir'}
          </button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        <small>O navegador precisa permitir reprodução de áudio.</small>
      </main>
    );
  }

  // Render connected state (watch screen)
  const focused = videos.find((item) => item.id === focusId);

  return (
    <main className="watch" role="main">
      <header>
        <div className="brand compact">
          <span className="brand-mark" aria-hidden="true">◈</span>
          <strong>PartilharTela</strong>
        </div>
        <div className="room-info">
          <span>Sala <b>{roomCode}</b></span>
          <span
            className={connection === 'Conectado' ? 'ok' : 'warning'}
            role="status"
          >
            ● {connection}
          </span>
          <span>{participants.length + 1} participante{participants.length === 1 ? '' : 's'}</span>
          <button
            onClick={leaveRoom}
            aria-label="Sair da sala"
          >
            Sair
          </button>
        </div>
      </header>

      <section className="watch-stage">
        {focused ? (
          <div className="focus">
            <button
              onClick={() => setFocusId(undefined)}
              aria-label="Voltar à grade de vídeos"
            >
              ← Voltar à grade
            </button>
            <VideoTile
              item={focused}
              onFocus={() => undefined}
            />
            <div className="thumbs">
              {videos.filter((item) => item.id !== focused.id).map((item) => (
                <VideoTile
                  key={item.id}
                  item={item}
                  onFocus={() => setFocusId(item.id)}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="grid">
            {videos.map((item) => (
              <VideoTile
                key={item.id}
                item={item}
                onFocus={() => setFocusId(item.id)}
              />
            ))}
            {videos.length === 0 && (
              <div className="empty">
                <div className="empty-icon" aria-hidden="true">▧</div>
                <h2>Ninguém está transmitindo</h2>
                <p>A transmissão aparecerá aqui quando o apresentador compartilhar a tela.</p>
              </div>
            )}
          </div>
        )}

        {!audioEnabled && (
          <button
            className="audio-banner"
            onClick={() => void enableAudio()}
            aria-label="Ativar áudio da transmissão"
          >
            🔊 Ativar áudio
          </button>
        )}

        <AudioRenderer audios={audios} />
      </section>
    </main>
  );
}

function VideoTile({ item, onFocus }: { item: VideoItem; onFocus: () => void }): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    item.track.attach(video);
    void video.play().catch(() => undefined);

    return () => {
      item.track.detach(video);
    };
  }, [item.track]);

  return (
    <button
      className="tile"
      onClick={onFocus}
      aria-label={`Vídeo de ${item.name}`}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
      />
      <span>
        {item.name}
        <b>AO VIVO</b>
      </span>
    </button>
  );
}

function AudioRenderer({ audios }: { audios: AudioItem[] }): JSX.Element {
  return (
    <div
      className="audio-renderer"
      aria-hidden="true"
    >
      {audios.map((item) => (
        <AudioElement
          key={`${item.identity}-${item.track.sid}`}
          item={item}
        />
      ))}
    </div>
  );
}

function AudioElement({ item }: { item: AudioItem }): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;

    item.track.attach(audio);
    const play = () => { void audio.play().catch(() => undefined); };
    audio.addEventListener('canplay', play);
    play();

    return () => {
      audio.removeEventListener('canplay', play);
      item.track.detach(audio);
    };
  }, [item.track]);

  return (
    <audio
      ref={ref}
      autoPlay
      controls={false}
    />
  );
}

createRoot(document.getElementById('root')!).render(<App />);