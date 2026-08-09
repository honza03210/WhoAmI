import { useRef, useState } from 'react';
import type { ClientMessage, Member, RoomView, TeamId } from '../../../server/protocol';
import { CUSTOM_PACK_ID, CUSTOM_PACK_MAX, CUSTOM_PACK_MIN, TEAM_IDS, TEAM_NAMES } from '../../../server/protocol';
import type { PackSummary } from '../packs';
import { avatarUrl } from '../avatar';
import type { UploadProgress } from '../customPack';
import { ACCEPTED_TYPES, PackError, checkSelection, uploadCustomPack } from '../customPack';

interface LobbyProps {
  view: RoomView;
  packs: PackSummary[];
  send: (message: ClientMessage) => void;
  session: string;
  instanceId: string;
  onNotice: (message: string) => void;
}

export function Lobby({ view, packs, send, session, instanceId, onNotice }: LobbyProps) {
  const spectators = view.members.filter((member) => member.team === null);
  const canStart = view.startBlockers.length === 0;

  return (
    <>
      <section>
        <h2>Teams</h2>
        <div className="teams">
          {TEAM_IDS.map((team) => (
            <TeamPanel key={team} team={team} view={view} send={send} />
          ))}
        </div>
      </section>

      {spectators.length > 0 && (
        <section>
          <h2>Watching ({spectators.length})</h2>
          <ul className="people">
            {spectators.map((member) => (
              <li key={member.userId}>
                <PersonRow member={member} view={view} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Photo pack</h2>
        {view.you.isHost ? (
          <PackPicker
            view={view}
            packs={packs}
            send={send}
            session={session}
            instanceId={instanceId}
            onNotice={onNotice}
          />
        ) : (
          <p className="muted">
            {view.packId
              ? `${packLabel(view, packs)} — chosen by the host`
              : 'The host is choosing…'}
          </p>
        )}
      </section>

      <section className="start-row">
        {view.you.team !== null && (
          <button
            type="button"
            className={readyMember(view)?.ready ? 'button is-secondary' : 'button'}
            onClick={() => send({ type: 'setReady', ready: !readyMember(view)?.ready })}
          >
            {readyMember(view)?.ready ? "I'm not ready" : "I'm ready"}
          </button>
        )}

        {view.you.isHost && (
          <button type="button" className="button is-primary" disabled={!canStart} onClick={() => send({ type: 'startGame' })}>
            Start game
          </button>
        )}

        {view.startBlockers.length > 0 && (
          <ul className="blockers">
            {view.startBlockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function readyMember(view: RoomView): Member | undefined {
  return view.members.find((member) => member.userId === view.you.userId);
}

function packLabel(view: RoomView, packs: PackSummary[]): string {
  if (view.packId === CUSTOM_PACK_ID) return view.customPack?.name ?? 'Your photos';
  return packs.find((pack) => pack.id === view.packId)?.name ?? view.packId ?? '';
}

/**
 * The host's choice of board: any pack that shipped with the app, or photos off their own device.
 *
 * Uploading is the only thing in the lobby that can take real time, so it gets a progress line
 * and blocks the rest of the picker while it runs — a half-uploaded board is not a board.
 */
function PackPicker({
  view,
  packs,
  send,
  session,
  instanceId,
  onNotice,
}: {
  view: RoomView;
  packs: PackSummary[];
  send: LobbyProps['send'];
  session: string;
  instanceId: string;
  onNotice: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const busy = progress !== null;

  async function onPicked(files: File[]): Promise<void> {
    const problem = checkSelection(files);
    if (problem) {
      onNotice(problem);
      return;
    }

    setProgress({ done: 0, total: files.length, label: 'Reading photos…' });
    try {
      // The room publishes the board itself on commit, so there is no selectPack to follow up
      // with — the next state frame already has it in play.
      await uploadCustomPack(files, session, instanceId, setProgress);
    } catch (error) {
      onNotice(error instanceof PackError ? error.message : `Upload failed: ${String(error)}`);
    } finally {
      setProgress(null);
    }
  }

  return (
    <>
      <nav className="pack-switcher">
        {packs.map((pack) => (
          <button
            type="button"
            key={pack.id}
            className={pack.id === view.packId ? 'chip is-active' : 'chip'}
            disabled={busy}
            onClick={() => send({ type: 'selectPack', packId: pack.id })}
          >
            {pack.name} · {pack.tileCount}
          </button>
        ))}

        {view.customPack && (
          <button
            type="button"
            className={view.packId === CUSTOM_PACK_ID ? 'chip is-active' : 'chip'}
            disabled={busy}
            onClick={() => send({ type: 'selectPack', packId: CUSTOM_PACK_ID })}
          >
            {view.customPack.name} · {view.customPack.characters.length}
          </button>
        )}

        <button type="button" className="chip is-upload" disabled={busy} onClick={() => input.current?.click()}>
          {view.customPack ? 'Replace photos…' : 'Custom photos…'}
        </button>

        <input
          ref={input}
          type="file"
          accept={ACCEPTED_TYPES}
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            // Reset first, so picking the same folder twice in a row still fires a change.
            event.target.value = '';
            void onPicked(files);
          }}
        />
      </nav>

      {busy ? (
        <p className="upload-progress">
          <progress value={progress.done} max={progress.total} />
          <span className="muted">
            {progress.label} ({progress.done}/{progress.total})
          </span>
        </p>
      ) : (
        <p className="muted pack-hint">
          {CUSTOM_PACK_MIN}–{CUSTOM_PACK_MAX} photos, resized in your browser. They live in this room only
          and go when it is cleaned up. Filenames become the names on the board.
        </p>
      )}
    </>
  );
}

function TeamPanel({ team, view, send }: { team: TeamId; view: RoomView; send: LobbyProps['send'] }) {
  const members = view.members.filter((member) => member.team === team);
  const leaderId = view.leaders[team];
  const youAreHere = view.you.team === team;
  const leaderVacant = leaderId === null;

  return (
    <div className={`team team-${team}`}>
      <header className="team-header">
        <h3>{TEAM_NAMES[team]}</h3>
        {!youAreHere && (
          <button type="button" className="chip" onClick={() => send({ type: 'setTeam', team })}>
            Join
          </button>
        )}
        {youAreHere && (
          <button type="button" className="link-button" onClick={() => send({ type: 'setTeam', team: null })}>
            Leave
          </button>
        )}
      </header>

      {members.length === 0 ? (
        <p className="muted empty-team">Nobody yet</p>
      ) : (
        <ul className="people">
          {members.map((member) => (
            <li key={member.userId}>
              <PersonRow member={member} view={view} />
              {/* Only the current leader or the host can hand the role over. */}
              {member.userId !== leaderId && member.connected && (view.you.isHost || leaderId === view.you.userId) && (
                <button
                  type="button"
                  className="link-button hand-over"
                  onClick={() => send({ type: 'assignLeader', userId: member.userId })}
                >
                  Make leader
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {youAreHere && leaderVacant && (
        <button type="button" className="chip" onClick={() => send({ type: 'claimLeader' })}>
          Lead this team
        </button>
      )}
    </div>
  );
}

function PersonRow({ member, view }: { member: Member; view: RoomView }) {
  const isLeader = member.team !== null && view.leaders[member.team] === member.userId;
  return (
    <div className={member.connected ? 'person' : 'person is-away'}>
      <img src={avatarUrl(member.userId, member.avatar)} alt="" width={28} height={28} />
      <span className="person-name">{member.name}</span>
      {member.userId === view.hostId && <span className="tag">host</span>}
      {/* The leader is the only one who will see this team's secret, so the role is made obvious. */}
      {isLeader && <span className="tag is-leader">leader</span>}
      {member.team !== null && member.ready && <span className="tick" aria-label="ready">✓</span>}
      {!member.connected && <span className="tag">away</span>}
    </div>
  );
}
