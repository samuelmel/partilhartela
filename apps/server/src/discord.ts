import { createHash, randomBytes } from 'node:crypto';
import type { UserRow } from './db.js';

// Login com Discord (OAuth2, escopo identify). O app desktop gera o PKCE e recebe o `code`;
// a troca pelo token acontece aqui porque só o servidor conhece o client secret.

export const discordClientId = process.env.DISCORD_CLIENT_ID ?? '';
const discordClientSecret = process.env.DISCORD_CLIENT_SECRET ?? '';
export const discordLoginEnabled = Boolean(discordClientId && discordClientSecret);

/** Precisam estar cadastradas em OAuth2 > Redirects no Developer Portal (iguais às do app desktop). */
export const allowedRedirectUris = ['http://127.0.0.1:53134/callback', 'partilhartela://auth/callback'];

const api = 'https://discord.com/api/v10';

export type DiscordProfile = { id: string; name: string; avatarUrl: string };

export function avatarUrl(user: Pick<UserRow, 'id' | 'avatar'>): string {
  if (user.avatar) {
    const extension = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128`;
  }
  // Avatar padrão do Discord para contas sem foto (regra dos nomes de usuário novos).
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function toProfile(user: UserRow): DiscordProfile {
  return { id: user.id, name: (user.global_name ?? user.username).slice(0, 32), avatarUrl: avatarUrl(user) };
}

export async function exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<UserRow> {
  const tokenResponse = await fetch(`${api}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: discordClientId,
      client_secret: discordClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    })
  });
  if (!tokenResponse.ok) {
    throw new Error(`Discord recusou o código (${tokenResponse.status}).`);
  }
  const token = await tokenResponse.json() as { access_token?: unknown; token_type?: unknown };
  if (typeof token.access_token !== 'string') throw new Error('Resposta do Discord sem access_token.');

  const userResponse = await fetch(`${api}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!userResponse.ok) throw new Error(`Falha ao ler o perfil no Discord (${userResponse.status}).`);
  const user = await userResponse.json() as Record<string, unknown>;
  if (typeof user.id !== 'string' || !/^\d{15,22}$/.test(user.id) || typeof user.username !== 'string') {
    throw new Error('Perfil do Discord inválido.');
  }
  // O access token do Discord não é guardado: só precisamos da identidade.
  return {
    id: user.id,
    username: user.username,
    global_name: typeof user.global_name === 'string' ? user.global_name : null,
    avatar: typeof user.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(user.avatar) ? user.avatar : null
  };
}

export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
