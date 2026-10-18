import { RoomEvent, Track, type Participant, type Room, type TrackPublication } from 'livekit-client';

type ShareSound = 'start' | 'stop';

// Duas notas por aviso, 1 s no total: subindo ao começar, descendo ao parar.
const notes: Record<ShareSound, [number, number]> = {
  start: [587.33, 880], // Ré5 -> Lá5
  stop: [880, 587.33]
};
const noteDuration = 0.5;
const attack = 0.02;
const peakGain = 0.16;

// Desktop republica o vídeo ao trocar qualidade, codec ou fonte (unpublish + publish), o que leva
// de 1 a 10 s. Antes de despublicar ele avisa a sala (`announceScreenRepublish`); enquanto o aviso
// vale, nem "parou" nem "começou" tocam para aquele participante.
const republishTopic = 'partilhartela.republicando';
const republishTimeoutMs = 15000;
// O aviso de dados e o unpublish chegam por caminhos diferentes; o "parou" espera esta janela
// para dar tempo do aviso chegar (e cobre republicações rápidas de quem não avisa).
const republishWindowMs = 1500;

let context: AudioContext | undefined;
const localRepublish = new WeakMap<Room, () => void>();

/** Desktop: chame antes de despublicar o vídeo para trocar qualidade, codec ou fonte. */
export async function announceScreenRepublish(room: Room): Promise<void> {
  localRepublish.get(room)?.();
  try {
    await room.localParticipant.publishData(new TextEncoder().encode('1'), { reliable: true, topic: republishTopic });
  } catch (error) {
    console.warn('[PartilharTela] Não foi possível avisar a sala da republicação:', error);
  }
}

/** Toca o aviso num AudioContext único. Áudio bloqueado por falta de interação é ignorado. */
export async function playShareSound(kind: ShareSound): Promise<void> {
  try {
    context ??= new AudioContext();
    await context.resume();
    if (context.state !== 'running') return;

    const start = context.currentTime + 0.01;
    notes[kind].forEach((frequency, index) => {
      const ctx = context!;
      const noteStart = start + index * noteDuration;
      const noteEnd = noteStart + noteDuration;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      // Envelope: ataque curto e release exponencial até quase zero, para não estalar.
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(peakGain, noteStart + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd + 0.02);
      oscillator.onended = () => gain.disconnect();
    });
  } catch {
    // Navegador sem permissão para tocar áudio agora: o aviso é opcional.
  }
}

/**
 * Liga os avisos de início/fim de compartilhamento numa Room já conectada.
 * Transmissões que existiam antes da chamada não tocam som. Remove os handlers ao desconectar.
 */
export function attachShareSounds(room: Room): () => void {
  const sharing = new Set<string>();
  const pendingStops = new Map<string, number>();
  const republishing = new Map<string, number>();

  for (const participant of [room.localParticipant, ...room.remoteParticipants.values()]) {
    if (participant.getTrackPublication(Track.Source.ScreenShare)) sharing.add(participant.identity);
  }

  const scheduleStop = (identity: string, delayMs: number) => {
    if (pendingStops.has(identity)) return;
    pendingStops.set(identity, window.setTimeout(() => {
      pendingStops.delete(identity);
      void playShareSound('stop');
    }, delayMs));
  };

  const markRepublishing = (identity: string) => {
    window.clearTimeout(republishing.get(identity));
    // O unpublish pode ter chegado antes do aviso: o "parou" pendente é cancelado.
    const pending = pendingStops.get(identity);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      pendingStops.delete(identity);
    }
    republishing.set(identity, window.setTimeout(() => {
      republishing.delete(identity);
      // A republicação não terminou (falhou ou foi abandonada): a transmissão parou de fato.
      if (!sharing.has(identity)) scheduleStop(identity, 0);
    }, republishTimeoutMs));
  };

  const started = (publication: TrackPublication, participant: Participant) => {
    if (publication.source !== Track.Source.ScreenShare) return;
    const identity = participant.identity;
    const republish = republishing.get(identity);
    const pending = pendingStops.get(identity);
    if (republish !== undefined || pending !== undefined) {
      // Republicação: cancela o "parou" e não toca "começou".
      window.clearTimeout(republish);
      window.clearTimeout(pending);
      republishing.delete(identity);
      pendingStops.delete(identity);
      sharing.add(identity);
      return;
    }
    if (sharing.has(identity)) return;
    sharing.add(identity);
    void playShareSound('start');
  };

  const stopped = (identity: string) => {
    if (!sharing.delete(identity) || republishing.has(identity)) return;
    scheduleStop(identity, republishWindowMs);
  };

  const onRemotePublished = (publication: TrackPublication, participant: Participant) => started(publication, participant);
  const onLocalPublished = (publication: TrackPublication, participant: Participant) => started(publication, participant);
  const onRemoteUnpublished = (publication: TrackPublication, participant: Participant) => {
    if (publication.source === Track.Source.ScreenShare) stopped(participant.identity);
  };
  const onLocalUnpublished = (publication: TrackPublication, participant: Participant) => {
    if (publication.source === Track.Source.ScreenShare) stopped(participant.identity);
  };
  // Quem sai transmitindo: o SDK costuma despublicar antes; `stopped` ignora a segunda chamada.
  const onParticipantDisconnected = (participant: Participant) => {
    const identity = participant.identity;
    const republish = republishing.get(identity);
    if (republish !== undefined) {
      // Saiu no meio de uma republicação: a transmissão acabou.
      window.clearTimeout(republish);
      republishing.delete(identity);
      sharing.delete(identity);
      scheduleStop(identity, 0);
      return;
    }
    stopped(identity);
  };
  const onData = (_payload: Uint8Array, participant?: Participant, _kind?: unknown, topic?: string) => {
    if (topic === republishTopic && participant) markRepublishing(participant.identity);
  };

  room.on(RoomEvent.TrackPublished, onRemotePublished);
  room.on(RoomEvent.LocalTrackPublished, onLocalPublished);
  room.on(RoomEvent.TrackUnpublished, onRemoteUnpublished);
  room.on(RoomEvent.LocalTrackUnpublished, onLocalUnpublished);
  room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  room.on(RoomEvent.DataReceived, onData);
  localRepublish.set(room, () => markRepublishing(room.localParticipant.identity));

  const detach = () => {
    pendingStops.forEach((timer) => window.clearTimeout(timer));
    pendingStops.clear();
    republishing.forEach((timer) => window.clearTimeout(timer));
    republishing.clear();
    localRepublish.delete(room);
    room.off(RoomEvent.TrackPublished, onRemotePublished);
    room.off(RoomEvent.LocalTrackPublished, onLocalPublished);
    room.off(RoomEvent.TrackUnpublished, onRemoteUnpublished);
    room.off(RoomEvent.LocalTrackUnpublished, onLocalUnpublished);
    room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.off(RoomEvent.DataReceived, onData);
    room.off(RoomEvent.Disconnected, detach);
  };
  room.on(RoomEvent.Disconnected, detach);
  return detach;
}
