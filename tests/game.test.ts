import { describe, expect, it } from 'vitest';
import { apply, initialRoom, memberJoined, memberLeft } from '../server/lobby';
import { viewFor } from '../server/redact';
import type { RoomState, TeamId } from '../server/protocol';

/**
 * Distinct, unmistakable ids: the redaction tests assert on serialized frames, so a secret must
 * not be a substring of anything else that legitimately appears.
 */
const BOARD = ['ada', 'bob', 'cy', 'dee', 'eve', 'fox'];

const profile = (userId: string, name = userId) =>
  ({ userId, name, avatar: null, kind: 'guest' }) as const;

function must(state: RoomState, actor: string, message: Parameters<typeof apply>[2]): RoomState {
  const outcome = apply(state, actor, message, { characters: BOARD, pick: pickFor(state) });
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.state;
}

function rejection(state: RoomState, actor: string, message: Parameters<typeof apply>[2]) {
  const outcome = apply(state, actor, message, { characters: BOARD, pick: pickFor(state) });
  if (outcome.ok) throw new Error('expected a rejection, got success');
  return outcome.error;
}

/** Deals 'ada' to Red and 'zed'-free 'fox' to Blue, so the two are never confused in an assertion. */
function pickFor(_state: RoomState) {
  let call = 0;
  return () => (call++ === 0 ? BOARD.indexOf('ada') : BOARD.indexOf('fox'));
}

/**
 * Red: leaderA (leader, also host) + redFan. Blue: leaderB (leader) + blueFan. Plus a spectator.
 * Enough people that "leader-only" and "your team only" are distinguishable from "anyone".
 */
function startedGame(): RoomState {
  let state = initialRoom();
  for (const id of ['leaderA', 'redFan', 'leaderB', 'blueFan', 'watcher']) {
    state = memberJoined(state, profile(id));
  }

  state = must(state, 'leaderA', { type: 'setTeam', team: 'a' });
  state = must(state, 'redFan', { type: 'setTeam', team: 'a' });
  state = must(state, 'leaderB', { type: 'setTeam', team: 'b' });
  state = must(state, 'blueFan', { type: 'setTeam', team: 'b' });
  state = must(state, 'leaderA', { type: 'assignLeader', userId: 'leaderA' });
  state = must(state, 'leaderB', { type: 'assignLeader', userId: 'leaderB' });
  state = must(state, 'leaderA', { type: 'selectPack', packId: 'demo' });
  for (const id of ['leaderA', 'redFan', 'leaderB', 'blueFan']) {
    state = must(state, id, { type: 'setReady', ready: true });
  }
  return must(state, 'leaderA', { type: 'startGame' });
}

const game = (state: RoomState) => {
  if (!state.game) throw new Error('expected a running game');
  return state.game;
};

describe('starting a game', () => {
  it('deals each team a character from the board', () => {
    const state = startedGame();
    expect(game(state).secrets.a).toBe('ada');
    expect(game(state).secrets.b).toBe('fox');
    expect(BOARD).toContain(game(state).secrets.a);
  });

  it('opens with Red asking, nothing flipped and an empty log', () => {
    const state = startedGame();
    expect(state.phase).toBe('in_progress');
    expect(game(state)).toMatchObject({ activeTeam: 'a', stage: 'asking', log: [], flipped: { a: [], b: [] } });
  });

  it('refuses a board too small to deal from', () => {
    let state = initialRoom();
    for (const id of ['leaderA', 'leaderB']) state = memberJoined(state, profile(id));
    state = must(state, 'leaderA', { type: 'setTeam', team: 'a' });
    state = must(state, 'leaderB', { type: 'setTeam', team: 'b' });
    state = must(state, 'leaderA', { type: 'selectPack', packId: 'demo' });
    state = must(state, 'leaderA', { type: 'setReady', ready: true });
    state = must(state, 'leaderB', { type: 'setReady', ready: true });

    const outcome = apply(state, 'leaderA', { type: 'startGame' }, { characters: ['solo'] });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok || outcome.error.code).toBe('pack_too_small');
  });
});

