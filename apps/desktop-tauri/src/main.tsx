import { useEffect, useRef, useState, type JSX } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createRoot } from 'react-dom/client';
import { DisconnectReason, RoomEvent } from 'livekit-client';
import { leaveFullscreen } from '../../../shared/ui/useFullscreen';
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog';
import { useDiscordSession } from './discordSession';
import { Home } from './Home';
import { UpdateBanner } from './UpdateBanner';
import { RoomScreen } from './RoomScreen';
import { tokenServer, type Session } from './session';
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
  const discord = useDiscordSession(tokenServer);
  const [autoJoin, setAutoJoin] = useState<string>();
  const [switchCode, setSwitchCode] = useState<string>();
  const [switching, setSwitching] = useState(false);
  const sessionRef = useRef<Session>();
  sessionRef.current = session;
  const joinFromLinkRef = useRef<(code: string) => void>(() => undefined);
  joinFromLinkRef.current = (code: string) => {
    const current = sessionRef.current;
    if (current) {
      if (current.code !== code) setSwitchCode(code);
      return;
    }
    setHomeCode(code);
    setHomeError('');
    setAutoJoin(code);
  };

  // Links partilhartela://join/CODIGO (botão do bot no Discord). Espera a sessão carregar para entrar com ela.
  useEffect(() => {
    if (discord.loading) return;
    const check = () => {
      void invoke<string | null>('consume_pending_join').then((code) => {
        if (code) joinFromLinkRef.current(code);
      });
    };
    check();
    const unlisten = listen('deeplink:join', check);
    return () => {
      void unlisten.then((off) => off());
    };
  }, [discord.loading]);

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

  async function confirmSwitch(): Promise<void> {
    const code = switchCode;
    if (!code) return;
    setSwitching(true);
    try {
      await leave();
    } finally {
      setSwitching(false);
      setSwitchCode(undefined);
    }
    setHomeCode(code);
    setAutoJoin(code);
  }

  const screen = !session ? (
    <Home
      key={`${homeCode}-${homeError}`}
      initialCode={homeCode}
      initialError={homeError}
      discord={discord}
      autoJoin={autoJoin}
      onEnter={(next) => {
        setAutoJoin(undefined);
        setSession(next);
      }}
    />
  ) : (
    <RoomScreen session={session} onLeave={() => leave()} />
  );

  return (
    <>
      {screen}
      <UpdateBanner />
      <ConfirmDialog
        open={switchCode !== undefined}
        title="Trocar de sala?"
        description={`Você está numa sala e abriu o convite da sala ${switchCode ?? ''}. Sair da atual e entrar na nova?`}
        confirmLabel="Trocar de sala"
        busy={switching}
        onConfirm={() => void confirmSwitch()}
        onCancel={() => setSwitchCode(undefined)}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
