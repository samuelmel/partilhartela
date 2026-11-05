import { Room } from 'livekit-client';
import { describeConnectError } from '../../../shared/ui/roomState';
import { attachShareSounds } from '../../../shared/ui/shareSounds';

export const tokenServer = import.meta.env.VITE_TOKEN_SERVER_URL ?? 'http://localhost:8787';
export const webAppUrl = import.meta.env.VITE_WEB_APP_URL ?? '';

/** `hostKey` só vem para quem criou a sala. */
export type RoomGrant = { code: string; roomName: string; token: string; livekitUrl: string; hostKey?: string };
export type Session = { room: Room; code: string; hostKey?: string };

/** `/rooms/:code/token` é a mesma rota usada pelo desktop e pela web. */
export async function requestGrant(code: string, nickname: string): Promise<RoomGrant> {
  return postGrant(`/rooms/${code}/token`, nickname);
}

/** `POST /rooms`: cria a sala e devolve o `hostKey` do criador (liga/desliga o modo RPG). */
export async function createRoomGrant(nickname: string): Promise<RoomGrant> {
  return postGrant('/rooms', nickname);
}

async function postGrant(path: string, nickname: string): Promise<RoomGrant> {
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
  if (response.status === 404) {
    throw new Error('Essa sala não existe mais. Confira o código com quem te convidou.');
  }
  if (response.status === 429) {
    throw new Error('Muitas tentativas em pouco tempo. Espere um minuto e tente de novo.');
  }
  if (!response.ok || !data?.token || !data.livekitUrl || !data.code) {
    throw new Error(data?.error ?? 'O servidor de salas recusou o pedido. Tente de novo.');
  }
  return { code: data.code, roomName: data.roomName ?? '', token: data.token, livekitUrl: data.livekitUrl, hostKey: data.hostKey };
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
    // Sem armazenamento: o apelido só não é lembrado na próxima abertura.
  }
}

/** Convite: link da web quando configurado; sem ele, copia apenas o código. */
export function inviteText(code: string): string {
  return webAppUrl ? `${webAppUrl.replace(/\/$/, '')}/?room=${code}` : code;
}

/** Token do participante de transmissão (`<identity>-share`), entregue ao Rust. Só publica, não assiste. */
export async function requestShareGrant(code: string, nickname: string, identity: string): Promise<{ url: string; token: string }> {
  let response: Response;
  try {
    response = await fetch(`${tokenServer}/rooms/${code}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, share: true, shareOf: identity })
    });
  } catch {
    throw new Error('O servidor de salas não respondeu. Tente de novo em alguns segundos.');
  }
  const data = await response.json().catch(() => null) as { token?: string; livekitUrl?: string; error?: string } | null;
  if (!response.ok || !data?.token || !data.livekitUrl) {
    throw new Error(data?.error ?? 'O servidor de salas recusou a transmissão. Tente de novo.');
  }
  return { url: data.livekitUrl, token: data.token };
}