describe('asking and answering', () => {
  it('logs the question and waits for an answer', () => {
    const state = must(startedGame(), 'leaderA', { type: 'askQuestion', text: 'Do they wear glasses?' });
    expect(game(state).stage).toBe('answering');
    expect(game(state).log).toEqual([
      { id: 1, kind: 'question', askedBy: 'a', text: 'Do they wear glasses?', answer: null },
    ]);
    // Asking does not end the turn; answering does.
    expect(game(state).activeTeam).toBe('a');
  });

  it('passes the turn to the team that answered', () => {
    let state = must(startedGame(), 'leaderA', { type: 'askQuestion', text: 'Glasses?' });
    state = must(state, 'leaderB', { type: 'answerQuestion', answer: 'yes' });

    expect(game(state).log[0]?.answer).toBe('yes');
    expect(game(state).activeTeam).toBe('b');
    expect(game(state).stage).toBe('asking');
  });

  it('runs a full round back to Red', () => {
    let state = must(startedGame(), 'leaderA', { type: 'askQuestion', text: 'Glasses?' });
    state = must(state, 'leaderB', { type: 'answerQuestion', answer: 'no' });
    state = must(state, 'leaderB', { type: 'askQuestion', text: 'A hat?' });
    state = must(state, 'leaderA', { type: 'answerQuestion', answer: 'yes' });

    expect(game(state).activeTeam).toBe('a');
    expect(game(state).log.map((entry) => [entry.askedBy, entry.answer])).toEqual([
      ['a', 'no'],
      ['b', 'yes'],
    ]);
  });

  it('lets only the active team’s leader ask', () => {
    const state = startedGame();
    expect(rejection(state, 'redFan', { type: 'askQuestion', text: 'Glasses?' }).code).toBe('not_leader');
    expect(rejection(state, 'leaderB', { type: 'askQuestion', text: 'Glasses?' }).code).toBe('not_your_turn');
    expect(rejection(state, 'watcher', { type: 'askQuestion', text: 'Glasses?' }).code).toBe('not_playing');
  });

  it('refuses a second question while one is outstanding', () => {
    const state = must(startedGame(), 'leaderA', { type: 'askQuestion', text: 'Glasses?' });
    expect(rejection(state, 'leaderA', { type: 'askQuestion', text: 'A hat?' }).code).toBe('awaiting_answer');
  });

  it('lets only the opposing leader answer', () => {
    const state = must(startedGame(), 'leaderA', { type: 'askQuestion', text: 'Glasses?' });
    expect(rejection(state, 'blueFan', { type: 'answerQuestion', answer: 'yes' }).code).toBe('not_leader');
    // The asker must not be able to answer their own question.
    expect(rejection(state, 'leaderA', { type: 'answerQuestion', answer: 'yes' }).code).toBe('not_your_question');
  });

  it('refuses an answer when nothing was asked', () => {
    expect(rejection(startedGame(), 'leaderB', { type: 'answerQuestion', answer: 'yes' }).code).toBe('no_question');
  });
});

describe('passing', () => {
  it('hands the turn over and says so in the log', () => {
    const state = must(startedGame(), 'leaderA', { type: 'passTurn' });

    expect(game(state).activeTeam).toBe('b');
    expect(game(state).stage).toBe('asking');
    expect(game(state).log).toEqual([{ id: 1, kind: 'pass', askedBy: 'a', text: '', answer: null }]);
  });

  it('is leader-only and turn-only', () => {
    const state = startedGame();
    expect(rejection(state, 'redFan', { type: 'passTurn' }).code).toBe('not_leader');
    expect(rejection(state, 'leaderB', { type: 'passTurn' }).code).toBe('not_your_turn');
  });

  it('cannot dodge an open question', () => {
    const state = must(startedGame(), 'leaderA', { type: 'askQuestion', text: 'Glasses?' });
    expect(rejection(state, 'leaderA', { type: 'passTurn' }).code).toBe('awaiting_answer');
  });

  it('does not stall the game when the other team is already out', () => {
    let state = must(startedGame(), 'leaderA', { type: 'submitGuess', characterId: 'dee' });
    state = must(state, 'leaderA', { type: 'playOn' });
    expect(rejection(state, 'leaderB', { type: 'passTurn' }).code).toBe('nobody_to_pass_to');
  });

  it('keeps numbering the log across passes and questions', () => {
    let state = must(startedGame(), 'leaderA', { type: 'passTurn' });
    state = must(state, 'leaderB', { type: 'askQuestion', text: 'Glasses?' });

    expect(game(state).log.map((entry) => [entry.id, entry.kind])).toEqual([
      [1, 'pass'],
      [2, 'question'],
    ]);
  });
});

