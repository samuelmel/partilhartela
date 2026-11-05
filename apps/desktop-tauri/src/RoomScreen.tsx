import { useState, type JSX } from 'react';
import { ConnectionState } from 'livekit-client';
import { AlertIcon, BrandMark, LeaveIcon, ScreenIcon, UsersIcon } from '../../../shared/ui/icons';
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog';
import { RoomSidebar } from '../../../shared/ui/RoomSidebar';
import { useRpgMode } from '../../../shared/ui/rpgMode';
import { Stage } from '../../../shared/ui/Stage';
import { useAudioPlayback, useConnectionState, useRoomSnapshot } from '../../../shared/ui/roomState';
import { copyText } from './clipboard';
import { inviteText, tokenServer, type Session } from './session';

export function RoomScreen({
  session,
  onLeave
}: {
  session: Session;
  onLeave: () => void | Promise<void>;
}): JSX.Element {
  const { room, code } = session;
  const snapshot = useRoomSnapshot(room);
  const rpg = useRpgMode(room, tokenServer, code);
  const names = Object.fromEntries(snapshot.members.map((member) => [member.identity, member.name]));
  const connection = useConnectionState(room);
  const playback = useAudioPlayback(room);
  const [panelOpen, setPanelOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const reconnecting = connection === ConnectionState.Reconnecting || connection === ConnectionState.SignalReconnecting;

  async function enableSound(): Promise<void> {
    try {
      await playback.start();
      setPlaybackError('');
    } catch {
      setPlaybackError('A webview ainda bloqueou o som. Clique em "Ativar som" mais uma vez.');
    }
  }

  async function confirmLeave(): Promise<void> {
    setLeaving(true);
    try {
      await onLeave();
    } finally {
      setLeaving(false);
      setLeaveConfirmOpen(false);
    }
  }

  return (
    <div className="room-shell">
      <RoomSidebar
        code={code}
        members={snapshot.members}
        connection={connection}
        copyLabel="Copiar convite"
        onCopy={() => copyText(inviteText(code))}
        onLeave={() => setLeaveConfirmOpen(true)}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
      />

      {panelOpen && <button type="button" className="side-backdrop" aria-label="Fechar painel da sala" onClick={() => setPanelOpen(false)} />}

      <main className="room-main">
        <header className="room-head">
          <button
            type="button"
            className="room-brand"
            onClick={() => setLeaveConfirmOpen(true)}
            aria-label="Voltar ao início (sair da sala)"
            title="Voltar ao início"
          >
            <BrandMark size={24} />
          </button>
          <button type="button" className="icon-btn only-narrow" onClick={() => setPanelOpen(true)} aria-label="Código da sala e participantes">
            <UsersIcon />
          </button>
          <h1>
            Sala {code}
            <span> {snapshot.members.length} {snapshot.members.length === 1 ? 'pessoa' : 'pessoas'}</span>
          </h1>
          <span className="room-mode">Só visualização</span>
          <button type="button" className="btn btn-quiet only-wide" onClick={() => setLeaveConfirmOpen(true)}>
            <LeaveIcon size={16} />Sair da sala
          </button>
          <button type="button" className="icon-btn only-narrow" onClick={() => setLeaveConfirmOpen(true)} aria-label="Sair da sala">
            <LeaveIcon />
          </button>
        </header>

        <div className="banners">
          {reconnecting && (
            <p className="notice notice-warn" role="status"><span className="spinner" aria-hidden="true" />Conexão instável. Reconectando à sala…</p>
          )}
          {playback.blocked && Object.keys(snapshot.audio).length > 0 && (
            <p className="notice" role="status">
              <AlertIcon size={18} />
              <span>{playbackError || 'A webview pausou o som da transmissão até você permitir.'}</span>
              <button type="button" className="btn btn-primary" onClick={() => void enableSound()}>Ativar som</button>
            </p>
          )}
        </div>

        <Stage
          streams={snapshot.streams}
          audio={snapshot.audio}
          local={snapshot.local.video ? { track: snapshot.local.video, name: 'Sua tela' } : undefined}
          rpg={rpg}
          names={names}
          empty={
            <div className="stage-empty">
              <ScreenIcon size={36} />
              <h2>Ninguém está transmitindo</h2>
              <p>Quando alguém começar a transmitir na sala <strong>{code}</strong>, a tela aparece aqui.</p>
            </div>
          }
        />
      </main>

      <ConfirmDialog
        open={leaveConfirmOpen}
        title="Sair da sala?"
        description={`Você vai sair da sala ${code}.`}
        confirmLabel="Sair da sala"
        busy={leaving}
        onConfirm={() => void confirmLeave()}
        onCancel={() => setLeaveConfirmOpen(false)}
      />
    </div>
  );
}
