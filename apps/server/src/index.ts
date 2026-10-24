import 'dotenv/config';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { customAlphabet } from 'nanoid';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import * as store from './db.js';
import {
  allowedRedirectUris,
  discordClientId,
  discordLoginEnabled,
  exchangeCode,
  hashSessionToken,
  newSessionToken,
  toProfile,
  type DiscordProfile
} from './discord.js';
import { joinPageCsp, renderJoinPage } from './joinPage.js';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? process.env.SERVER_PORT ?? 8787);
const livekitUrl = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
if (process.env.NODE_ENV === 'production' && (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET)) {
  console.error('LIVEKIT_API_KEY e LIVEKIT_API_SECRET são obrigatórias em produção.');
  process.exit(1);
}
const apiKey = process.env.LIVEKIT_API_KEY ?? 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET ?? 'secret';
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
// Segredo compartilhado com apps/bot; sem ele as rotas /internal ficam desligadas.
const botApiSecret = process.env.BOT_API_SECRET ?? '';
const createCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
// Salas por código expiram; salas de canal do Discord duram enquanto o canal tiver gente.
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Modo RPG: imagem escolhida pelo criador que os espectadores veem no lugar da tela (só em memória).
type RpgImage = { data: Buffer; type: string; version: number };
const rpgImages = new Map<string, { rpg?: RpgImage; version: number }>();
// Código expirado pode ser sorteado de novo: a imagem antiga não pode ir para a sala nova.
store.onRoomsDeleted((codes) => {
  for (const code of codes) rpgImages.delete(code);
});
// A metadata da sala no LiveKit avisa todos os participantes (e quem entra depois) do modo RPG.
const roomService = new RoomServiceClient(livekitUrl.replace(/^ws/, 'http'), apiKey, apiSecret);
const RPG_IMAGE_LIMIT = 5 * 1024 * 1024;
const rpgImageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const snowflake = /^\d{15,22}$/;

function safeEqual(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isHost(room: store.RoomRow, key: unknown): boolean {
  return room.host_key !== null && safeEqual(room.host_key, key);
}

// Confere a assinatura do arquivo: o Content-Type sozinho é só o que o cliente diz.
function matchesImageType(data: Buffer, type: string): boolean {
  switch (type) {
    case 'image/png':
      return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/gif':
      return data.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp':
      return data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
    default:
      return false;
  }
}

async function publishRpgState(room: store.RoomRow, rpg: RpgImage | undefined): Promise<void> {
  const metadata = JSON.stringify({ rpg: rpg ? { version: rpg.version } : null });
  await roomService.updateRoomMetadata(room.room_name, metadata);
}

function isValidRoomCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(code);
}

function normalizeNickname(value: unknown): string {
  const nickname = typeof value === 'string' ? value.trim() : '';
  return nickname.slice(0, 32) || 'Visitante';
}

// Desktop e web só publicam a tela e o áudio dela; câmera e microfone ficam bloqueados no token.
const shareSources = [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];

function newCode(): string {
  for (;;) {
    const code = createCode();
    if (!store.codeExists(code)) return code;
  }
}

function joinUrl(code: string): string {
  return `${publicBaseUrl}/join/${code}`;
}

/** Sessão do Discord no header Authorization. `null` = sem header; `undefined` = header inválido/expirado. */
function readSession(request: FastifyRequest): store.UserRow | null | undefined {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header);
  if (!match) return undefined;
  return store.findSessionUser(hashSessionToken(match[1]));
}

const sessionExpired = { error: 'Sua sessão do Discord expirou. Entre com o Discord de novo.' };
const loginRequired = { error: 'Entre com o Discord primeiro.' };

