import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { customAlphabet } from 'nanoid';
import { AccessToken } from 'livekit-server-sdk';

const app = Fastify({ logger: true });
const port = Number(process.env.SERVER_PORT ?? 8787);
const livekitUrl = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
const apiKey = process.env.LIVEKIT_API_KEY ?? 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET ?? 'secret';
const createCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const rooms = new Set<string>();

await app.register(cors, { origin: true });
await app.register(rateLimit, { max: 30, timeWindow: '1 minute' });

type CreateRoomBody = { nickname?: string };
type TokenBody = { nickname?: string };

function normalizeNickname(value: unknown): string {
  const nickname = typeof value === 'string' ? value.trim() : '';
  return nickname.slice(0, 32) || 'Visitante';
}

function roomNameFromCode(code: string): string {
  return `partilhartela-${code.toUpperCase()}`;
}

app.get('/health', async () => ({ ok: true }));

app.post<{ Body: CreateRoomBody }>('/rooms', async (request, reply) => {
  const code = createCode();
  rooms.add(code);
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
    canPublishData: true,
    canSubscribe: true
  });
  return reply.send({ code, roomName: roomNameFromCode(code), token: await token.toJwt(), livekitUrl });
});

app.post<{ Params: { code: string }; Body: TokenBody }>('/rooms/:code/token', async (request, reply) => {
  const code = request.params.code.toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return reply.code(400).send({ error: 'Código de sala inválido.' });
  }
  if (!rooms.has(code)) {
    return reply.code(404).send({ error: 'Sala inexistente ou expirada.' });
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
    canPublishData: true,
    canSubscribe: true
  });
  return reply.send({ code, roomName: roomNameFromCode(code), token: await token.toJwt(), livekitUrl });
});

await app.listen({ port, host: '0.0.0.0' });