describe('flipping tiles', () => {
  it('is open to the whole team, not just the leader', () => {
    const state = must(startedGame(), 'redFan', { type: 'flipTile', characterId: 'bob', down: true });
    expect(game(state).flipped.a).toEqual(['bob']);
  });

  it('keeps each team’s board to itself', () => {
    let state = must(startedGame(), 'leaderA', { type: 'flipTile', characterId: 'bob', down: true });
    state = must(state, 'leaderB', { type: 'flipTile', characterId: 'dee', down: true });

    expect(game(state).flipped).toEqual({ a: ['bob'], b: ['dee'] });
  });

  it('flips back down and resets', () => {
    let state = must(startedGame(), 'leaderA', { type: 'flipTile', characterId: 'bob', down: true });
    state = must(state, 'leaderA', { type: 'flipTile', characterId: 'cy', down: true });
    state = must(state, 'leaderA', { type: 'flipTile', characterId: 'bob', down: false });
    expect(game(state).flipped.a).toEqual(['cy']);

    state = must(state, 'leaderA', { type: 'resetFlips' });
    expect(game(state).flipped.a).toEqual([]);
  });

  it('works in either team’s turn — ruling faces out is not turn-bound', () => {
    const state = must(startedGame(), 'blueFan', { type: 'flipTile', characterId: 'ada', down: true });
    expect(game(state).flipped.b).toEqual(['ada']);
  });

  it('rejects a character that is not on the board', () => {
    expect(rejection(startedGame(), 'leaderA', { type: 'flipTile', characterId: 'nobody', down: true }).code).toBe(
      'no_such_character',
    );
  });

  it('is a no-op when the tile is already in that position', () => {
    const state = startedGame();
    const outcome = apply(state, 'leaderA', { type: 'flipTile', characterId: 'bob', down: false }, {});
    expect(outcome.ok && outcome.state).toBe(state);
  });
});

describe('guessing', () => {
  it('wins the game when the guess is right', () => {
    // Red guesses Blue's character, which pickFor dealt as 'fox'.
    const state = must(startedGame(), 'leaderA', { type: 'submitGuess', characterId: 'fox' });

    expect(state.phase).toBe('endgame');
    expect(game(state).outcome).toEqual({
      winner: 'a',
      reason: 'correct_guess',
      guesses: [{ team: 'a', characterId: 'fox', correct: true }],
    });
  });

  it('hands the game to the other team when the guess is wrong and they never reply', () => {
    const state = must(startedGame(), 'leaderA', { type: 'submitGuess', characterId: 'dee' });

    expect(state.phase).toBe('endgame');
    expect(game(state).outcome).toMatchObject({ winner: 'b', reason: 'wrong_guess' });
  });

  it('is leader-only and turn-only', () => {
    const state = startedGame();
    expect(rejection(state, 'redFan', { type: 'submitGuess', characterId: 'fox' }).code).toBe('not_leader');
    expect(rejection(state, 'leaderB', { type: 'submitGuess', characterId: 'ada' }).code).toBe('not_your_turn');
  });

  it('cannot be used to dodge an outstanding question', () => {
    const state = must(startedGame(), 'leaderA', { type: 'askQuestion', text: 'Glasses?' });
    expect(rejection(state, 'leaderA', { type: 'submitGuess', characterId: 'fox' }).code).toBe('awaiting_answer');
  });

  it('freezes the game once it is decided', () => {
    const state = must(startedGame(), 'leaderA', { type: 'submitGuess', characterId: 'fox' });
    expect(rejection(state, 'leaderB', { type: 'askQuestion', text: 'Again?' }).code).toBe('game_over');
    expect(rejection(state, 'leaderB', { type: 'flipTile', characterId: 'ada', down: true }).code).toBe('game_over');
  });
});

