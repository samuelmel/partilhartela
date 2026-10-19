import { useEffect, useState } from 'react';
import { RemoteTrackPublication, RoomEvent, Track, type Room } from 'livekit-client';

// Modo RPG: o criador da sala escolhe uma imagem e quem assiste passa a ver só ela, ouvindo o
// áudio da transmissão (para não tomar spoiler). O estado vem da metadata da sala, que só o
// servidor de tokens altera; a imagem fica no servidor e é baixada como blob (CSP do desktop).

export type RpgState = { active: boolean; imageUrl?: string };

const inactive: RpgState = { active: false };
// Acima disso (ou em formato que o servidor não aceita) a imagem é reduzida no navegador.
const rawUploadLimit = 4 * 1024 * 1024;
const acceptedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const maxSide = 1920;

function readRpgVersion(metadata: string | undefined): number | undefined {
  if (!metadata) return undefined;
  try {
    const version = (JSON.parse(metadata) as { rpg?: { version?: unknown } | null }).rpg?.version;
    return typeof version === 'number' ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Aplica o modo RPG nesta conexão: como espectador, deixa de receber o vídeo das telas (o áudio
 * continua); como apresentador, pausa o envio do vídeo (`mute`), então nada da tela sai daqui.
 */
// Telas que o modo RPG desinscreveu; ao desligar, só elas voltam (o resto segue o autoSubscribe).
const hiddenByRpg = new WeakSet<RemoteTrackPublication>();

function enforce(room: Room, active: boolean): void {
  for (const participant of room.remoteParticipants.values()) {
    const screen = participant.getTrackPublication(Track.Source.ScreenShare);
    if (!(screen instanceof RemoteTrackPublication)) continue;
    if (active && screen.isDesired) {
      hiddenByRpg.add(screen);
      screen.setSubscribed(false);
    } else if (!active && hiddenByRpg.has(screen)) {
      hiddenByRpg.delete(screen);
      screen.setSubscribed(true);
    }
  }
  const local = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  if (local?.track && local.isMuted !== active) {
    void (active ? local.mute() : local.unmute()).catch((error: unknown) => {
      console.warn('[PartilharTela] Não foi possível aplicar o modo RPG na sua transmissão:', error);
    });
  }
}

export function useRpgMode(room: Room | undefined, tokenServer: string, code: string): RpgState {
  const [version, setVersion] = useState<number>();
  const [imageUrl, setImageUrl] = useState<string>();
  const active = version !== undefined;

  useEffect(() => {
    if (!room) {
      setVersion(undefined);
      return;
    }
    const update = () => setVersion(readRpgVersion(room.metadata));
    update();
    room.on(RoomEvent.RoomMetadataChanged, update);
    return () => {
      room.off(RoomEvent.RoomMetadataChanged, update);
    };
  }, [room]);

  // Telas publicadas depois (ou republicadas pelo desktop) também seguem o modo.
  useEffect(() => {
    if (!room) return;
    const apply = () => enforce(room, active);
    apply();
    room.on(RoomEvent.TrackPublished, apply);
    room.on(RoomEvent.TrackSubscribed, apply);
    room.on(RoomEvent.LocalTrackPublished, apply);
    return () => {
      room.off(RoomEvent.TrackPublished, apply);
      room.off(RoomEvent.TrackSubscribed, apply);
      room.off(RoomEvent.LocalTrackPublished, apply);
    };
  }, [room, active]);

  useEffect(() => {
    if (version === undefined) {
      setImageUrl(undefined);
      return;
    }
    let url: string | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${tokenServer}/rooms/${code}/rpg/image?v=${version}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      } catch (error) {
        console.warn('[PartilharTela] Não foi possível baixar a imagem do modo RPG:', error);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [tokenServer, code, version]);

  return active ? { active, imageUrl } : inactive;
}

/** Reduz a imagem quando ela é grande demais ou num formato que o servidor não aceita. */
async function prepareImage(file: File): Promise<Blob> {
  if (acceptedTypes.includes(file.type) && file.size <= rawUploadLimit) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Não consegui abrir essa imagem. Tente um PNG ou JPEG.');
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) throw new Error('Não consegui preparar essa imagem. Tente outra.');
  return blob;
}

async function rpgRequest(url: string, init: RequestInit): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error('O servidor de salas não respondeu. Tente de novo.');
  }
  if (response.ok) return;
  const data = await response.json().catch(() => null) as { error?: string } | null;
  throw new Error(response.status === 413 ? 'Imagem grande demais. Escolha uma menor.' : data?.error ?? 'Não foi possível mudar o modo RPG.');
}

/** Liga o modo RPG (ou troca a imagem). Só funciona com a chave que o servidor deu a quem criou a sala. */
export async function enableRpg(tokenServer: string, code: string, hostKey: string, file: File): Promise<void> {
  const image = await prepareImage(file);
  await rpgRequest(`${tokenServer}/rooms/${code}/rpg`, {
    method: 'PUT',
    headers: { 'Content-Type': image.type, 'X-Host-Key': hostKey },
    body: image
  });
}

export async function disableRpg(tokenServer: string, code: string, hostKey: string): Promise<void> {
  await rpgRequest(`${tokenServer}/rooms/${code}/rpg`, { method: 'DELETE', headers: { 'X-Host-Key': hostKey } });
}
