import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientMessage, RoomView } from '../../server/protocol';
import { CUSTOM_PACK_ID } from '../../server/protocol';
import type { Connection } from './discord';
import { connect, isEmbedded } from './discord';
import type { PackManifest, PackSummary } from './packs';
import { loadPack, loadPackIndex, manifestFromCustomPack } from './packs';
import type { ConnectionStatus, RoomClient } from './net';
import { connectRoom } from './net';
import { Game } from './screens/Game';
import { Lobby } from './screens/Lobby';

type Status =
  | { phase: 'connecting' }
  | { phase: 'ready'; connection: Connection }
  | { phase: 'error'; message: string };

export function App() {
  const [status, setStatus] = useState<Status>({ phase: 'connecting' });
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [pack, setPack] = useState<PackManifest | null>(null);
  const [view, setView] = useState<RoomView | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [notice, setNotice] = useState<string | null>(null);

  const room = useRef<RoomClient | null>(null);

  useEffect(() => {
    let cancelled = false;

    connect()
      .then((established) => {
        if (cancelled) return;
        setStatus({ phase: 'ready', connection: established });

        if (!established.session) {
          setConnection('closed');
          return;
        }
        room.current = connectRoom(established.session, established.instanceId, {
          onState: setView,
          onStatus: setConnection,
          onError: (error) => setNotice(error.message),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
      room.current?.close();
      room.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadPackIndex().then(
      (index) => !cancelled && setPacks(index),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // The room decides which pack is in play; the client just loads whatever it names.
  useEffect(() => {
    const packId = view?.packId;
    // An uploaded board needs no fetch: its character list arrives with the room state.
    if (!packId || packId === CUSTOM_PACK_ID || packId === pack?.id) return;

    let cancelled = false;
    loadPack(packId).then(
      (manifest) => !cancelled && setPack(manifest),
      (error: unknown) => !cancelled && setNotice(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [view?.packId, pack?.id]);

  const customPack = view?.packId === CUSTOM_PACK_ID ? (view.customPack ?? null) : null;
  const instanceId = status.phase === 'ready' ? status.connection.instanceId : null;
  const customManifest = useMemo(
    () => (customPack && instanceId ? manifestFromCustomPack(customPack, instanceId) : null),
    // Keyed on the token rather than the object: room state is re-parsed every frame, so the
    // pack is a new object each time, but its token changes only when the photos do.
    [customPack?.token, instanceId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Errors are transient: a rejected click shouldn't leave a banner up forever.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const send = useCallback((message: ClientMessage) => room.current?.send(message), []);

  if (status.phase === 'connecting') {
    return <main className="centered">Connecting to Discord…</main>;
  }
  if (status.phase === 'error') {
    return (
      <main className="centered">
        <h1>Couldn&apos;t start</h1>
        <p className="error">{status.message}</p>
      </main>
    );
  }

  const { user, session } = status.connection;

  return (
    <main>
      <header>
        <h1>guessFi</h1>
        {!isEmbedded && <span className="badge">standalone</span>}
        <ConnectionPill status={connection} hasSession={session !== null} />
        <span className="spacer" />
        <span className="who">
          <img src={user.avatarUrl} alt="" width={24} height={24} />
          {user.displayName}
        </span>
      </header>

      {notice && <p className="error notice">{notice}</p>}

      {!session ? (
        <section className="empty">
          <h2>No game session</h2>
          <p>
            Running outside Discord without dev sessions enabled. Set{' '}
            <code>ALLOW_DEV_SESSIONS=true</code> in <code>.dev.vars</code> and restart the Worker, or
            open the activity inside Discord.
          </p>
        </section>
      ) : !view ? (
        <p className="muted">Joining the room…</p>
      ) : view.phase === 'lobby' ? (
        <Lobby
          view={view}
          packs={packs}
          send={send}
          session={session}
          instanceId={status.connection.instanceId}
          onNotice={setNotice}
        />
      ) : (
        <Game view={view} pack={customManifest ?? pack} send={send} />
      )}
    </main>
  );
}

function ConnectionPill({ status, hasSession }: { status: ConnectionStatus; hasSession: boolean }) {
  if (!hasSession) return null;
  if (status === 'open') return null;
  const label =
    status === 'connecting' ? 'connecting…' : status === 'reconnecting' ? 'reconnecting…' : 'disconnected';
  return <span className={status === 'closed' ? 'badge is-bad' : 'badge'}>{label}</span>;
}