async function issueGrant(room: store.RoomRow, nickname: unknown, user: store.UserRow | null, hostKey?: string) {
  // Com login, a identity é o id do Discord e o avatar vai na metadata do participante.
  const profile: DiscordProfile | undefined = user ? toProfile(user) : undefined;
  const token = new AccessToken(apiKey, apiSecret, {
    identity: profile?.id ?? `${room.code}-${hostKey ? 'presenter' : 'viewer'}-${crypto.randomUUID()}`,
    name: profile?.name ?? normalizeNickname(nickname),
    metadata: profile ? JSON.stringify({ discord: { id: profile.id, avatarUrl: profile.avatarUrl } }) : undefined,
    ttl: '15m'
  });
  token.addGrant({
    room: room.room_name,
    roomJoin: true,
    canPublish: true,
    canPublishSources: shareSources,
    canPublishData: true,
    canSubscribe: true
  });
  return {
    code: room.code,
    roomName: room.room_name,
    token: await token.toJwt(),
    livekitUrl,
    // Só quem cria recebe: é o que autoriza ligar/desligar o modo RPG.
    ...(hostKey ? { hostKey } : {}),
    expiresIn: 15 * 60
  };
}

// Plugins antes das rotas: o rate limit se aplica às rotas declaradas depois do registro.
await app.register(cors, {
  origin: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Host-Key', 'Authorization']
});
app.addContentTypeParser(rpgImageTypes, { parseAs: 'buffer', bodyLimit: RPG_IMAGE_LIMIT }, (_request, body, done) => done(null, body));
await app.register(rateLimit, { max: 30, timeWindow: '1 minute' });

app.get('/health', { config: { rateLimit: false } }, async () => ({
  ok: true,
  timestamp: new Date().toISOString(),
  service: 'partilhartela-token-server'
}));

// ---------- Salas por código (fluxo original, agora com login opcional) ----------

app.post<{ Body: { nickname?: string } }>('/rooms', async (request, reply) => {
  const user = readSession(request);
  if (user === undefined) return reply.code(401).send(sessionExpired);
  try {
    store.pruneExpired();
    const code = newCode();
    const hostKey = crypto.randomUUID();
    store.insertCodeRoom(code, `partilhartela-${code}`, hostKey, Date.now() + ROOM_TTL_MS);
    const room = store.findRoomByCode(code)!;
    return reply.send(await issueGrant(room, request.body?.nickname, user, hostKey));
  } catch (error) {
    app.log.error({ err: error }, 'Erro ao criar sala');
    return reply.code(500).send({ error: 'Erro interno do servidor. Tente novamente.' });
  }
});

app.post<{ Params: { code: string }; Body: { nickname?: string } }>('/rooms/:code/token', async (request, reply) => {
  const code = request.params.code.toUpperCase();
  if (!isValidRoomCode(code)) {
    return reply.code(400).send({ error: 'Código de sala inválido. Use 6 caracteres alfanuméricos (ex: ABC123).' });
  }
  const user = readSession(request);
  if (user === undefined) return reply.code(401).send(sessionExpired);
  const room = store.findRoomByCode(code);
  if (!room) {
    return reply.code(404).send({ error: 'Sala inexistente ou expirada. Solicite um novo código ao apresentador.' });
  }
  try {
    return reply.send(await issueGrant(room, request.body?.nickname, user));
  } catch (error) {
    app.log.error({ err: error }, 'Erro ao gerar token');
    return reply.code(500).send({ error: 'Erro interno do servidor. Tente novamente.' });
  }
});

// ---------- Modo RPG ----------

