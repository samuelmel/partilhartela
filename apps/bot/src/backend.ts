// Cliente da API interna do servidor (apps/server, rotas /internal). O bot não guarda estado:
// salas, mensagens e voice states ficam no SQLite do servidor.

const baseUrl = (process.env.BACKEND_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const secret = process.env.BOT_API_SECRET ?? '';

export type ChannelRoom = {
  code: string;
  joinUrl: string;
  guildId: string;
  channelId: string;
  channelName: string | null;
  messageChannelId: string | null;
  messageId: string | null;
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'X-Bot-Secret': secret, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(`${method} ${path} -> ${response.status} ${error?.error ?? ''}`.trim());
  }
  return response.json() as Promise<T>;
}

const channelPath = (guildId: string, channelId: string) => `/internal/channels/${guildId}/${channelId}/room`;

export const backend = {
  configured: Boolean(secret),
  baseUrl,
  ensureRoom: (guildId: string, channelId: string, channelName: string) =>
    call<ChannelRoom & { created: boolean }>('PUT', channelPath(guildId, channelId), { channelName }),
  setMessage: (guildId: string, channelId: string, messageChannelId: string, messageId: string) =>
    call<{ ok: true }>('PUT', `${channelPath(guildId, channelId)}/message`, { messageChannelId, messageId }),
  endRoom: (guildId: string, channelId: string) =>
    call<{ ended: false } | ({ ended: true } & ChannelRoom)>('DELETE', channelPath(guildId, channelId)),
  listAllRooms: () => call<{ rooms: ChannelRoom[] }>('GET', '/internal/channel-rooms'),
  listRooms: (guildId: string) => call<{ rooms: ChannelRoom[] }>('GET', `/internal/guilds/${guildId}/rooms`),
  replaceVoiceStates: (guildId: string, states: Array<{ userId: string; channelId: string }>) =>
    call<{ ok: true }>('PUT', `/internal/guilds/${guildId}/voice-states`, { states }),
  setVoiceState: (guildId: string, userId: string, channelId: string | null) =>
    call<{ ok: true }>('PUT', '/internal/voice-states', { guildId, userId, channelId })
};
