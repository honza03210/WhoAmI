import { useEffect, useState } from 'react';
import type { AppUser, Connection } from './discord';
import { connect, getParticipants, isEmbedded, onParticipantsChange } from './discord';
import type { PackManifest, PackSummary } from './packs';
import { loadPack, loadPackIndex } from './packs';
import { Board } from './screens/Board';

type Status =
  | { phase: 'connecting' }
  | { phase: 'ready'; connection: Connection }
  | { phase: 'error'; message: string };

export function App() {
  const [status, setStatus] = useState<Status>({ phase: 'connecting' });
  const [participants, setParticipants] = useState<AppUser[]>([]);
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [pack, setPack] = useState<PackManifest | null>(null);
  const [packError, setPackError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    connect()
      .then(async (connection) => {
        if (cancelled) return;
        setStatus({ phase: 'ready', connection });
        setParticipants(await getParticipants(connection.sdk));
        unsubscribe = onParticipantsChange(connection.sdk, setParticipants);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // Packs are static assets, so they load independently of the Discord handshake.
  useEffect(() => {
    let cancelled = false;
    loadPackIndex()
      .then((index) => {
        if (cancelled) return;
        setPacks(index);
        return index[0] ? selectPack(index[0].id) : undefined;
      })
      .catch((error: unknown) => {
        if (!cancelled) setPackError(error instanceof Error ? error.message : String(error));
      });

    async function selectPack(packId: string) {
      const manifest = await loadPack(packId);
      if (!cancelled) setPack(manifest);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  async function choosePack(packId: string) {
    setPackError(null);
    try {
      setPack(await loadPack(packId));
    } catch (error: unknown) {
      setPackError(error instanceof Error ? error.message : String(error));
    }
  }

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

  const { user } = status.connection;

  return (
    <main>
      <header>
        <h1>guessFi</h1>
        {!isEmbedded && <span className="badge">standalone dev — not running inside Discord</span>}
        <span className="spacer" />
        <span className="who">
          <img src={user.avatarUrl} alt="" width={24} height={24} />
          {user.displayName}
        </span>
      </header>

      {packs !== null && packs.length > 1 && (
        <nav className="pack-switcher">
          {packs.map((summary) => (
            <button
              type="button"
              key={summary.id}
              className={summary.id === pack?.id ? 'chip is-active' : 'chip'}
              onClick={() => void choosePack(summary.id)}
            >
              {summary.name}
            </button>
          ))}
        </nav>
      )}

      {packError && <p className="error">{packError}</p>}

      {pack ? (
        <Board pack={pack} />
      ) : packs !== null && packs.length === 0 ? (
        <section className="empty">
          <h2>No photo packs yet</h2>
          <p>
            Drop photos into <code>packs/&lt;pack-name&gt;/</code> and run <code>npm run packs</code>.
            To try it with placeholders first, run <code>npm run demo-pack</code>.
          </p>
        </section>
      ) : (
        !packError && <p className="muted">Loading pack…</p>
      )}

      <section>
        <h2>In this activity ({participants.length})</h2>
        <ul className="people">
          {participants.map((person) => (
            <li key={person.id}>
              <div className="person">
                <img src={person.avatarUrl} alt="" width={32} height={32} />
                <span>{person.displayName}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
