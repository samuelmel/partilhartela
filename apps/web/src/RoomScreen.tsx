import { useState, type JSX } from 'react';
import { ConnectionState } from 'livekit-client';
import { AlertIcon, DownloadIcon, LeaveIcon, ScreenIcon, UsersIcon } from '../../../shared/ui/icons';
import { RoomSidebar } from '../../../shared/ui/RoomSidebar';
import { RpgControl } from '../../../shared/ui/RpgControl';
import { useRpgMode } from '../../../shared/ui/rpgMode';
import { Stage } from '../../../shared/ui/Stage';
import { useAudioPlayback, useConnectionState, useRoomSnapshot } from '../../../shared/ui/roomState';
import type { CaptureSupport } from './capture';
import { downloadUrl, inviteLink, tokenServer, type Session } from './session';
import { ShareDock } from './ShareDock';

async function copyInvite(code: string): Promise<void> {
  const link = inviteLink(code);
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    throw new Error(`Copie manualmente: ${link}`);
  }
}

export function RoomScreen({
  session,
  support,
  onLeave
}: {
  session: Session;
  support: CaptureSupport;
  onLeave: () => void;
}): JSX.Element {
  const { room, code, hostKey } = session;
  const snapshot = useRoomSnapshot(room);
  const rpg = useRpgMode(room, tokenServer, code);
  const names = Object.fromEntries(snapshot.members.map((member) => [member.identity, member.name]));
  const connection = useConnectionState(room);
  const playback = useAudioPlayback(room);
  const [panelOpen, setPanelOpen] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const reconnecting = connection === ConnectionState.Reconnecting || connection === ConnectionState.SignalReconnecting;
  const me = snapshot.members.find((member) => member.isLocal)?.name ?? 'Você';

  async function enableSound(): Promise<void> {
    try {
      await playback.start();
      setPlaybackError('');
    } catch {
      setPlaybackError('O navegador ainda bloqueou o som. Clique em "Ativar som" mais uma vez.');
    }
  }

  return (
    <div className="room-shell">
      <RoomSidebar
        code={code}
        members={snapshot.members}
        connection={connection}
        copyLabel="Copiar link de convite"
        onCopy={() => copyInvite(code)}
        onLeave={onLeave}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
      >
        {hostKey && <RpgControl tokenServer={tokenServer} code={code} hostKey={hostKey} rpg={rpg} />}
      </RoomSidebar>
      {panelOpen && <button type="button" className="side-backdrop" aria-label="Fechar painel da sala" onClick={() => setPanelOpen(false)} />}

      <main className="room-main">
        <header className="room-head">
          <button type="button" className="icon-btn only-narrow" onClick={() => setPanelOpen(true)} aria-label="Código da sala e participantes">
            <UsersIcon />
          </button>
          <h1>
            Sala {code}
            <span> {snapshot.members.length} {snapshot.members.length === 1 ? 'pessoa' : 'pessoas'}</span>
          </h1>
          <a className="btn btn-quiet only-wide" href={downloadUrl} target="_blank" rel="noreferrer">
            <DownloadIcon size={16} />App para Windows
          </a>
          <button type="button" className="icon-btn only-narrow" onClick={onLeave} aria-label="Sair da sala">
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
              <span>{playbackError || 'O navegador pausou o som da transmissão até você permitir.'}</span>
              <button type="button" className="btn btn-primary" onClick={() => void enableSound()}>Ativar som</button>
            </p>
          )}
        </div>

        <Stage
          streams={snapshot.streams}
          audio={snapshot.audio}
          local={snapshot.local.video ? { track: snapshot.local.video, name: me } : undefined}
          rpg={rpg}
          names={names}
          empty={
            <div className="stage-empty">
              <ScreenIcon size={36} />
              <h2>Ninguém está transmitindo</h2>
              <p>
                {support.ok
                  ? <>Comece pelo botão <strong>Compartilhar minha tela</strong> ou mande o código <strong>{code}</strong> para alguém transmitir.</>
                  : <>Quando alguém transmitir na sala <strong>{code}</strong>, a tela aparece aqui.</>}
              </p>
            </div>
          }
        />

        <ShareDock room={room} local={snapshot.local} support={support} />
      </main>
    </div>
  );
}