describe('playing it through', () => {
  /** Red has guessed; Blue has not had its attempt yet. */
  const afterRedGuesses = (characterId: string) =>
    must(startedGame(), 'leaderA', { type: 'submitGuess', characterId });

  it('offers the other team their turn back', () => {
    const finished = afterRedGuesses('dee');
    expect(viewFor(finished, 'leaderB').game?.canPlayOn).toBe(true);

    const reopened = must(finished, 'leaderA', { type: 'playOn' });
    expect(reopened.phase).toBe('in_progress');
    expect(game(reopened).outcome).toBeNull();
    // Blue is on, and it is a fresh turn rather than a half-finished one.
    expect(game(reopened)).toMatchObject({ activeTeam: 'b', stage: 'asking' });
  });

  it('keeps the log, the boards and both secrets across the reopen', () => {
    let state = must(startedGame(), 'leaderA', { type: 'flipTile', characterId: 'bob', down: true });
    state = must(state, 'leaderA', { type: 'askQuestion', text: 'Glasses?' });
    state = must(state, 'leaderB', { type: 'answerQuestion', answer: 'yes' });
    state = must(state, 'leaderB', { type: 'flipTile', characterId: 'dee', down: true });
    state = must(state, 'leaderB', { type: 'submitGuess', characterId: 'cy' });
    state = must(state, 'leaderA', { type: 'playOn' });

    expect(game(state).log).toHaveLength(1);
    expect(game(state).flipped).toEqual({ a: ['bob'], b: ['dee'] });
    expect(game(state).secrets).toEqual({ a: 'ada', b: 'fox' });
    expect(viewFor(state, 'leaderA').game?.yourSecret).toBe('ada');
  });

  it('lets the team that already guessed answer but not ask or guess again', () => {
    const reopened = must(afterRedGuesses('dee'), 'leaderA', { type: 'playOn' });

    expect(rejection(reopened, 'leaderA', { type: 'askQuestion', text: 'Another?' }).code).toBe('not_your_turn');
    expect(rejection(reopened, 'leaderA', { type: 'submitGuess', characterId: 'eve' }).code).toBe('not_your_turn');

    // But Red still holds the character Blue is hunting, so Red must still answer.
    const asked = must(reopened, 'leaderB', { type: 'askQuestion', text: 'Glasses?' });
    const answered = must(asked, 'leaderA', { type: 'answerQuestion', answer: 'no' });
    expect(game(answered).log).toEqual([{ id: 1, kind: 'question', askedBy: 'b', text: 'Glasses?', answer: 'no' }]);
  });

  it('does not pass the turn back to a team that has finished', () => {
    let state = must(afterRedGuesses('dee'), 'leaderA', { type: 'playOn' });
    state = must(state, 'leaderB', { type: 'askQuestion', text: 'Glasses?' });
    state = must(state, 'leaderA', { type: 'answerQuestion', answer: 'yes' });

    // Normally answering takes the turn; Red is out, so Blue keeps going.
    expect(game(state).activeTeam).toBe('b');
    expect(game(state).stage).toBe('asking');
  });

  it('gives the win to the team that guesses right second', () => {
    let state = must(afterRedGuesses('dee'), 'leaderA', { type: 'playOn' });
    state = must(state, 'leaderB', { type: 'submitGuess', characterId: 'ada' });

    expect(state.phase).toBe('endgame');
    expect(game(state).outcome).toMatchObject({ winner: 'b', reason: 'correct_guess' });
  });

  it('is a draw when both teams name the wrong character', () => {
    let state = must(afterRedGuesses('dee'), 'leaderA', { type: 'playOn' });
    state = must(state, 'leaderB', { type: 'submitGuess', characterId: 'eve' });

    expect(game(state).outcome).toMatchObject({ winner: null, reason: 'draw' });
    expect(game(state).outcome?.guesses).toHaveLength(2);
  });

  it('keeps the win with whoever got there first', () => {
    // Red is right, Blue plays on and is also right — Red still took it.
    let state = must(afterRedGuesses('fox'), 'leaderA', { type: 'playOn' });
    state = must(state, 'leaderB', { type: 'submitGuess', characterId: 'ada' });

    expect(game(state).outcome).toMatchObject({ winner: 'a', reason: 'correct_guess' });
  });

  it('cannot be reopened once both teams have guessed', () => {
    let state = must(afterRedGuesses('dee'), 'leaderA', { type: 'playOn' });
    state = must(state, 'leaderB', { type: 'submitGuess', characterId: 'eve' });

    expect(viewFor(state, 'leaderA').game?.canPlayOn).toBe(false);
    expect(rejection(state, 'leaderA', { type: 'playOn' }).code).toBe('nothing_to_finish');
  });

  it('is host-only and endgame-only', () => {
    expect(rejection(afterRedGuesses('dee'), 'leaderB', { type: 'playOn' }).code).toBe('not_host');
    expect(rejection(startedGame(), 'leaderA', { type: 'playOn' }).code).toBe('not_finished');
  });
});