app.put<{ Params: { code: string }; Body: Buffer }>('/rooms/:code/rpg', { bodyLimit: RPG_IMAGE_LIMIT }, async (request, reply) => {
  const code = request.params.code.toUpperCase();
  const room = store.findRoomByCode(code);
  if (!room) return reply.code(404).send({ error: 'Sala inexistente ou expirada.' });
  if (!isHost(room, request.headers['x-host-key'])) {
    return reply.code(403).send({ error: 'Só quem criou a sala pode usar o modo RPG.' });
  }
  const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? '';
  const data = request.body;
  if (!Buffer.isBuffer(data) || data.length === 0 || !matchesImageType(data, type)) {
    return reply.code(415).send({ error: 'Use uma imagem PNG, JPEG, WebP ou GIF.' });
  }

  const state = rpgImages.get(code) ?? { version: 0 };
  const previous = state.rpg;
  state.version += 1;
  state.rpg = { data, type, version: state.version };
  rpgImages.set(code, state);
  try {
    await publishRpgState(room, state.rpg);
  } catch (error) {
    state.rpg = previous;
    app.log.error({ err: error }, 'Falha ao atualizar a metadata da sala');
    return reply.code(502).send({ error: 'Não foi possível avisar a sala. Tente de novo.' });
  }
  return reply.send({ version: state.version });
});

app.delete<{ Params: { code: string } }>('/rooms/:code/rpg', async (request, reply) => {
  const code = request.params.code.toUpperCase();
  const room = store.findRoomByCode(code);
  if (!room) return reply.code(404).send({ error: 'Sala inexistente ou expirada.' });
  if (!isHost(room, request.headers['x-host-key'])) {
    return reply.code(403).send({ error: 'Só quem criou a sala pode usar o modo RPG.' });
  }
  const state = rpgImages.get(code);
  const previous = state?.rpg;
  if (state) state.rpg = undefined;
  try {
    await publishRpgState(room, undefined);
  } catch (error) {
    if (state) state.rpg = previous;
    app.log.error({ err: error }, 'Falha ao atualizar a metadata da sala');
    return reply.code(502).send({ error: 'Não foi possível avisar a sala. Tente de novo.' });
  }
  return reply.send({ ok: true });
});

app.get<{ Params: { code: string } }>('/rooms/:code/rpg/image', async (request, reply) => {
  const code = request.params.code.toUpperCase();
  const rpg = store.findRoomByCode(code) ? rpgImages.get(code)?.rpg : undefined;
  if (!rpg) return reply.code(404).send({ error: 'A sala não está no modo RPG.' });
  return reply
    .header('Content-Type', rpg.type)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, max-age=3600')
    .send(rpg.data);
});

// ---------- Link do Discord: /join/:code abre o app ----------

app.get<{ Params: { code: string } }>('/join/:code', async (request, reply) => {
  const code = request.params.code.toUpperCase();
  if (!isValidRoomCode(code)) return reply.code(404).type('text/plain; charset=utf-8').send('Sala não encontrada.');
  const { html, script } = renderJoinPage(code, Boolean(store.findRoomByCode(code)));
  const scriptHash = `sha256-${createHash('sha256').update(script).digest('base64')}`;
  return reply
    .header('Content-Security-Policy', joinPageCsp(scriptHash))
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .type('text/html; charset=utf-8')
    .send(html);
});

// ---------- Login com Discord ----------

app.get('/auth/discord/config', async () => ({
  enabled: discordLoginEnabled,
  clientId: discordLoginEnabled ? discordClientId : null,
  redirectUris: allowedRedirectUris
}));

app.post<{ Body: { code?: unknown; codeVerifier?: unknown; redirectUri?: unknown } }>(
  '/auth/discord/exchange',
  { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
  async (request, reply) => {
    if (!discordLoginEnabled) return reply.code(503).send({ error: 'Login com Discord não está configurado neste servidor.' });
    const { code, codeVerifier, redirectUri } = request.body ?? {};
    if (
      typeof code !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(code) ||
      typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier) ||
      typeof redirectUri !== 'string' || !allowedRedirectUris.includes(redirectUri)
    ) {
      return reply.code(400).send({ error: 'Pedido de login inválido.' });
    }
    let user: store.UserRow;
    try {
      user = await exchangeCode(code, codeVerifier, redirectUri);
    } catch (error) {
      app.log.warn({ err: error }, 'Falha no login com Discord');
      return reply.code(502).send({ error: 'O Discord não confirmou o login. Tente de novo.' });
    }
    store.upsertUser(user);
    store.pruneExpired();
    const session = newSessionToken();
    store.insertSession(session.hash, user.id, Date.now() + SESSION_TTL_MS);
    return reply.send({ sessionToken: session.token, user: toProfile(user) });
  }
);

