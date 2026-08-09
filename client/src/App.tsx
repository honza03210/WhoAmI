import { useEffect, useState } from 'react';
import type { AppUser, Connection } from './discord';
import { connect, getParticipants, isEmbedded, onParticipantsChange } from './discord';

type Status = { phase: 'connecting' } | { phase: 'ready'; connection: Connection } | { phase: 'error'; message: string };

export function App() {
  const [status, setStatus] = useState<Status>({ phase: 'connecting' });
  const [participants, setParticipants] = useState<AppUser[]>([]);

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
      </header>

      <section>
        <h2>You</h2>
        <Person user={user} />
      </section>

      <section>
        <h2>In this activity ({participants.length})</h2>
        <ul className="people">
          {participants.map((person) => (
            <li key={person.id}>
              <Person user={person} />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Person({ user }: { user: AppUser }) {
  return (
    <div className="person">
      <img src={user.avatarUrl} alt="" width={40} height={40} />
      <span>{user.displayName}</span>
    </div>
  );
}
