import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { customAlphabet } from 'nanoid';
import { timingSafeEqual } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? process.env.SERVER_PORT ?? 8787);
const livekitUrl = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
if (process.env.NODE_ENV === 'production' && (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET)) {
  console.error('LIVEKIT_API_KEY e LIVEKIT_API_SECRET são obrigatórias em produção.');
  process.exit(1);
}
const apiKey = process.env.LIVEKIT_API_KEY ?? 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET ?? 'secret';
const createCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
// Código da sala -> instante de expiração (ms). Sem expiração o conjunto crescia sem limite.
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
// Modo RPG: imagem escolhida pelo criador que os espectadores veem no lugar da tela.
type RpgImage = { data: Buffer; type: string; version: number };
type RoomRecord = { expiresAt: number; hostKey: string; rpg?: RpgImage; rpgVersion: number };
const rooms = new Map<string, RoomRecord>();
// A metadata da sala no LiveKit avisa todos os participantes (e quem entra depois) do modo RPG.
const roomService = new RoomServiceClient(livekitUrl.replace(/^ws/, 'http'), apiKey, apiSecret);
const RPG_IMAGE_LIMIT = 5 * 1024 * 1024;
const rpgImageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function pruneExpiredRooms(now = Date.now()): void {
  for (const [code, room] of rooms) {
    if (room.expiresAt <= now) rooms.delete(code);
  }
}

function findRoom(code: string): RoomRecord | undefined {
  const room = rooms.get(code);
  if (room && room.expiresAt <= Date.now()) {
    rooms.delete(code);
    return undefined;
  }
  return room;
}

function isHost(room: RoomRecord, key: unknown): boolean {
  if (typeof key !== 'string') return false;
  const expected = Buffer.from(room.hostKey);
  const given = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
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

async function publishRpgState(code: string, room: RoomRecord): Promise<void> {
  const metadata = JSON.stringify({ rpg: room.rpg ? { version: room.rpg.version } : null });
  await roomService.updateRoomMetadata(roomNameFromCode(code), metadata);
}

// Validation functions
function isValidRoomCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(code);
}

function normalizeNickname(value: unknown): string {
  const nickname = typeof value === 'string' ? value.trim() : '';
  return nickname.slice(0, 32) || 'Visitante';
}

// Desktop e web só publicam a tela e o áudio dela; câmera e microfone ficam bloqueados no token.
const shareSources = [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];

function roomNameFromCode(code: string): string {
  return `partilhartela-${code.toUpperCase()}`;
}

// Health check endpoint
app.get('/health', async () => ({
  ok: true,
  timestamp: new Date().toISOString(),
  service: 'partilhartela-token-server'
}));

// Room creation endpoint
app.post<{ Body: { nickname?: string } }>('/rooms', async (request, reply) => {
  try {
    pruneExpiredRooms();
    const code = createCode();
    const hostKey = crypto.randomUUID();
    rooms.set(code, { expiresAt: Date.now() + ROOM_TTL_MS, hostKey, rpgVersion: 0 });
    const nickname = normalizeNickname(request.body?.nickname);

    const token = new AccessToken(apiKey, apiSecret, {
      identity: `${code}-presenter-${crypto.randomUUID()}`,
      name: nickname,
      ttl: '15m'
    });

    token.addGrant({
      room: roomNameFromCode(code),
      roomJoin: true,
      canPublish: true,
      canPublishSources: shareSources,
      canPublishData: true,
      canSubscribe: true
    });

    const jwt = await token.toJwt();

    return reply.send({
      code,
      roomName: roomNameFromCode(code),
      token: jwt,
      livekitUrl,
      // Só quem cria recebe: é o que autoriza ligar/desligar o modo RPG.
      hostKey,
      expiresIn: 15 * 60 // 15 minutes in seconds
    });
  } catch (error) {
    app.log.error({ err: error }, 'Error creating room:');
    return reply.code(500).send({
      error: 'Erro interno do servidor. Tente novamente.'
    });
  }
});

