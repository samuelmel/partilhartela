import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { customAlphabet } from 'nanoid';
import { AccessToken } from 'livekit-server-sdk';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? process.env.SERVER_PORT ?? 8787);
const livekitUrl = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
const apiKey = process.env.LIVEKIT_API_KEY ?? 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET ?? 'secret';
const createCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const rooms = new Set<string>();

// Validation functions
function isValidRoomCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(code);
}

function normalizeNickname(value: unknown): string {
  const nickname = typeof value === 'string' ? value.trim() : '';
  return nickname.slice(0, 32) || 'Visitante';
}

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

    const jwt = await token.toJwt();

    return reply.send({
      code,
      roomName: roomNameFromCode(code),
      token: jwt,
      livekitUrl,
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
    if (!rooms.has(code)) {
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

// Start server
const startServer = async () => {
  try {
    await app.register(cors, { origin: true });
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