app.post('/auth/logout', async (request, reply) => {
  const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
  if (match) store.deleteSession(hashSessionToken(match[1]));
  return reply.send({ ok: true });
});

app.get('/me', async (request, reply) => {
  const user = readSession(request);
  if (!user) return reply.code(401).send(user === null ? loginRequired : sessionExpired);
  return reply.send({ user: toProfile(user) });
});

app.get('/me/voice-room', async (request, reply) => {
  const user = readSession(request);
  if (!user) return reply.code(401).send(user === null ? loginRequired : sessionExpired);
  const state = store.findUserVoiceState(user.id);
  const room = state && store.findChannelRoom(state.guild_id, state.channel_id);
  if (!room) {
    return reply.code(404).send({ error: 'Você não está num canal de voz de um servidor com o bot do PartilharTela.' });
  }
  return reply.send({ code: room.code, guildId: room.guild_id, channelId: room.channel_id, channelName: room.channel_name });
});

// ---------- API interna do bot (apps/bot) ----------

function requireBot(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!botApiSecret) {
    void reply.code(503).send({ error: 'BOT_API_SECRET não configurado.' });
    return false;
  }
  if (!safeEqual(botApiSecret, request.headers['x-bot-secret'])) {
    void reply.code(401).send({ error: 'Segredo do bot inválido.' });
    return false;
  }
  return true;
}

const internal = { config: { rateLimit: false } } as const;

function channelRoomView(room: store.RoomRow) {
  return {
    code: room.code,
    joinUrl: joinUrl(room.code),
    guildId: room.guild_id,
    channelId: room.channel_id,
    channelName: room.channel_name,
    messageChannelId: room.message_channel_id,
    messageId: room.message_id
  };
}

type ChannelParams = { guildId: string; channelId: string };
const validChannel = (p: ChannelParams) => snowflake.test(p.guildId) && snowflake.test(p.channelId);

// Cria (ou reaproveita) a sala do canal de voz. Id da sala no LiveKit = guildId-channelId.
app.put<{ Params: ChannelParams; Body: { channelName?: unknown } }>('/internal/channels/:guildId/:channelId/room', internal, async (request, reply) => {
  if (!requireBot(request, reply)) return reply;
  const { guildId, channelId } = request.params;
  if (!validChannel(request.params)) return reply.code(400).send({ error: 'Ids inválidos.' });
  const channelName = typeof request.body?.channelName === 'string' ? request.body.channelName.slice(0, 100) : null;
  let room = store.findChannelRoom(guildId, channelId);
  const created = !room;
  if (!room) {
    store.insertChannelRoom(newCode(), `partilhartela-dc-${guildId}-${channelId}`, guildId, channelId, channelName);
    room = store.findChannelRoom(guildId, channelId)!;
  } else if (channelName && channelName !== room.channel_name) {
    store.updateChannelName(room.code, channelName);
    room = { ...room, channel_name: channelName };
  }
  return reply.send({ ...channelRoomView(room), created });
});

app.put<{ Params: ChannelParams; Body: { messageChannelId?: unknown; messageId?: unknown } }>(
  '/internal/channels/:guildId/:channelId/room/message',
  internal,
  async (request, reply) => {
    if (!requireBot(request, reply)) return reply;
    const { messageChannelId, messageId } = request.body ?? {};
    if (!validChannel(request.params) || typeof messageChannelId !== 'string' || !snowflake.test(messageChannelId) ||
      typeof messageId !== 'string' || !snowflake.test(messageId)) {
      return reply.code(400).send({ error: 'Ids inválidos.' });
    }
    const room = store.findChannelRoom(request.params.guildId, request.params.channelId);
    if (!room) return reply.code(404).send({ error: 'Sala não encontrada.' });
    store.setRoomMessage(room.code, messageChannelId, messageId);
    return reply.send({ ok: true });
  }
);

