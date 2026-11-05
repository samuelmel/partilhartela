import { useEffect, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { DisconnectReason, RoomEvent } from 'livekit-client';
import { leaveFullscreen } from '../../../shared/ui/useFullscreen';
import { Home } from './Home';
import { RoomScreen } from './RoomScreen';
import type { Session } from './session';
import '../../../shared/ui/base.css';
import '../../../shared/ui/room.css';
import './styles.css';

function lostConnectionMessage(reason: DisconnectReason | undefined, code: string): string {
  switch (reason) {
    case DisconnectReason.ROOM_DELETED:
      return `A sala ${code} foi encerrada.`;
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'Você entrou nesta sala em outra janela, então esta foi desconectada.';
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'Você foi removido da sala.';
    default:
      return `A conexão com a sala caiu. Entre de novo com o código ${code}.`;
  }
}

function App(): JSX.Element {
  const [session, setSession] = useState<Session>();
  const [homeCode, setHomeCode] = useState(() => new URLSearchParams(window.location.search).get('room')?.toUpperCase() ?? '');
  const [homeError, setHomeError] = useState('');

  useEffect(() => {
    if (!session) return;
    const { room, code } = session;
    const onDisconnected = (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.CLIENT_INITIATED) return;
      void leaveFullscreen();
      setHomeCode(code);
      setHomeError(lostConnectionMessage(reason, code));
      setSession(undefined);
    };
    // Fechar a janela sai da sala na hora, sem deixar participante fantasma até o timeout.
    const onPageHide = () => void room.disconnect();
    room.on(RoomEvent.Disconnected, onDisconnected);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [session]);

  async function leave(): Promise<void> {
    if (!session) return;
    await leaveFullscreen();
    await session.room.disconnect();
    setHomeCode('');
    setHomeError('');
    setSession(undefined);
  }

  if (!session) {
    return (
      <Home
        key={`${homeCode}-${homeError}`}
        initialCode={homeCode}
        initialError={homeError}
        onEnter={(next) => setSession(next)}
      />
    );
  }

  return <RoomScreen session={session} onLeave={() => leave()} />;
}

createRoot(document.getElementById('root')!).render(<App />);
