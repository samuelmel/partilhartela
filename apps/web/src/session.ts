import { Room } from 'livekit-client';
import { describeConnectError } from '../../../shared/ui/roomState';
import { attachShareSounds } from '../../../shared/ui/shareSounds';

export const tokenServer = import.meta.env.VITE_TOKEN_SERVER_URL ?? 'http://localhost:8787';
// Página "latest" das Releases: o nome do .exe muda a cada versão, então não há link direto estável.
export const downloadUrl = import.meta.env.VITE_DOWNLOAD_URL ?? 'https://github.com/samuelmel/partilhartela/releases/latest';

export type RoomGrant = { code: string; roomName: string; token: string; livekitUrl: string };
export type Session = { room: Room; code: string };

/** `/rooms` cria a sala; `/rooms/:code/token` entra numa existente. Mesmas rotas do desktop. */
export async function requestGrant(path: string, nickname: string): Promise<RoomGrant> {
  let response: Response;
  try {
    response = await fetch(`${tokenServer}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname })
    });
  } catch {
    throw new Error('O servidor de salas não respondeu. Verifique sua internet; se ele estava parado, tente de novo em alguns segundos.');
  }

  const data = await response.json().catch(() => null) as Partial<RoomGrant> & { error?: string } | null;
  if (response.status === 429) {
    throw new Error('Muitas tentativas em pouco tempo. Espere um minuto e tente de novo.');
  }
  if (!response.ok || !data?.token || !data.livekitUrl || !data.code) {
    throw new Error(data?.error ?? 'O servidor de salas recusou o pedido. Tente de novo.');
  }
  return { code: data.code, roomName: data.roomName ?? '', token: data.token, livekitUrl: data.livekitUrl };
}

export async function connectRoom(grant: RoomGrant): Promise<Room> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    publishDefaults: { simulcast: false, videoCodec: 'h264' }
  });
  try {
    await room.connect(grant.livekitUrl, grant.token, { autoSubscribe: true });
    // Depois do connect: transmissões que já estavam na sala não tocam aviso.
    attachShareSounds(room);
    return room;
  } catch (error) {
    console.warn('[PartilharTela] Falha ao conectar no LiveKit:', error);
    await room.disconnect();
    throw new Error(describeConnectError(error));
  }
}

const nicknameKey = 'partilhartela.nickname';

export function readNickname(): string {
  try {
    return window.localStorage.getItem(nicknameKey) ?? '';
  } catch {
    return '';
  }
}

export function storeNickname(nickname: string): void {
  try {
    window.localStorage.setItem(nicknameKey, nickname);
  } catch {
    // Sem armazenamento: o apelido só não é lembrado na próxima visita.
  }
}

export function inviteLink(code: string): string {
  return `${window.location.origin}${window.location.pathname}?room=${code}`;
}

export function setRoomInUrl(code: string | undefined): void {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  window.history.replaceState(null, '', url);
}