// Canal esvaziou: apaga a sala e derruba quem ainda estava nela no LiveKit.
app.delete<{ Params: ChannelParams }>('/internal/channels/:guildId/:channelId/room', internal, async (request, reply) => {
  if (!requireBot(request, reply)) return reply;
  if (!validChannel(request.params)) return reply.code(400).send({ error: 'Ids inválidos.' });
  const room = store.findChannelRoom(request.params.guildId, request.params.channelId);
  if (!room) return reply.send({ ended: false });
  store.deleteRoom(room.code);
  roomService.deleteRoom(room.room_name).catch(() => undefined);
  return reply.send({ ended: true, ...channelRoomView(room) });
});

// Todas as salas de canal: o bot encerra as de servidores dos quais saiu enquanto estava desligado.
app.get('/internal/channel-rooms', internal, async (request, reply) => {
  if (!requireBot(request, reply)) return reply;
  return reply.send({ rooms: store.listAllChannelRooms().map(channelRoomView) });
});

app.get<{ Params: { guildId: string } }>('/internal/guilds/:guildId/rooms', internal, async (request, reply) => {
  if (!requireBot(request, reply)) return reply;
  if (!snowflake.test(request.params.guildId)) return reply.code(400).send({ error: 'Id inválido.' });
  return reply.send({ rooms: store.listChannelRooms(request.params.guildId).map(channelRoomView) });
});

function parseStates(value: unknown): Array<{ userId: string; channelId: string }> | undefined {
  if (!Array.isArray(value) || value.length > 50_000) return undefined;
  const states: Array<{ userId: string; channelId: string }> = [];
  for (const item of value) {
    const entry = item as { userId?: unknown; channelId?: unknown } | null;
    if (typeof entry?.userId !== 'string' || !snowflake.test(entry.userId) ||
      typeof entry.channelId !== 'string' || !snowflake.test(entry.channelId)) return undefined;
    states.push({ userId: entry.userId, channelId: entry.channelId });
  }
  return states;
}

app.put<{ Params: { guildId: string }; Body: { states?: unknown } }>(
  '/internal/guilds/:guildId/voice-states',
  { ...internal, bodyLimit: 4 * 1024 * 1024 },
  async (request, reply) => {
    if (!requireBot(request, reply)) return reply;
    const states = parseStates(request.body?.states);
    if (!snowflake.test(request.params.guildId) || !states) return reply.code(400).send({ error: 'Voice states inválidos.' });
    store.replaceGuildVoiceStates(request.params.guildId, states);
    return reply.send({ ok: true });
  }
);

app.put<{ Body: { guildId?: unknown; userId?: unknown; channelId?: unknown } }>('/internal/voice-states', internal, async (request, reply) => {
  if (!requireBot(request, reply)) return reply;
  const { guildId, userId, channelId } = request.body ?? {};
  if (typeof guildId !== 'string' || !snowflake.test(guildId) || typeof userId !== 'string' || !snowflake.test(userId) ||
    (channelId !== null && (typeof channelId !== 'string' || !snowflake.test(channelId)))) {
    return reply.code(400).send({ error: 'Voice state inválido.' });
  }
  store.setVoiceState(guildId, userId, channelId);
  return reply.send({ ok: true });
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`Servidor iniciado em http://0.0.0.0:${port} (links públicos: ${publicBaseUrl})`);
  if (!discordLoginEnabled) app.log.info('Login com Discord desligado: defina DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET.');
  if (!botApiSecret) app.log.info('API do bot desligada: defina BOT_API_SECRET (igual no apps/bot).');
  process.on('SIGINT', () => {
    void app.close().then(() => process.exit(0));
  });
} catch (error) {
  app.log.error({ err: error }, 'Falha ao iniciar o servidor');
  process.exit(1);
}
