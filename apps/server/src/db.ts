import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Banco local (SQLite embutido no Node 22.13+): salas, sessões do Discord e voice states que o bot informa.
// Reiniciar o servidor não derruba mais as salas; a imagem do modo RPG continua só em memória.

export type RoomRow = {
  code: string;
  room_name: string;
  host_key: string | null;
  /** null = sala de canal do Discord, que vive enquanto o canal tiver gente. */
  expires_at: number | null;
  guild_id: string | null;
  channel_id: string | null;
  channel_name: string | null;
  message_channel_id: string | null;
  message_id: string | null;
};

export type UserRow = { id: string; username: string; global_name: string | null; avatar: string | null };

const databasePath = path.resolve(process.env.DATABASE_PATH ?? 'data/partilhartela.db');
mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    room_name TEXT NOT NULL,
    host_key TEXT,
    expires_at INTEGER,
    guild_id TEXT,
    channel_id TEXT,
    channel_name TEXT,
    message_channel_id TEXT,
    message_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS rooms_channel ON rooms (guild_id, channel_id) WHERE channel_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    global_name TEXT,
    avatar TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS voice_states (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
`);

// Avisado quando salas somem (expiração ou fim do canal), para liberar o que vive só em memória (RPG).
let roomsDeleted: (codes: string[]) => void = () => undefined;
export function onRoomsDeleted(listener: (codes: string[]) => void): void {
  roomsDeleted = listener;
}

const roomColumns = 'code, room_name, host_key, expires_at, guild_id, channel_id, channel_name, message_channel_id, message_id';

export function pruneExpired(now = Date.now()): void {
  const expired = db.prepare('DELETE FROM rooms WHERE expires_at IS NOT NULL AND expires_at <= ? RETURNING code').all(now) as Array<{ code: string }>;
  if (expired.length > 0) roomsDeleted(expired.map((row) => row.code));
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

export function findRoomByCode(code: string): RoomRow | undefined {
  const row = db.prepare(`SELECT ${roomColumns} FROM rooms WHERE code = ?`).get(code) as RoomRow | undefined;
  if (row?.expires_at != null && row.expires_at <= Date.now()) {
    deleteRoom(code);
    return undefined;
  }
  return row;
}

export function codeExists(code: string): boolean {
  return db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code) !== undefined;
}

export function insertCodeRoom(code: string, roomName: string, hostKey: string, expiresAt: number): void {
  db.prepare('INSERT INTO rooms (code, room_name, host_key, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(code, roomName, hostKey, expiresAt, Date.now());
}

export function findChannelRoom(guildId: string, channelId: string): RoomRow | undefined {
  return db.prepare(`SELECT ${roomColumns} FROM rooms WHERE guild_id = ? AND channel_id = ?`)
    .get(guildId, channelId) as RoomRow | undefined;
}

export function listChannelRooms(guildId: string): RoomRow[] {
  return db.prepare(`SELECT ${roomColumns} FROM rooms WHERE guild_id = ? AND channel_id IS NOT NULL`)
    .all(guildId) as RoomRow[];
}

export function insertChannelRoom(code: string, roomName: string, guildId: string, channelId: string, channelName: string | null): void {
  db.prepare(`INSERT INTO rooms (code, room_name, guild_id, channel_id, channel_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(code, roomName, guildId, channelId, channelName, Date.now());
}

export function updateChannelName(code: string, channelName: string): void {
  db.prepare('UPDATE rooms SET channel_name = ? WHERE code = ?').run(channelName, code);
}

export function setRoomMessage(code: string, messageChannelId: string, messageId: string): void {
  db.prepare('UPDATE rooms SET message_channel_id = ?, message_id = ? WHERE code = ?').run(messageChannelId, messageId, code);
}

export function deleteRoom(code: string): void {
  db.prepare('DELETE FROM rooms WHERE code = ?').run(code);
  roomsDeleted([code]);
}

export function listAllChannelRooms(): RoomRow[] {
  return db.prepare(`SELECT ${roomColumns} FROM rooms WHERE channel_id IS NOT NULL`).all() as RoomRow[];
}

export function upsertUser(user: UserRow): void {
  db.prepare(`INSERT INTO users (id, username, global_name, avatar, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET username = excluded.username, global_name = excluded.global_name,
      avatar = excluded.avatar, updated_at = excluded.updated_at`)
    .run(user.id, user.username, user.global_name, user.avatar, Date.now());
}

export function insertSession(tokenHash: string, userId: string, expiresAt: number): void {
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt);
}

export function findSessionUser(tokenHash: string): UserRow | undefined {
  return db.prepare(`SELECT u.id, u.username, u.global_name, u.avatar FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
    .get(tokenHash, Date.now()) as UserRow | undefined;
}

export function deleteSession(tokenHash: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function setVoiceState(guildId: string, userId: string, channelId: string | null): void {
  if (channelId) {
    db.prepare(`INSERT INTO voice_states (guild_id, user_id, channel_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`)
      .run(guildId, userId, channelId, Date.now());
  } else {
    db.prepare('DELETE FROM voice_states WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
  }
}

/** Substitui os voice states de um servidor inteiro (o bot manda tudo ao iniciar). */
export function replaceGuildVoiceStates(guildId: string, states: Array<{ userId: string; channelId: string }>): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM voice_states WHERE guild_id = ?').run(guildId);
    const insert = db.prepare('INSERT INTO voice_states (guild_id, user_id, channel_id, updated_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    for (const state of states) insert.run(guildId, state.userId, state.channelId, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Canal de voz mais recente do usuário (pode estar em mais de um servidor com o bot). */
export function findUserVoiceState(userId: string): { guild_id: string; channel_id: string } | undefined {
  return db.prepare('SELECT guild_id, channel_id FROM voice_states WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(userId) as { guild_id: string; channel_id: string } | undefined;
}
