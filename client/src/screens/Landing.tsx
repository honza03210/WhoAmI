import { useState } from 'react';

interface LandingProps {
  /** Prefilled when the visitor has played before, or when a link carried a name. */
  initialName: string;
  /** Set when the URL already names a room, so the copy is "join" rather than "create". */
  joiningCode: string | null;
  busy: string | null;
  error: string | null;
  onCreate: (name: string) => void;
  onJoin: (name: string, code: string) => void;
}

/**
 * The front door for anyone who did not arrive through Discord.
 *
 * Two jobs: get a display name, and get a room. A link with a code in it collapses that to one
 * question, which is the case that matters — most people arrive by having a link sent to them.
 */
export function Landing({ initialName, joiningCode, busy, error, onCreate, onJoin }: LandingProps) {
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState(joiningCode ?? '');

  const trimmedName = name.trim();
  const trimmedCode = code.trim().toUpperCase();
  const ready = trimmedName.length > 0 && !busy;

  return (
    <main className="centered landing">
      <h1>guessFi</h1>
      <p className="muted landing-blurb">
        Team Guess Who, played with your own photos. Two teams, two leaders, one secret face each.
      </p>

      {error && <p className="error">{error}</p>}

      <form
        className="landing-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          if (joiningCode) onJoin(trimmedName, joiningCode);
          else if (trimmedCode) onJoin(trimmedName, trimmedCode);
          else onCreate(trimmedName);
        }}
      >
        <label className="field">
          <span>Your name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ada"
            maxLength={24}
            autoComplete="nickname"
            autoFocus
          />
        </label>

        {joiningCode ? (
          <>
            <p className="muted">
              Joining room <strong className="room-code">{joiningCode}</strong>
            </p>
            <button type="submit" className="button is-primary" disabled={!ready}>
              {busy ?? 'Join the room'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="button is-primary"
              disabled={!ready}
              onClick={() => onCreate(trimmedName)}
            >
              {busy ?? 'Start a new room'}
            </button>

            <div className="landing-or">
              <span>or join one</span>
            </div>

            <div className="join-row">
              <input
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="Room code"
                maxLength={6}
                autoComplete="off"
                spellCheck={false}
                aria-label="Room code"
                className="code-input"
              />
              <button
                type="button"
                className="button"
                disabled={!ready || trimmedCode.length !== 6}
                onClick={() => onJoin(trimmedName, trimmedCode)}
              >
                Join
              </button>
            </div>
          </>
        )}
      </form>
    </main>
  );
}