describe('a team walking out', () => {
  it('ends a running game when the last player on a side leaves', () => {
    let state = startedGame();
    state = memberLeft(state, 'leaderB');
    expect(state.phase).toBe('in_progress');

    // blueFan was the last one holding Blue up.
    state = memberLeft(state, 'blueFan');
    expect(state.phase).toBe('endgame');
    expect(game(state).outcome).toMatchObject({ winner: 'a', reason: 'abandoned' });
  });

  it('settles on the first team to walk out, whatever happens after', () => {
    let state = startedGame();
    state = memberLeft(state, 'leaderA');
    state = memberLeft(state, 'redFan');
    expect(game(state).outcome).toMatchObject({ winner: 'b', reason: 'abandoned' });

    // Blue leaving afterwards does not reopen or rewrite a game that is already over.
    state = memberLeft(state, 'leaderB');
    state = memberLeft(state, 'blueFan');
    expect(state.phase).toBe('endgame');
    expect(game(state).outcome).toMatchObject({ winner: 'b', reason: 'abandoned' });
  });

  it('does not end a game over a spectator leaving', () => {
    const state = memberLeft(startedGame(), 'watcher');
    expect(state.phase).toBe('in_progress');
  });

  it('does not offer to reopen a game nobody is left to play', () => {
    let state = startedGame();
    state = memberLeft(state, 'leaderB');
    state = memberLeft(state, 'blueFan');

    // Blue never guessed, but there is no Blue left to send back in.
    expect(viewFor(state, 'leaderA').game?.canPlayOn).toBe(false);
  });
});

describe('playing again', () => {
  const finished = () => must(startedGame(), 'leaderA', { type: 'submitGuess', characterId: 'fox' });

  it('deals a fresh game with the same teams and board', () => {
    const again = must(finished(), 'leaderA', { type: 'playAgain' });

    expect(again.phase).toBe('in_progress');
    expect(game(again)).toMatchObject({ activeTeam: 'a', stage: 'asking', log: [], guesses: [], outcome: null });
    expect(game(again).characters).toEqual(BOARD);
    expect(game(again).flipped).toEqual({ a: [], b: [] });
    // Same line-up — nobody has to pick a team or ready up again.
    expect(again.leaders).toEqual({ a: 'leaderA', b: 'leaderB' });
    expect(again.packId).toBe('demo');
  });

  it('is host-only and endgame-only', () => {
    expect(rejection(finished(), 'leaderB', { type: 'playAgain' }).code).toBe('not_host');
    expect(rejection(startedGame(), 'leaderA', { type: 'playAgain' }).code).toBe('not_finished');
  });

  it('is refused when a team has nobody left', () => {
    let state = finished();
    state = memberLeft(state, 'leaderB');
    state = memberLeft(state, 'blueFan');

    expect(rejection(state, 'leaderA', { type: 'playAgain' }).code).toBe('team_empty');
  });
});

describe('rematch', () => {
  it('returns to the lobby with teams and leaders intact', () => {
    let state = must(startedGame(), 'leaderA', { type: 'submitGuess', characterId: 'fox' });
    state = must(state, 'leaderA', { type: 'rematch' });

    expect(state.phase).toBe('lobby');
    expect(state.game).toBeNull();
    expect(state.leaders).toEqual({ a: 'leaderA', b: 'leaderB' });
    expect(state.members.find((member) => member.userId === 'blueFan')?.team).toBe('b');
    // Agreeing to one game is not agreeing to the next.
    expect(state.members.every((member) => !member.ready)).toBe(true);
  });

  it('is host-only and endgame-only', () => {
    const finished = must(startedGame(), 'leaderA', { type: 'submitGuess', characterId: 'fox' });
    expect(rejection(finished, 'leaderB', { type: 'rematch' }).code).toBe('not_host');
    expect(rejection(startedGame(), 'leaderA', { type: 'rematch' }).code).toBe('not_finished');
  });
});

