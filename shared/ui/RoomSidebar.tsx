import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { ConnectionState } from 'livekit-client';
import { describeConnection, type Member } from './roomState';
import { Avatar } from './Avatar';
import { CheckIcon, CloseIcon, CopyIcon, LeaveIcon, ScreenIcon } from './icons';

export function RoomCode({ code }: { code: string }): JSX.Element {
  return (
    <span className="room-code" role="img" aria-label={`Código ${code.split('').join(' ')}`}>
      {code.split('').map((char, index) => <span key={index} aria-hidden="true">{char}</span>)}
    </span>
  );
}

function MemberRow({ member }: { member: Member }): JSX.Element {
  return (
    <li className="member">
      <Avatar identity={member.identity} name={member.name} url={member.avatarUrl} />
      <span className="member-name">
        {member.name}
        {member.isLocal && <span className="member-you"> (você)</span>}
      </span>
      {member.sharing && (
        <span className="member-live" title="Transmitindo a tela">
          <ScreenIcon size={14} />
          <span>Ao vivo</span>
        </span>
      )}
    </li>
  );
}

export function RoomSidebar({
  code,
  members,
  connection,
  copyLabel,
  onCopy,
  onLeave,
  open,
  onClose,
  children
}: {
  code: string;
  members: Member[];
  connection: ConnectionState;
  copyLabel: string;
  /** Copia o convite; rejeite com uma mensagem de erro legível se falhar. */
  onCopy: () => Promise<void>;
  onLeave: () => void;
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
}): JSX.Element {
  const [copyState, setCopyState] = useState<{ ok: boolean; text: string }>();
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    window.clearTimeout(timer.current);
    try {
      await onCopy();
      setCopyState({ ok: true, text: 'Copiado' });
      timer.current = window.setTimeout(() => setCopyState(undefined), 2200);
    } catch (reason) {
      setCopyState({ ok: false, text: reason instanceof Error ? reason.message : 'Não foi possível copiar.' });
    }
  }

  const sharing = members.filter((member) => member.sharing);
  const watching = members.filter((member) => !member.sharing);
  const status = describeConnection(connection);

  return (
    <aside className={`side ${open ? 'is-open' : ''}`} aria-label="Sala e participantes">
      <div className="side-head">
        <div className="side-head-row">
          <span className="side-caption">Código da sala</span>
          <button type="button" className="icon-btn side-close" onClick={onClose} aria-label="Fechar painel da sala">
            <CloseIcon size={18} />
          </button>
        </div>
        <RoomCode code={code} />
        <button type="button" className="btn btn-block" onClick={() => void copy()}>
          {copyState?.ok ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
          {copyState?.ok ? 'Copiado' : copyLabel}
        </button>
        <p className={`side-note ${copyState && !copyState.ok ? 'is-error' : ''}`} aria-live="polite">
          {copyState && !copyState.ok ? copyState.text : ''}
        </p>
      </div>

      <div className="side-list">
        <h2 className="side-group">Transmitindo <span>{sharing.length}</span></h2>
        {sharing.length > 0 ? (
          <ul>{sharing.map((member) => <MemberRow key={member.identity} member={member} />)}</ul>
        ) : (
          <p className="side-empty">Ninguém está transmitindo.</p>
        )}
        <h2 className="side-group">Na sala <span>{watching.length}</span></h2>
        <ul>{watching.map((member) => <MemberRow key={member.identity} member={member} />)}</ul>
        {children}
      </div>

      <div className="side-foot">
        <div className={`conn conn-${status.tone}`} role="status">
          <span className="conn-dot" aria-hidden="true" />
          <span className="conn-text">
            <strong>{status.label}</strong>
            <span>Sala {code}</span>
          </span>
        </div>
        <button type="button" className="btn btn-leave" onClick={onLeave}>
          <LeaveIcon size={18} />
          Sair da sala
        </button>
      </div>
    </aside>
  );
}
