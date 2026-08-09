import { useState } from 'react';
import type { ClientMessage, GameView, RoomView, TeamId } from '../../../server/protocol';
import { MAX_QUESTION_LENGTH, TEAM_NAMES, otherTeam } from '../../../server/protocol';
import type { PackManifest } from '../packs';
import { packAsset } from '../packs';
import { Board } from './Board';

interface GameProps {
  view: RoomView;
  pack: PackManifest | null;
  send: (message: ClientMessage) => void;
}

export function Game({ view, pack, send }: GameProps) {
  const [pendingGuess, setPendingGuess] = useState<string | null>(null);
  const [guessing, setGuessing] = useState(false);
  // Which team's board is on screen. Only ever a choice for spectators and after the reveal.
  const [viewing, setViewing] = useState<TeamId | null>(null);

  const game = view.game;
  if (!game) return <p className="muted">Waiting for the game…</p>;
  if (!pack) return <p className="muted">Loading the board…</p>;

  const you = view.you;
  const boards = (Object.keys(game.flipped) as TeamId[]).sort();
  const shown = viewing && boards.includes(viewing) ? viewing : (you.team ?? boards[0] ?? 'a');
  const flipped = new Set(game.flipped[shown] ?? []);
  const over = game.outcome !== null;

  const nameOf = (characterId: string): string =>
    pack.characters.find((character) => character.id === characterId)?.name ?? characterId;

  // Only your own board is yours to change, and only while the game is live.
  const canFlip = !over && you.team !== null && shown === you.team;

  function pick(characterId: string): void {
    if (guessing) {
      setPendingGuess(characterId);
      return;
    }
    if (canFlip) send({ type: 'flipTile', characterId, down: !flipped.has(characterId) });
  }

  return (
    <>
      {over && game.outcome ? (
        <Result outcome={game.outcome} reveal={game.reveal} nameOf={nameOf} you={you} />
      ) : (
        <TurnBanner game={game} you={you} />
      )}

      {game.yourSecret && (
        <Secret characterId={game.yourSecret} name={nameOf(game.yourSecret)} pack={pack} team={you.team} />
      )}

      {!over && (
        <Actions
          game={game}
          you={you}
          send={send}
          guessing={guessing}
          onStartGuess={() => setGuessing(true)}
          onCancelGuess={() => {
            setGuessing(false);
            setPendingGuess(null);
          }}
        />
      )}

      {pendingGuess && (
        <section className="confirm">
          <p>
            Say the {TEAM_NAMES[otherTeam(you.team ?? 'a')]} character is <strong>{nameOf(pendingGuess)}</strong>?
            {' '}This ends the game — wrong and the other team wins.
          </p>
          <div className="confirm-actions">
            <button
              type="button"
              className="button is-primary"
              onClick={() => {
                send({ type: 'submitGuess', characterId: pendingGuess });
                setPendingGuess(null);
                setGuessing(false);
              }}
            >
              Yes, that&apos;s them
            </button>
            <button type="button" className="button is-secondary" onClick={() => setPendingGuess(null)}>
              Back
            </button>
          </div>
        </section>
      )}

      <QuestionLog log={game.log} />

      {boards.length > 1 && (
        <nav className="board-switcher">
          <span className="muted">Board:</span>
          {boards.map((team) => (
            <button
              key={team}
              type="button"
              className={team === shown ? 'chip is-active' : 'chip'}
              onClick={() => setViewing(team)}
            >
              {TEAM_NAMES[team]}
            </button>
          ))}
        </nav>
      )}

      <Board
        pack={pack}
        flipped={flipped}
        marks={marksFor(game, you.team)}
        mode={guessing ? 'guess' : canFlip ? 'flip' : 'locked'}
        onPick={pick}
        {...(canFlip ? { onReset: () => send({ type: 'resetFlips' }) } : {})}
      />

      {over && view.you.isHost && (
        <section className="start-row">
          <button type="button" className="button is-primary" onClick={() => send({ type: 'rematch' })}>
            Back to the lobby
          </button>
        </section>
      )}
    </>
  );
}

/** Badges drawn on tiles: your own character while playing, both once it's over. */
function marksFor(game: GameView, team: TeamId | null): Record<string, string> {
  if (game.reveal) {
    const marks: Record<string, string> = {};
    for (const [side, characterId] of Object.entries(game.reveal) as [TeamId, string][]) {
      // Both teams can be dealt the same character; say so rather than letting one label win.
      marks[characterId] = marks[characterId] ? `${marks[characterId]} & ${TEAM_NAMES[side]}` : TEAM_NAMES[side];
    }
    return marks;
  }
  if (game.yourSecret) return { [game.yourSecret]: team ? TEAM_NAMES[team] : 'yours' };
  return {};
}