// Token generation endpoint
app.post<{ Params: { code: string }; Body: { nickname?: string } }>('/rooms/:code/token', async (request, reply) => {
  try {
    const code = request.params.code.toUpperCase();

    // Validate room code format
    if (!isValidRoomCode(code)) {
      return reply.code(400).send({
        error: 'Código de sala inválido. Use 6 caracteres alfanuméricos (ex: ABC123).'
      });
    }

    // Check if room exists
    if (!findRoom(code)) {
      return reply.code(404).send({
        error: 'Sala inexistente ou expirada. Solicite um novo código ao apresentador.'
      });
    }

    const nickname = normalizeNickname(request.body?.nickname);

    const token = new AccessToken(apiKey, apiSecret, {
      identity: `${code}-viewer-${crypto.randomUUID()}`,
      name: nickname,
      ttl: '15m'
    });

    token.addGrant({
      room: roomNameFromCode(code),
      roomJoin: true,
      canPublish: true,
      canPublishSources: shareSources,
      canPublishData: true,
      canSubscribe: true
    });

    const jwt = await token.toJwt();

    return reply.send({
      code,
      roomName: roomNameFromCode(code),
      token: jwt,
      livekitUrl,
      expiresIn: 15 * 60 // 15 minutes in seconds
    });
  } catch (error) {
    app.log.error({ err: error }, 'Error generating token:');
    return reply.code(500).send({
      error: 'Erro interno do servidor. Tente novamente.'
    });
  }
});

// Modo RPG: o criador envia a imagem (corpo binário) e a sala passa a mostrá-la no lugar da tela.
app.put<{ Params: { code: string }; Body: Buffer }>('/rooms/:code/rpg', { bodyLimit: RPG_IMAGE_LIMIT }, async (request, reply) => {
  const code = request.params.code.toUpperCase();
  const room = findRoom(code);
  if (!room) return reply.code(404).send({ error: 'Sala inexistente ou expirada.' });
  if (!isHost(room, request.headers['x-host-key'])) {
    return reply.code(403).send({ error: 'Só quem criou a sala pode usar o modo RPG.' });
  }
  const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? '';
  const data = request.body;
  if (!Buffer.isBuffer(data) || data.length === 0 || !matchesImageType(data, type)) {
    return reply.code(415).send({ error: 'Use uma imagem PNG, JPEG, WebP ou GIF.' });
  }

  const previous = room.rpg;
  room.rpgVersion += 1;
  room.rpg = { data, type, version: room.rpgVersion };
  try {
    await publishRpgState(code, room);
  } catch (error) {
    room.rpg = previous;
    app.log.error({ err: error }, 'Falha ao atualizar a metadata da sala');
    return reply.code(502).send({ error: 'Não foi possível avisar a sala. Tente de novo.' });
  }
  return reply.send({ version: room.rpg.version });
});

app.delete<{ Params: { code: string } }>('/rooms/:code/rpg', async (request, reply) => {
  const code = request.params.code.toUpperCase();
  const room = findRoom(code);
  if (!room) return reply.code(404).send({ error: 'Sala inexistente ou expirada.' });
  if (!isHost(room, request.headers['x-host-key'])) {
    return reply.code(403).send({ error: 'Só quem criou a sala pode usar o modo RPG.' });
  }
  const previous = room.rpg;
  room.rpg = undefined;
  try {
    await publishRpgState(code, room);
  } catch (error) {
    room.rpg = previous;
    app.log.error({ err: error }, 'Falha ao atualizar a metadata da sala');
    return reply.code(502).send({ error: 'Não foi possível avisar a sala. Tente de novo.' });
  }
  return reply.send({ ok: true });
});

app.get<{ Params: { code: string } }>('/rooms/:code/rpg/image', async (request, reply) => {
  const room = findRoom(request.params.code.toUpperCase());
  if (!room?.rpg) return reply.code(404).send({ error: 'A sala não está no modo RPG.' });
  return reply
    .header('Content-Type', room.rpg.type)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, max-age=3600')
    .send(room.rpg.data);
});

// Start server
const startServer = async () => {
  try {
    await app.register(cors, {
      origin: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-Host-Key']
    });
    app.addContentTypeParser(rpgImageTypes, { parseAs: 'buffer', bodyLimit: RPG_IMAGE_LIMIT }, (_request, body, done) => done(null, body));
    await app.register(rateLimit, { max: 30, timeWindow: '1 minute' });

    await app.listen({ port, host: '0.0.0.0' });

    app.log.info(`🚀 Servidor iniciado em http://0.0.0.0:${port}`);
    app.log.info(`📊 Health check disponível em http://0.0.0.0:${port}/health`);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      app.log.info('🛑 Recebido sinal de encerramento...');
      await app.close();
      process.exit(0);
    });
  } catch (error) {
    app.log.error({ err: error }, '❌ Falha ao iniciar o servidor:');
    process.exit(1);
  }
};

startServer();