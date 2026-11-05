import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { AlertIcon, BrandMark, ScreenIcon, UsersIcon } from '../../../shared/ui/icons';
import { Avatar } from '../../../shared/ui/Avatar';
import { RoomCode } from '../../../shared/ui/RoomSidebar';
import type { DiscordApi } from './discordSession';
import { connectRoom, createRoomGrant, readNickname, requestGrant, SessionExpiredError, storeNickname, type RoomGrant, type Session } from './session';

const codePattern = /^[A-Z0-9]{6}$/;

export function Home({
  initialCode,
  initialError,
  discord,
  autoJoin,
  onEnter
}: {
  initialCode: string;
  initialError: string;
  discord: DiscordApi;
  /** Código vindo de um link partilhartela://join/CODIGO: entra sozinho quando há como se identificar. */
  autoJoin?: string;
  onEnter: (session: Session) => void;
}): JSX.Element {
  const [nickname, setNickname] = useState(readNickname);
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [nicknameMissing, setNicknameMissing] = useState(false);
  const invited = codePattern.test(initialCode.toUpperCase());

  const discordUser = discord.session?.user;

  async function connect(grant: RoomGrant): Promise<void> {
    const room = await connectRoom(grant);
    onEnter({ room, code: grant.code, hostKey: grant.hostKey });
  }

  async function runDiscord(kind: 'login' | 'voice'): Promise<void> {
    setError('');
    setBusy(true);
    try {
      if (kind === 'login') {
        await discord.login();
        setBusy(false);
        return;
      }
      const voice = await discord.findVoiceRoom();
      await connect(await requestGrant(voice.code, discordUser?.name ?? ''));
    } catch (reason) {
      if (reason instanceof SessionExpiredError) await discord.expire();
      setError(reason instanceof Error ? reason.message : 'Não foi possível falar com o Discord.');
      setBusy(false);
    }
  }

  async function enter(kind: 'join' | 'create' = 'join', forcedCode?: string): Promise<void> {
    // Com login, o nome vem do Discord (o servidor ignora o apelido).
    const name = discordUser?.name ?? nickname.trim();
    const normalized = (forcedCode ?? code).trim().toUpperCase();
    setError('');
    if (!name) {
      setNicknameMissing(true);
      setError('Escolha um apelido para aparecer na sala.');
      document.getElementById('nickname')?.focus();
      return;
    }
    if (kind === 'join' && !codePattern.test(normalized)) {
      setError('O código tem 6 letras ou números, como K7RM2Q.');
      document.getElementById('room-code')?.focus();
      return;
    }

    setBusy(true);
    try {
      if (!discordUser) storeNickname(name);
      await connect(kind === 'create' ? await createRoomGrant(name) : await requestGrant(normalized, name));
    } catch (reason) {
      if (reason instanceof SessionExpiredError) await discord.expire();
      setError(reason instanceof Error ? reason.message : 'Não foi possível entrar na sala.');
      setBusy(false);
    }
  }

  // Link partilhartela://join/CODIGO: espera a sessão carregar para entrar já com ela.
  useEffect(() => {
    if (!autoJoin || discord.loading) return;
    if (discord.session || nickname.trim()) void enter('join', autoJoin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoJoin, discord.loading]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    void enter('join');
  }

  return (
    <div className="home">
      <header className="home-head">
        <span className="brand"><BrandMark />PartilharTela</span>
      </header>

      <main className="home-body is-single">
        <section className="home-start" aria-labelledby="start-title">
          <span className="home-mark" aria-hidden="true"><ScreenIcon size={22} /></span>
          {invited ? (
            <>
              <h1 id="start-title">Você foi convidado para uma sala</h1>
              <p className="home-lead">Escolha como aparecer e entre. Lá dentro você assiste e, se quiser, também transmite a sua tela.</p>
            </>
          ) : (
            <>
              <h1 id="start-title">Assista à tela de quem te chamou</h1>
              <p className="home-lead">Crie uma sala e mande o código, ou entre com o código de 6 caracteres de quem te chamou.</p>
            </>
          )}

          <div className="home-discord">
            {discordUser ? (
              <>
                <div className="home-discord-user">
                  <Avatar identity={discordUser.id} name={discordUser.name} url={discordUser.avatarUrl} />
                  <span>
                    <strong>{discordUser.name}</strong>
                    <small>Conectado com o Discord</small>
                  </span>
                  <button type="button" className="btn btn-quiet" onClick={() => void discord.logout()} disabled={busy}>Sair</button>
                </div>
                <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => void runDiscord('voice')} disabled={busy} aria-busy={busy}>
                  <UsersIcon size={18} />Entrar na call atual
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-lg btn-block" onClick={() => void runDiscord('login')} disabled={busy || discord.loading} aria-busy={busy}>
                {busy ? 'Aguardando o Discord no navegador…' : 'Entrar com Discord'}
              </button>
            )}
          </div>

          {!discordUser && <div className="field">
            <label className="field-label" htmlFor="nickname">Seu apelido</label>
            <input
              id="nickname"
              className="input"
              value={nickname}
              maxLength={32}
              autoComplete="nickname"
              placeholder="Como você quer aparecer"
              aria-invalid={nicknameMissing && !nickname.trim()}
              onChange={(event) => {
                setNickname(event.target.value);
                setNicknameMissing(false);
              }}
              disabled={busy}
            />
          </div>}

          {!invited && (
            <button className="btn btn-primary btn-lg btn-block" type="button" onClick={() => void enter('create')} disabled={busy}>
              <ScreenIcon size={18} />Criar sala
            </button>
          )}

          {invited ? (
            <form className="invite" onSubmit={submit}>
              <RoomCode code={initialCode.toUpperCase()} />
              <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy} aria-busy={busy}>
                {busy && <span className="spinner" aria-hidden="true" />}
                {busy ? 'Entrando…' : 'Entrar na sala'}
              </button>
            </form>
          ) : (
            <form className="join" onSubmit={submit} aria-labelledby="join-title">
              <h2 id="join-title" className="join-title">Código da sala</h2>
              <div className="join-row">
                <label className="sr-only" htmlFor="room-code">Código da sala</label>
                <input
                  id="room-code"
                  className="input code-input"
                  value={code}
                  maxLength={6}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="CÓDIGO"
                  onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  disabled={busy}
                />
                <button className="btn btn-primary" type="submit" disabled={busy} aria-busy={busy}>
                  {busy && <span className="spinner" aria-hidden="true" />}
                  {busy ? 'Entrando…' : 'Entrar'}
                </button>
              </div>
            </form>
          )}

          <div aria-live="assertive">
            {error && <p className="notice notice-error"><AlertIcon size={18} />{error}</p>}
          </div>
        </section>
      </main>
    </div>
  );
}