describe('redaction', () => {
  /** A game with both teams' deductions on the board and a question in the log. */
  function midGame(): RoomState {
    let state = must(startedGame(), 'leaderA', { type: 'flipTile', characterId: 'bob', down: true });
    state = must(state, 'redFan', { type: 'flipTile', characterId: 'cy', down: true });
    state = must(state, 'leaderB', { type: 'flipTile', characterId: 'dee', down: true });
    state = must(state, 'leaderA', { type: 'askQuestion', text: 'Glasses?' });
    return must(state, 'leaderB', { type: 'answerQuestion', answer: 'yes' });
  }

  /** The bytes that actually go down the socket — the only thing that can leak. */
  const frameFor = (state: RoomState, userId: string) => JSON.stringify(viewFor(state, userId));

  it('sends Team B neither Red’s secret nor Red’s flipped tiles', () => {
    const state = midGame();

    for (const userId of ['leaderB', 'blueFan']) {
      const frame = frameFor(state, userId);
      expect(frame).not.toContain('ada'); // Red's secret
      expect(frame).not.toContain('bob'); // Red's deductions
      expect(frame).not.toContain('cy');
      // Their own board still arrives, or there would be nothing to play with.
      expect(frame).toContain('dee');
    }
  });

  it('shows a secret to its own leader and to nobody else', () => {
    const state = midGame();

    expect(viewFor(state, 'leaderA').game?.yourSecret).toBe('ada');
    expect(viewFor(state, 'leaderB').game?.yourSecret).toBe('fox');
    // Teammates share a voice channel with the opposition, so they are not told either.
    expect(viewFor(state, 'redFan').game?.yourSecret).toBeNull();
    expect(viewFor(state, 'blueFan').game?.yourSecret).toBeNull();
    expect(frameFor(state, 'redFan')).not.toContain('ada');
  });

  it('gives a player only their own board', () => {
    const state = midGame();

    expect(viewFor(state, 'redFan').game?.flipped).toEqual({ a: ['bob', 'cy'] });
    expect(viewFor(state, 'blueFan').game?.flipped).toEqual({ b: ['dee'] });
  });

  it('gives spectators both boards but neither secret', () => {
    const state = midGame();
    const view = viewFor(state, 'watcher');

    expect(view.game?.flipped).toEqual({ a: ['bob', 'cy'], b: ['dee'] });
    expect(view.game?.yourSecret).toBeNull();
    expect(view.game?.reveal).toBeNull();
    const frame = frameFor(state, 'watcher');
    expect(frame).not.toContain('ada');
    expect(frame).not.toContain('fox');
  });

  it('keeps the question log public', () => {
    const state = midGame();
    for (const userId of ['leaderA', 'redFan', 'leaderB', 'blueFan', 'watcher']) {
      expect(viewFor(state, userId).game?.log).toEqual([
        { id: 1, kind: 'question', askedBy: 'a', text: 'Glasses?', answer: 'yes' },
      ]);
    }
  });

  it('reveals both characters to everyone once the game is over', () => {
    const finished = must(midGame(), 'leaderB', { type: 'submitGuess', characterId: 'ada' });

    for (const userId of ['leaderA', 'redFan', 'leaderB', 'blueFan', 'watcher']) {
      const view = viewFor(finished, userId);
      expect(view.game?.reveal).toEqual({ a: 'ada', b: 'fox' });
      // With nothing left to protect, both boards open up too.
      expect(Object.keys(view.game?.flipped ?? {}).sort()).toEqual(['a', 'b']);
    }
  });

  it('never lets a lobby view carry a game', () => {
    const state = initialRoom();
    expect(viewFor(memberJoined(state, profile('someone')), 'someone').game).toBeNull();
  });
});

describe('reconnecting mid-game', () => {
  it('restores a leader’s secret when they come back', () => {
    const state = startedGame();
    const returned = memberJoined(state, profile('leaderA', 'leaderA renamed'));

    const view = viewFor(returned, 'leaderA');
    expect(view.you.isLeader).toBe(true);
    expect(view.game?.yourSecret).toBe('ada');
  });
});

describe('team ids', () => {
  it('covers both teams in the flip map', () => {
    const teams: TeamId[] = ['a', 'b'];
    expect(Object.keys(game(startedGame()).flipped).sort()).toEqual(teams);
  });
});
