import { useState, type FormEvent, type JSX } from 'react';
import { AlertIcon, BrandMark, ScreenIcon } from '../../../shared/ui/icons';
import { RoomCode } from '../../../shared/ui/RoomSidebar';
import { connectRoom, createRoomGrant, readNickname, requestGrant, storeNickname, type Session } from './session';

const codePattern = /^[A-Z0-9]{6}$/;

export function Home({
  initialCode,
  initialError,
  onEnter
}: {
  initialCode: string;
  initialError: string;
  onEnter: (session: Session) => void;
}): JSX.Element {
  const [nickname, setNickname] = useState(readNickname);
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [nicknameMissing, setNicknameMissing] = useState(false);
  const invited = codePattern.test(initialCode.toUpperCase());

  async function enter(kind: 'join' | 'create' = 'join'): Promise<void> {
    const name = nickname.trim();
    const normalized = code.trim().toUpperCase();
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
      storeNickname(name);
      const grant = kind === 'create' ? await createRoomGrant(name) : await requestGrant(normalized, name);
      const room = await connectRoom(grant);
      onEnter({ room, code: grant.code, hostKey: grant.hostKey });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível entrar na sala.');
      setBusy(false);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    void enter('join');
  }

  return (
    <div className="home">
      <header className="home-head">
        <span className="brand"><BrandMark />PartilharTela</span>
        <span className="home-phase">Fase 2 · transmissão</span>
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

          <div className="field">
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
          </div>

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