function TurnBanner({ game, you }: { game: GameView; you: RoomView['you'] }) {
  const active = TEAM_NAMES[game.activeTeam];
  const answering = TEAM_NAMES[otherTeam(game.activeTeam)];
  const yourTurn = you.team === game.activeTeam;

  const message =
    game.stage === 'asking'
      ? yourTurn
        ? you.isLeader
          ? 'Your turn — ask a question or make a guess'
          : `Your turn — ${active}'s leader is deciding what to ask`
        : `${active} is thinking of a question`
      : you.team === otherTeam(game.activeTeam)
        ? you.isLeader
          ? 'They asked you — answer yes or no'
          : `${answering}'s leader is answering`
        : `Waiting for ${answering} to answer`;

  return (
    <section className={`turn turn-${game.activeTeam}`}>
      <h2>{message}</h2>
    </section>
  );
}

function Secret({
  characterId,
  name,
  pack,
  team,
}: {
  characterId: string;
  name: string;
  pack: PackManifest;
  team: TeamId | null;
}) {
  const character = pack.characters.find((candidate) => candidate.id === characterId);

  return (
    <section className="secret">
      {character && <img src={packAsset(pack, character.full)} alt="" width={96} height={96} />}
      <div>
        <h2>Your team is {name}</h2>
        <p className="muted">
          Only you can see this{team ? ` — the rest of ${TEAM_NAMES[team]} cannot` : ''}. Everyone shares a
          voice channel, so keep it to yourself.
        </p>
      </div>
    </section>
  );
}

function Actions({
  game,
  you,
  send,
  guessing,
  onStartGuess,
  onCancelGuess,
}: {
  game: GameView;
  you: RoomView['you'];
  send: GameProps['send'];
  guessing: boolean;
  onStartGuess: () => void;
  onCancelGuess: () => void;
}) {
  const [text, setText] = useState('');

  const yourTurn = you.team === game.activeTeam;
  const canAsk = you.isLeader && yourTurn && game.stage === 'asking';
  const canAnswer = you.isLeader && you.team === otherTeam(game.activeTeam) && game.stage === 'answering';

  if (guessing) {
    return (
      <section className="actions">
        <p className="muted">Click the character you think they are.</p>
        <button type="button" className="button is-secondary" onClick={onCancelGuess}>
          Cancel
        </button>
      </section>
    );
  }

  if (canAnswer) {
    const question = game.log[game.log.length - 1];
    return (
      <section className="actions">
        <p className="asked">“{question?.text}”</p>
        <div className="answer-buttons">
          <button
            type="button"
            className="button is-primary"
            onClick={() => send({ type: 'answerQuestion', answer: 'yes' })}
          >
            Yes
          </button>
          <button
            type="button"
            className="button is-secondary"
            onClick={() => send({ type: 'answerQuestion', answer: 'no' })}
          >
            No
          </button>
        </div>
      </section>
    );
  }

  if (!canAsk) return null;

  return (
    <section className="actions">
      <form
        className="ask"
        onSubmit={(event) => {
          event.preventDefault();
          const question = text.trim();
          if (!question) return;
          send({ type: 'askQuestion', text: question });
          setText('');
        }}
      >
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Do they have glasses?"
          maxLength={MAX_QUESTION_LENGTH}
          aria-label="Your question"
        />
        <button type="submit" className="button is-primary" disabled={text.trim().length === 0}>
          Ask
        </button>
      </form>
      <button type="button" className="button is-guess" onClick={onStartGuess}>
        Guess their character
      </button>
    </section>
  );
}

function QuestionLog({ log }: { log: GameView['log'] }) {
  if (log.length === 0) {
    return (
      <section>
        <h2>Questions</h2>
        <p className="muted">Nothing asked yet.</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Questions</h2>
      <ol className="log">
        {/* Newest first: the open question is the one that matters. */}
        {[...log].reverse().map((entry) => (
          <li key={entry.id} className={`log-entry log-${entry.askedBy}`}>
            <span className="log-team">{TEAM_NAMES[entry.askedBy]}</span>
            <span className="log-text">{entry.text}</span>
            <span className={entry.answer ? `log-answer is-${entry.answer}` : 'log-answer is-open'}>
              {entry.answer ?? '…'}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Result({
  outcome,
  reveal,
  nameOf,
  you,
}: {
  outcome: NonNullable<GameView['outcome']>;
  reveal: GameView['reveal'];
  nameOf: (characterId: string) => string;
  you: RoomView['you'];
}) {
  const winner = TEAM_NAMES[outcome.winner];
  const guesser = TEAM_NAMES[outcome.guess.team];
  const youWon = you.team === outcome.winner;

  return (
    <section className={`result result-${outcome.winner}`}>
      <h2>
        {winner} wins{you.team ? (youWon ? ' — that’s you' : '') : ''}
      </h2>
      <p>
        {outcome.reason === 'correct_guess'
          ? `${guesser} named ${nameOf(outcome.guess.characterId)} and got it right.`
          : `${guesser} guessed ${nameOf(outcome.guess.characterId)}, which was wrong.`}
      </p>
      {reveal && (
        <p className="muted">
          {TEAM_NAMES.a} was {nameOf(reveal.a)}. {TEAM_NAMES.b} was {nameOf(reveal.b)}.
        </p>
      )}
    </section>
  );
}
