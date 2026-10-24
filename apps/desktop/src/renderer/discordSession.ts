import { useEffect, useRef, useState } from 'react';

// Sessão do Discord no desktop: o token de sessão do servidor fica cifrado pelo main (safeStorage);
// aqui só lemos, validamos com /me e anexamos como Authorization nas rotas de sala.

export type DiscordUser = { id: string; name: string; avatarUrl: string };
export type DiscordSession = { sessionToken: string; user: DiscordUser };
export type VoiceRoom = { code: string; channelName: string | null };

function parseSession(raw: string | null): DiscordSession | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<DiscordSession>;
    const user = value.user;
    if (typeof value.sessionToken === 'string' && user && typeof user.id === 'string' && typeof user.name === 'string' &&
      typeof user.avatarUrl === 'string') {
      return { sessionToken: value.sessionToken, user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl } };
    }
  } catch {
    // Arquivo corrompido: trata como sem sessão.
  }
  return undefined;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? fallback;
}

export function useDiscordSession(tokenServer: string) {
  const [session, setSession] = useState<DiscordSession>();
  const [loading, setLoading] = useState(true);
  const sessionRef = useRef<DiscordSession>();
  sessionRef.current = session;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = parseSession(await window.partilharTela.loadSession().catch(() => null));
      if (!stored) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const response = await fetch(`${tokenServer}/me`, { headers: { Authorization: `Bearer ${stored.sessionToken}` } });
        if (response.status === 401) {
          await window.partilharTela.clearSession().catch(() => undefined);
          return;
        }
        // Perfil atualizado (nome/avatar trocados no Discord desde o último login).
        const body = response.ok ? await response.json().catch(() => null) as { user?: DiscordUser } | null : null;
        if (!cancelled) setSession(body?.user ? { ...stored, user: body.user } : stored);
      } catch {
        // Servidor fora do ar: mantém a sessão salva; as rotas de sala avisam se ela tiver expirado.
        if (!cancelled) setSession(stored);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tokenServer]);

  async function login(): Promise<void> {
    let config: { enabled?: boolean; clientId?: string | null };
    try {
      config = await (await fetch(`${tokenServer}/auth/discord/config`)).json() as typeof config;
    } catch {
      throw new Error('Não foi possível acessar o servidor para entrar com o Discord.');
    }
    if (!config.enabled || !config.clientId) throw new Error('O login com Discord não está ativado neste servidor.');

    const grant = await window.partilharTela.authorizeDiscord(config.clientId);
    const response = await fetch(`${tokenServer}/auth/discord/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(grant)
    });
    if (!response.ok) throw new Error(await readError(response, 'O servidor não confirmou o login com Discord.'));
    const next = parseSession(JSON.stringify(await response.json()));
    if (!next) throw new Error('Resposta de login inválida.');
    setSession(next);
    try {
      await window.partilharTela.saveSession(JSON.stringify(next));
    } catch (err) {
      // Sem safeStorage a sessão vale só até fechar o app; o login segue funcionando.
      console.warn('[PartilharTela] Sessão não salva:', err);
    }
  }

  async function logout(): Promise<void> {
    const current = sessionRef.current;
    setSession(undefined);
    await window.partilharTela.clearSession().catch(() => undefined);
    if (current) {
      await fetch(`${tokenServer}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${current.sessionToken}` }
      }).catch(() => undefined);
    }
  }

  /** Sessão recusada pelo servidor (401): some daqui e do disco. */
  async function expire(): Promise<void> {
    setSession(undefined);
    await window.partilharTela.clearSession().catch(() => undefined);
  }

  async function findVoiceRoom(): Promise<VoiceRoom> {
    const current = sessionRef.current;
    if (!current) throw new Error('Entre com o Discord primeiro.');
    let response: Response;
    try {
      response = await fetch(`${tokenServer}/me/voice-room`, { headers: { Authorization: `Bearer ${current.sessionToken}` } });
    } catch {
      throw new Error('Não foi possível acessar o servidor de salas.');
    }
    if (response.status === 401) {
      await expire();
      throw new Error(await readError(response, 'Sua sessão do Discord expirou. Entre de novo.'));
    }
    if (!response.ok) throw new Error(await readError(response, 'Você não está numa call com o bot do PartilharTela.'));
    const body = await response.json() as { code?: unknown; channelName?: unknown };
    if (typeof body.code !== 'string') throw new Error('Resposta inválida do servidor.');
    return { code: body.code, channelName: typeof body.channelName === 'string' ? body.channelName : null };
  }

  return { session, sessionRef, loading, login, logout, expire, findVoiceRoom };
}
