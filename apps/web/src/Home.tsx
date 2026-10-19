import { useState, type FormEvent, type JSX } from 'react';
import { AlertIcon, BrandMark, CheckIcon, CloseIcon, DownloadIcon, ScreenIcon } from '../../../shared/ui/icons';
import { RoomCode } from '../../../shared/ui/RoomSidebar';
import type { CaptureSupport } from './capture';
import { connectRoom, downloadUrl, readNickname, requestGrant, storeNickname, type Session } from './session';

const codePattern = /^[A-Z0-9]{6}$/;

type Busy = 'create' | 'join' | null;

export function Home({
  initialCode,
  initialError,
  support,
  onEnter
}: {
  initialCode: string;
  initialError: string;
  support: CaptureSupport;
  onEnter: (session: Session) => void;
}): JSX.Element {
  const [nickname, setNickname] = useState(readNickname);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState(initialError);
  const [nicknameMissing, setNicknameMissing] = useState(false);
  const invited = codePattern.test(initialCode);

  async function enter(kind: 'create' | 'join'): Promise<void> {
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

    setBusy(kind);
    try {
      storeNickname(name);
      const grant = await requestGrant(kind === 'create' ? '/rooms' : `/rooms/${normalized}/token`, name);
      const room = await connectRoom(grant);
      onEnter({ room, code: grant.code, hostKey: grant.hostKey });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível entrar na sala.');
      setBusy(null);
    }
  }

  function submitJoin(event: FormEvent): void {
    event.preventDefault();
    void enter('join');
  }

  const working = busy !== null;

  return (
    <div className="home">
      <header className="home-head">
        <span className="brand"><BrandMark />PartilharTela</span>
        <a className="btn btn-quiet only-wide" href={downloadUrl} target="_blank" rel="noreferrer">
          <DownloadIcon size={18} />Baixar para Windows
        </a>
      </header>

      <main className="home-body">
        <section className="home-start" aria-labelledby="start-title">
          {invited ? (
            <>
              <h1 id="start-title">Você foi convidado para uma sala</h1>
              <p className="home-lead">Escolha como aparecer e entre. Lá dentro você assiste e, se quiser, também transmite a sua tela.</p>
            </>
          ) : (
            <>
              <h1 id="start-title">Mostre sua tela para quem você chamar</h1>
              <p className="home-lead">Crie uma sala, mande o código e quem entrar vê sua tela ao vivo, direto do navegador.</p>
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
              disabled={working}
            />
          </div>

          {invited ? (
            <form className="invite" onSubmit={submitJoin}>
              <RoomCode code={initialCode} />
              <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={working} aria-busy={busy === 'join'}>
                {busy === 'join' && <span className="spinner" aria-hidden="true" />}
                {busy === 'join' ? 'Entrando…' : 'Entrar na sala'}
              </button>
            </form>
          ) : (
            <>
              {support.ok ? (
                <button
                  type="button"
                  className="btn btn-primary btn-lg btn-block"
                  onClick={() => void enter('create')}
                  disabled={working}
                  aria-busy={busy === 'create'}
                >
                  {busy === 'create' ? <span className="spinner" aria-hidden="true" /> : <ScreenIcon />}
                  {busy === 'create' ? 'Criando sala…' : 'Compartilhar tela'}
                </button>
              ) : (
                <p className="notice notice-warn"><AlertIcon size={18} />{support.reason}</p>
              )}

              <form className="join" onSubmit={submitJoin} aria-labelledby="join-title">
                <h2 id="join-title" className="join-title">{support.ok ? 'Ou entre numa sala' : 'Entre numa sala'}</h2>
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
                    disabled={working}
                  />
                  <button className={`btn ${support.ok ? '' : 'btn-primary'}`} type="submit" disabled={working} aria-busy={busy === 'join'}>
                    {busy === 'join' && <span className="spinner" aria-hidden="true" />}
                    {busy === 'join' ? 'Entrando…' : 'Entrar'}
                  </button>
                </div>
              </form>
            </>
          )}

          <div aria-live="assertive">
            {error && <p className="notice notice-error"><AlertIcon size={18} />{error}</p>}
          </div>
        </section>

        <aside className="home-compare" aria-labelledby="compare-title">
          <h2 id="compare-title">Navegador ou app para Windows</h2>
          <p className="compare-intro">Os dois entram nas mesmas salas. O app vai além no som: escolhe de qual programa o áudio sai.</p>
          <table className="compare">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Recurso</span></th>
                <th scope="col">Navegador</th>
                <th scope="col">App Windows</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Assistir uma sala</th>
                <td><Yes />Sim</td>
                <td><Yes />Sim</td>
              </tr>
              <tr>
                <th scope="row">Transmitir tela ou janela</th>
                <td><Yes />No computador</td>
                <td><Yes />Sim</td>
              </tr>
              <tr>
                <th scope="row">Som junto</th>
                <td>Aba do Chrome ou Edge; tela inteira no Windows</td>
                <td>Sistema inteiro ou só um aplicativo</td>
              </tr>
              <tr>
                <th scope="row">Deixar o Discord fora do som</th>
                <td><No />Não</td>
                <td><Yes />Sim</td>
              </tr>
              <tr>
                <th scope="row">Escolher a fonte</th>
                <td>Seletor do navegador</td>
                <td>Lista com miniaturas</td>
              </tr>
            </tbody>
          </table>
          <a className="btn btn-block" href={downloadUrl} target="_blank" rel="noreferrer">
            <DownloadIcon size={18} />Baixar aplicativo para Windows
          </a>
          <p className="compare-note">Instalador no GitHub Releases. Ele não tem assinatura digital, então o Windows pode pedir confirmação antes de abrir.</p>
        </aside>
      </main>
    </div>
  );
}

function Yes(): JSX.Element {
  return <span className="mark mark-yes"><CheckIcon size={15} /></span>;
}

function No(): JSX.Element {
  return <span className="mark mark-no"><CloseIcon size={15} /></span>;
}
