import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientMessage, RoomView } from '../../server/protocol';
import { CUSTOM_PACK_ID } from '../../server/protocol';
import type { Connection } from './discord';
import { connectDiscord, isEmbedded, leaveActivity } from './discord';
import { describeError } from './errors';
import type { StoredSession } from './join';
import { createRoom, rememberedName, roomCodeFromUrl, roomKeyForCode, roomUrlFor, sessionForRoom } from './join';
import { generatedAvatar } from './avatar';
import { Landing } from './screens/Landing';
import type { PackManifest, PackSummary } from './packs';
import { loadPack, loadPackIndex, manifestFromCustomPack } from './packs';
import type { ConnectionStatus, RoomClient } from './net';
import { connectRoom } from './net';
import { Game } from './screens/Game';
import { Lobby } from './screens/Lobby';

type Status =
  /** In a browser with no room in the URL: the landing screen decides what happens next. */
  | { phase: 'landing' }
  | { phase: 'connecting' }
  | { phase: 'ready'; connection: Connection }
  | { phase: 'error'; message: string };

/** A name in the URL skips the landing form — how a shared link and the e2e suite both arrive. */
const nameFromUrl = new URLSearchParams(window.location.search).get('name') ?? '';

export function App() {
  const [status, setStatus] = useState<Status>(() =>
    isEmbedded || roomCodeFromUrl() ? { phase: 'connecting' } : { phase: 'landing' },
  );
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [pack, setPack] = useState<PackManifest | null>(null);
  const [view, setView] = useState<RoomView | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  const room = useRef<RoomClient | null>(null);

  /** Opens the socket for an established identity. Shared by both doors. */
  const enterRoom = useCallback((established: Connection) => {
    setStatus({ phase: 'ready', connection: established });
    room.current?.close();
    room.current = connectRoom(established.session, established.roomKey, {
      onState: setView,
      onStatus: setConnection,
      onError: (error) => setNotice(error.message),
    });
  }, []);

  // The Discord door, and the "someone sent me a link" door. The third case — a bare visit — is
  // the landing screen, which does nothing until a name is typed.
  useEffect(() => {
    let cancelled = false;
    const code = roomCodeFromUrl();

    const arrive = async (): Promise<void> => {
      if (isEmbedded) return enterRoom(await connectDiscord());
      if (!code) return;

      const name = nameFromUrl.trim() || rememberedName();
      // No name yet: fall back to the landing form rather than inventing one for them.
      if (!name) {
        setStatus({ phase: 'landing' });
        return;
      }
      const roomKey = roomKeyForCode(code);
      const stored = await sessionForRoom(roomKey, name);
      enterRoom(guestConnection(stored, roomKey, code));
    };

    arrive().catch((error: unknown) => {
      if (cancelled) return;
      setStatus({ phase: 'error', message: describeError(error) });
    });

    return () => {
      cancelled = true;
      room.current?.close();
      room.current = null;
    };
  }, [enterRoom]);

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
  const roomKey = status.phase === 'ready' ? status.connection.roomKey : null;
  const customManifest = useMemo(
    () => (customPack && roomKey ? manifestFromCustomPack(customPack, roomKey) : null),
    // Keyed on the token rather than the object: room state is re-parsed every frame, so the
    // pack is a new object each time, but its token changes only when the photos do.
    [customPack?.token, roomKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Errors are transient: a rejected click shouldn't leave a banner up forever.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const send = useCallback((message: ClientMessage) => room.current?.send(message), []);

  /**
   * Leaves the room first, then asks Discord to close the activity. Closing the socket is what
   * actually takes the player out of the game, and it must not depend on Discord obliging.
   */
  /**
   * Joining puts the code in the URL before connecting, so the address bar is always shareable
   * and a refresh lands in the same room rather than back on the front door.
   */
  const joinRoom = useCallback(
    (name: string, code: string) => {
      setJoinError(null);
      setBusy('Joining…');
      const key = roomKeyForCode(code);

      sessionForRoom(key, name)
        .then((stored) => {
          window.history.replaceState(null, '', `/r/${code}`);
          enterRoom(guestConnection(stored, key, code));
        })
        .catch((error: unknown) => {
          setBusy(null);
          setJoinError(describeError(error));
        });
    },
    [enterRoom],
  );

  const openRoom = useCallback(
    (name: string) => {
      setJoinError(null);
      setBusy('Opening…');

      // A session is needed to create a room, and the room key is not known until it exists —
      // so the first session is minted against a placeholder and the real one follows the code.
      sessionForRoom('new', name)
        .then((stored) => createRoom(stored.token))
        .then((code) => joinRoom(name, code))
        .catch((error: unknown) => {
          setBusy(null);
          setJoinError(describeError(error));
        });
    },
    [joinRoom],
  );

  const leave = useCallback(() => {
    room.current?.close();
    room.current = null;
    setLeft(true);
    if (status.phase === 'ready') leaveActivity(status.connection.sdk);
  }, [status]);

  if (status.phase === 'landing') {
    return (
      <Landing
        initialName={nameFromUrl.trim() || rememberedName()}
        joiningCode={roomCodeFromUrl()}
        busy={busy}
        error={joinError}
        onCreate={openRoom}
        onJoin={joinRoom}
      />
    );
  }
  if (status.phase === 'connecting') {
    return <main className="centered">{isEmbedded ? 'Connecting to Discord…' : 'Joining the room…'}</main>;
  }
  if (status.phase === 'error') {
    return (
      <main className="centered">
        <h1>Couldn&apos;t start</h1>
        <p className="error">{status.message}</p>
        {/* Three per-application settings that do not carry over when you switch Discord apps,
            and cannot be checked from here — the portal exposes no API for any of them. */}
        <details className="setup-hint">
          <summary>Check the Discord application settings</summary>
          <ul>
            <li>
              <strong>Activities → URL Mappings</strong>: root <code>/</code> mapped to the host serving this
              app
            </li>
            <li>
              <strong>Activities → Settings</strong>: activities enabled
            </li>
            <li>
              <strong>OAuth2 → Redirects</strong>: at least one entry, e.g. <code>https://127.0.0.1</code>
            </li>
          </ul>
        </details>
      </main>
    );
  }

  const { user, session, code } = status.connection;

  if (left) {
    return (
      <main className="centered">
        <h1>You left the game</h1>
        <p className="muted">Close this window, or rejoin to pick up where the room is now.</p>
        <button type="button" className="button is-primary" onClick={() => window.location.reload()}>
          Rejoin
        </button>
      </main>
    );
  }

  return (
    <main>
      <header>
        <h1>guessFi</h1>
        {code && <RoomCode code={code} />}
        <ConnectionPill status={connection} hasSession={session !== null} />
        <span className="spacer" />
        <span className="who">
          <img src={user.avatarUrl} alt="" width={24} height={24} />
          {/* Dropped on narrow screens so Leave stays on the same line as everything else. */}
          <span className="who-name">{user.displayName}</span>
        </span>
        <button type="button" className="chip is-leave" onClick={leave}>
          Leave
        </button>
      </header>

      {notice && <p className="error notice">{notice}</p>}

      {!view ? (
        <p className="muted">Joining the room…</p>
      ) : view.phase === 'lobby' ? (
        <Lobby
          view={view}
          packs={packs}
          send={send}
          session={session}
          roomKey={status.connection.roomKey}
          onNotice={setNotice}
        />
      ) : (
        <Game view={view} pack={customManifest ?? pack} send={send} />
      )}
    </main>
  );
}

/**
 * The room's code, and the link that carries it.
 *
 * People join by being sent a URL far more often than by typing six characters, so copying the
 * link is the primary action and the code is what you read out when that fails.
 */
function RoomCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={copied ? 'chip is-code is-active' : 'chip is-code'}
      title="Copy the link to this room"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(roomUrlFor(code))
          .then(() => setCopied(true))
          // Clipboard access can be denied; the code is still on screen to read out.
          .catch(() => undefined);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <span className="room-code">{code}</span>
      <span className="code-action">{copied ? 'copied' : 'copy link'}</span>
    </button>
  );
}

/** A guest has no Discord profile, so their identity is entirely what the Worker issued them. */
function guestConnection(stored: StoredSession, roomKey: string, code: string): Connection {
  return {
    sdk: null,
    session: stored.token,
    roomKey,
    code,
    user: {
      id: stored.user.id,
      username: stored.user.displayName,
      displayName: stored.user.displayName,
      avatarUrl: generatedAvatar(stored.user.id, stored.user.displayName),
    },
  };
}

function ConnectionPill({ status, hasSession }: { status: ConnectionStatus; hasSession: boolean }) {
  if (!hasSession) return null;
  if (status === 'open') return null;
  const label =
    status === 'connecting' ? 'connecting…' : status === 'reconnecting' ? 'reconnecting…' : 'disconnected';
  return <span className={status === 'closed' ? 'badge is-bad' : 'badge'}>{label}</span>;
}
