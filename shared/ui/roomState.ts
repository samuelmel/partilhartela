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

/** `avatarUrl` vem da metadata do token quando o participante entrou com o Discord. */
export type StreamItem = {
  id: string;
  identity: string;
  name: string;
  avatarUrl?: string;
  track: RemoteVideoTrack;
  /** Transmissão da própria pessoa vinda do app nativo (Rust): mostrada como "Sua tela", sem áudio. */
  own?: boolean;
};
export type Member = { identity: string; name: string; avatarUrl?: string; isLocal: boolean; sharing: boolean };
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

/** Metadata do participante = `{"discord":{"id","avatarUrl"}}`, assinada pelo servidor no token. */
export function avatarUrlOf(participant: { metadata?: string }): string | undefined {
  if (!participant.metadata) return undefined;
  try {
    const url: unknown = (JSON.parse(participant.metadata) as { discord?: { avatarUrl?: unknown } })?.discord?.avatarUrl;
    return typeof url === 'string' && url.startsWith('https://cdn.discordapp.com/') ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * O app nativo transmite por um segundo participante (`<identity>-share`) com `{"shareOf": identity}`
 * na metadata. Devolve a identity do dono, ou undefined para participantes comuns.
 * Sem login o valor é só o que o cliente informou: serve para agrupar na interface, não para autorizar.
 */
export function shareOwnerOf(participant: { metadata?: string }): string | undefined {
  if (!participant.metadata) return undefined;
  try {
    const owner: unknown = (JSON.parse(participant.metadata) as { shareOf?: unknown })?.shareOf;
    return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
  } catch {
    return undefined;
  }
}

/** Identity "lógica" de quem transmite: o dono, quando o participante é uma transmissão nativa. */
export function logicalIdentity(participant: { identity: string; metadata?: string }): string {
  return shareOwnerOf(participant) ?? participant.identity;
}

export function readRoomSnapshot(room: Room): RoomSnapshot {
  const streams: StreamItem[] = [];
  const audio: Record<string, RemoteAudioTrack> = {};
  const local = room.localParticipant;
  const localScreen = local.getTrackPublication(Track.Source.ScreenShare);
  const localAudio = local.getTrackPublication(Track.Source.ScreenShareAudio);
  const localVideo = localScreen?.track instanceof LocalVideoTrack ? localScreen.track : undefined;
  const members: Member[] = [
    { identity: local.identity, name: displayName(local), avatarUrl: avatarUrlOf(local), isLocal: true, sharing: Boolean(localVideo) }
  ];

  const sharingOwners = new Set<string>();
  let ownNativeShare = false;

  for (const participant of room.remoteParticipants.values()) {
    const screen = participant.getTrackPublication(Track.Source.ScreenShare);
    const sound = participant.getTrackPublication(Track.Source.ScreenShareAudio);
    const owner = shareOwnerOf(participant);

    if (owner !== undefined) {
      // Transmissão do app nativo: não é uma pessoa da sala; pertence ao dono.
      const isOwn = owner === local.identity;
      const ownerName = isOwn ? displayName(local) : displayName(room.remoteParticipants.get(owner) ?? participant);
      if (isOwn) {
        // Nunca assina o próprio áudio: tocaria o som da pessoa com atraso.
        if (sound && (sound.isSubscribed || sound.isDesired)) sound.setSubscribed(false);
      } else if (sound?.track instanceof RemoteAudioTrack) {
        audio[owner] = sound.track;
      }
      if (screen?.track instanceof RemoteVideoTrack) {
        streams.push({
          id: screen.trackSid,
          identity: owner,
          name: isOwn ? 'Sua tela' : ownerName,
          avatarUrl: avatarUrlOf(isOwn ? local : room.remoteParticipants.get(owner) ?? participant),
          track: screen.track,
          own: isOwn
        });
      }
      if (screen) {
        if (isOwn) ownNativeShare = true;
        else sharingOwners.add(owner);
      }
      continue;
    }

    if (screen?.track instanceof RemoteVideoTrack) {
      streams.push({
        id: screen.trackSid,
        identity: participant.identity,
        name: displayName(participant),
        avatarUrl: avatarUrlOf(participant),
        track: screen.track
      });
    }
    if (sound?.track instanceof RemoteAudioTrack) {
      audio[participant.identity] = sound.track;
    }
    members.push({
      identity: participant.identity,
      name: displayName(participant),
      avatarUrl: avatarUrlOf(participant),
      isLocal: false,
      sharing: Boolean(screen)
    });
  }

  for (const member of members) {
    if (sharingOwners.has(member.identity)) member.sharing = true;
  }
  if (ownNativeShare) members[0].sharing = true;

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
  RoomEvent.ParticipantMetadataChanged,
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
