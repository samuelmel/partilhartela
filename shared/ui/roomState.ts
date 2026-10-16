import { useEffect, useState } from 'react';
import {
  ConnectionError,
  ConnectionErrorReason,
  ConnectionState,
  LocalVideoTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track
} from 'livekit-client';

// Estado da sala lido sempre do SDK: a UI não guarda cópias próprias de tracks,
// então não sobram tiles fantasmas nem áudio de quem já saiu.

export type StreamItem = { id: string; identity: string; name: string; track: RemoteVideoTrack };
export type Member = { identity: string; name: string; isLocal: boolean; sharing: boolean };
export type LocalShare = { video?: LocalVideoTrack; hasAudio: boolean; audioMuted: boolean };
export type RoomSnapshot = {
  streams: StreamItem[];
  /** Áudio da tela compartilhada (ScreenShareAudio), por identity do apresentador. */
  audio: Record<string, RemoteAudioTrack>;
  members: Member[];
  local: LocalShare;
};

export const emptySnapshot: RoomSnapshot = {
  streams: [],
  audio: {},
  members: [],
  local: { hasAudio: false, audioMuted: false }
};

function displayName(participant: { name?: string }): string {
  return participant.name?.trim() || 'Visitante';
}

export function readRoomSnapshot(room: Room): RoomSnapshot {
  const streams: StreamItem[] = [];
  const audio: Record<string, RemoteAudioTrack> = {};
  const local = room.localParticipant;
  const localScreen = local.getTrackPublication(Track.Source.ScreenShare);
  const localAudio = local.getTrackPublication(Track.Source.ScreenShareAudio);
  const localVideo = localScreen?.track instanceof LocalVideoTrack ? localScreen.track : undefined;
  const members: Member[] = [
    { identity: local.identity, name: displayName(local), isLocal: true, sharing: Boolean(localVideo) }
  ];

  for (const participant of room.remoteParticipants.values()) {
    const screen = participant.getTrackPublication(Track.Source.ScreenShare);
    const sound = participant.getTrackPublication(Track.Source.ScreenShareAudio);
    if (screen?.track instanceof RemoteVideoTrack) {
      streams.push({ id: screen.trackSid, identity: participant.identity, name: displayName(participant), track: screen.track });
    }
    if (sound?.track instanceof RemoteAudioTrack) {
      audio[participant.identity] = sound.track;
    }
    members.push({ identity: participant.identity, name: displayName(participant), isLocal: false, sharing: Boolean(screen) });
  }

  return {
    streams,
    audio,
    members,
    local: { video: localVideo, hasAudio: Boolean(localAudio?.track), audioMuted: localAudio?.isMuted ?? false }
  };
}

const snapshotEvents = [
  RoomEvent.Connected,
  RoomEvent.Reconnected,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished
] as const;

export function useRoomSnapshot(room: Room | undefined): RoomSnapshot {
  const [snapshot, setSnapshot] = useState<RoomSnapshot>(emptySnapshot);

  useEffect(() => {
    if (!room) {
      setSnapshot(emptySnapshot);
      return;
    }
    const update = () => setSnapshot(readRoomSnapshot(room));
    update();
    for (const event of snapshotEvents) room.on(event, update);
    return () => {
      for (const event of snapshotEvents) room.off(event, update);
    };
  }, [room]);

  return snapshot;
}

export function useConnectionState(room: Room | undefined): ConnectionState {
  const [state, setState] = useState<ConnectionState>(room?.state ?? ConnectionState.Disconnected);

  useEffect(() => {
    if (!room) return;
    setState(room.state);
    const update = (next: ConnectionState) => setState(next);
    room.on(RoomEvent.ConnectionStateChanged, update);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, update);
    };
  }, [room]);

  return state;
}

/** Navegadores bloqueiam áudio sem interação; `blocked` vem do próprio SDK. */
export function useAudioPlayback(room: Room | undefined): { blocked: boolean; start: () => Promise<void> } {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!room) return;
    const update = () => setBlocked(!room.canPlaybackAudio);
    update();
    room.on(RoomEvent.AudioPlaybackStatusChanged, update);
    return () => {
      room.off(RoomEvent.AudioPlaybackStatusChanged, update);
    };
  }, [room]);

  return {
    blocked,
    start: async () => {
      await room?.startAudio();
      setBlocked(!(room?.canPlaybackAudio ?? true));
    }
  };
}

/**
 * Muta/desmuta o áudio que ESTE participante transmite. Usa o mute da publicação
 * (desabilita a MediaStreamTrack e avisa o servidor), sem parar a captura: desmutar
 * reaproveita a mesma fonte e o vídeo segue intacto.
 */
export async function setShareAudioMuted(room: Room, muted: boolean): Promise<void> {
  const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  if (!publication?.track) {
    throw new Error('Esta transmissão não tem áudio para mutar.');
  }
  if (muted) await publication.mute();
  else await publication.unmute();
}

export function describeConnectError(error: unknown): string {
  if (error instanceof ConnectionError && error.reason === ConnectionErrorReason.NotAllowed) {
    return 'O convite expirou ou é inválido. Entre de novo pelo código da sala.';
  }
  return 'Não foi possível conectar ao servidor de mídia. Verifique sua internet e tente de novo.';
}

export type ConnectionTone = 'ok' | 'warn' | 'off';

export function describeConnection(state: ConnectionState): { label: string; tone: ConnectionTone } {
  switch (state) {
    case ConnectionState.Connected:
      return { label: 'Conectado', tone: 'ok' };
    case ConnectionState.Connecting:
      return { label: 'Conectando…', tone: 'warn' };
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return { label: 'Reconectando…', tone: 'warn' };
    default:
      return { label: 'Desconectado', tone: 'off' };
  }
}
