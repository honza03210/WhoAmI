/**
 * The running game, as pure functions over RoomState.
 *
 * Same contract as lobby.ts: value in, value out, no Durable Object plumbing, so every rule here
 * is testable without booting a runtime. `lobby.ts` dispatches to these once the phase leaves the
 * lobby; `redact.ts` decides who is allowed to see the result.
 *
 * Two rules carry the whole design:
 *
 *   - A team's secret belongs to its leader alone. Everyone shares a voice channel, so a secret
 *     the whole team can see is a secret someone says out loud within a minute.
 *   - Only the leader may ask, answer or guess. Everyone else flips tiles and argues.
 */

import type { ClientMessage, GameGuess, GameOutcome, GameState, RoomState, TeamId } from './protocol';
import { TEAM_IDS, TEAM_NAMES, otherTeam } from './protocol';

export interface Rejection {
  code: string;
  message: string;
}

export type Outcome = { ok: true; state: RoomState } | { ok: false; error: Rejection };

const reject = (code: string, message: string): Outcome => ({ ok: false, error: { code, message } });
const accept = (state: RoomState): Outcome => ({ ok: true, state });

/**
 * Picks an index below `upperBound`. Injectable so tests can pin the secrets; production passes
 * a crypto-backed one from room.ts.
 */
export type Pick = (upperBound: number) => number;

/**
 * Deals both teams a character and starts the clock.
 *
 * The two secrets are drawn independently, so both teams hunting the same character is possible
 * and fine — it is the one case where the question logs read identically, which nobody notices.
 */
export function beginGame(state: RoomState, characters: readonly string[], pick: Pick = randomIndex): Outcome {
  if (characters.length < 2) {
    return reject('pack_too_small', 'That pack needs at least two characters');
  }

  const draw = (): string => {
    const index = pick(characters.length);
    // A rogue Pick must not be able to hand out `undefined` as a secret.
    return characters[Math.min(Math.max(index, 0), characters.length - 1)] as string;
  };

  const game: GameState = {
    characters: [...characters],
    secrets: { a: draw(), b: draw() },
    flipped: { a: [], b: [] },
    // Red opens. Fixed rather than random so nobody has to explain the rule at the table.
    activeTeam: 'a',
    stage: 'asking',
    log: [],
    nextQuestionId: 1,
    guesses: [],
    outcome: null,
  };

  return accept({ ...state, phase: 'in_progress', game });
}

/** Every in-game message needs a live game and a member on a team; this resolves both at once. */
interface Actor {
  team: TeamId;
  isLeader: boolean;
}

function actorIn(state: RoomState, userId: string): Actor | null {
  const member = state.members.find((candidate) => candidate.userId === userId);
  if (!member?.team) return null;
  return { team: member.team, isLeader: state.leaders[member.team] === userId };
}

export function applyGame(
  state: RoomState,
  actorId: string,
  message: ClientMessage,
  pick: Pick = randomIndex,
): Outcome {
  if (message.type === 'rematch') return rematch(state, actorId);
  if (message.type === 'playOn') return playOn(state, actorId);
  if (message.type === 'playAgain') return playAgain(state, actorId, pick);

  const game = state.game;
  if (!game) return reject('not_in_game', 'No game is running');
  // Checked before the phase so a click that lands just after the final guess says why.
  if (game.outcome) return reject('game_over', 'The game is over');
  if (state.phase !== 'in_progress') return reject('not_in_game', 'No game is running');

  const actor = actorIn(state, actorId);
  if (!actor) return reject('not_playing', 'Only players on a team can do that');

  switch (message.type) {
    case 'askQuestion': {
      if (!actor.isLeader) return reject('not_leader', 'Only your team leader can ask');
      if (actor.team !== game.activeTeam) return reject('not_your_turn', "It is the other team's turn");
      if (game.stage !== 'asking') return reject('awaiting_answer', 'Wait for your question to be answered');
      if (hasGuessed(game, actor.team)) return reject('already_guessed', 'Your team has already guessed');

      const log = [
        ...game.log,
        { id: game.nextQuestionId, kind: 'question' as const, askedBy: actor.team, text: message.text, answer: null },
      ];
      return accept(withGame(state, { ...game, log, nextQuestionId: game.nextQuestionId + 1, stage: 'answering' }));
    }

    case 'passTurn': {
      if (!actor.isLeader) return reject('not_leader', 'Only your team leader can pass');
      if (actor.team !== game.activeTeam) return reject('not_your_turn', "It is the other team's turn");
      if (game.stage !== 'asking') return reject('awaiting_answer', 'Wait for your question to be answered');

      // With the other team out of the running there is nobody to hand the turn to, and passing
      // would just stall the game.
      const next = otherTeam(actor.team);
      if (hasGuessed(game, next)) return reject('nobody_to_pass_to', 'The other team has already guessed');

      const log = [
        ...game.log,
        { id: game.nextQuestionId, kind: 'pass' as const, askedBy: actor.team, text: '', answer: null },
      ];
      return accept(
        withGame(state, { ...game, log, nextQuestionId: game.nextQuestionId + 1, activeTeam: next }),
      );
    }

    case 'answerQuestion': {
      if (game.stage !== 'answering') return reject('no_question', 'There is no question to answer');
      // The question is aimed at the other team, so their leader is the one who knows.
      const answering = otherTeam(game.activeTeam);
      if (actor.team !== answering) return reject('not_your_question', 'That question is not for your team');
      if (!actor.isLeader) return reject('not_leader', 'Only your team leader can answer');

      const log = game.log.map((entry, index) =>
        index === game.log.length - 1 ? { ...entry, answer: message.answer } : entry,
      );
      // Answering ends the turn: play passes to the team that just answered — unless they have
      // already had their guess, in which case they are only here to answer and the asker
      // continues alone.
      const next = hasGuessed(game, answering) ? game.activeTeam : answering;
      return accept(withGame(state, { ...game, log, stage: 'asking', activeTeam: next }));
    }

    case 'flipTile': {
      // Deliberately open to the whole team, and in either team's turn — ruling faces out
      // together is the part everyone plays.
      if (!game.characters.includes(message.characterId)) {
        return reject('no_such_character', 'That character is not on this board');
      }

      const current = game.flipped[actor.team];
      const isDown = current.includes(message.characterId);
      if (isDown === message.down) return accept(state);

      const next = message.down
        ? [...current, message.characterId]
        : current.filter((id) => id !== message.characterId);

      return accept(withGame(state, { ...game, flipped: { ...game.flipped, [actor.team]: next } }));
    }

    case 'resetFlips': {
      if (game.flipped[actor.team].length === 0) return accept(state);
      return accept(withGame(state, { ...game, flipped: { ...game.flipped, [actor.team]: [] } }));
    }

    case 'submitGuess': {
      if (!actor.isLeader) return reject('not_leader', 'Only your team leader can guess');
      if (actor.team !== game.activeTeam) return reject('not_your_turn', "It is the other team's turn");
      // A guess replaces this turn's question, so it can only happen before one is outstanding.
      if (game.stage !== 'asking') return reject('awaiting_answer', 'Answer the open question first');
      if (hasGuessed(game, actor.team)) return reject('already_guessed', 'Your team has already guessed');
      if (!game.characters.includes(message.characterId)) {
        return reject('no_such_character', 'That character is not on this board');
      }

      const target = otherTeam(actor.team);
      const guesses = [
        ...game.guesses,
        { team: actor.team, characterId: message.characterId, correct: game.secrets[target] === message.characterId },
      ];

      // Naming a character always stops play — the board is decided and the reveal is the payoff.
      // Whether that is final depends on whether the other team still wants their attempt.
      return accept({ ...state, phase: 'endgame', game: { ...game, guesses, outcome: resolve(guesses) } });
    }

    default:
      return reject('not_in_game', 'That does not apply once the game has started');
  }
}

export function hasGuessed(game: GameState, team: TeamId): boolean {
  return game.guesses.some((guess) => guess.team === team);
}

/**
 * The team owed a turn, which only means anything once exactly one team has guessed.
 *
 * With no guesses at all there is nothing to finish — that is a game that ended some other way,
 * such as a team walking out — and with two the game is done.
 */
export function teamStillToGuess(game: GameState): TeamId | null {
  if (game.guesses.length !== 1) return null;
  return TEAM_IDS.find((team) => !hasGuessed(game, team)) ?? null;
}

/**
 * Who won, from the guesses made so far.
 *
 * Naming the character wins, and naming it first wins outright — a second correct guess is a
 * team proving they had it too, not a tie. One wrong guess with no reply hands the game over,
 * which is the classic penalty. Two wrong guesses is a draw: nobody found them.
 */
function resolve(guesses: GameGuess[]): GameOutcome {
  const correct = guesses.find((guess) => guess.correct);
  if (correct) return { winner: correct.team, reason: 'correct_guess', guesses };

  const only = guesses.length === 1 ? guesses[0] : undefined;
  if (only) return { winner: otherTeam(only.team), reason: 'wrong_guess', guesses };

  return { winner: null, reason: 'draw', guesses };
}

/**
 * Sends everyone back in so the team that has not guessed can finish.
 *
 * A guess stops the game dead, which is unfair on a team mid-deduction — they may not even have
 * had the same number of turns. This reopens the board for them alone: they ask, the team that
 * already guessed still answers, and their own guess ends it for good.
 */
function playOn(state: RoomState, actorId: string): Outcome {
  if (state.phase !== 'endgame' || !state.game) return reject('not_finished', 'The game is still going');
  if (state.hostId !== actorId) return reject('not_host', 'Only the host can reopen the game');

  const remaining = teamStillToGuess(state.game);
  if (!remaining) return reject('nothing_to_finish', 'There is no turn left to hand back');

  return accept({
    ...state,
    phase: 'in_progress',
    game: { ...state.game, activeTeam: remaining, stage: 'asking', outcome: null },
  });
}

/** Connected players on a team. A team with none of these cannot take a turn. */
function manning(state: RoomState, team: TeamId): boolean {
  return state.members.some((member) => member.team === team && member.connected);
}

/**
 * Straight into another game with the same teams, leaders and board.
 *
 * Everyone has already agreed to this line-up by playing a game with it, so this skips the lobby
 * and the ready-up entirely. The board is reused from the finished game, which is also why this
 * needs no pack lookup.
 */
function playAgain(state: RoomState, actorId: string, pick: Pick): Outcome {
  if (state.phase !== 'endgame' || !state.game) return reject('not_finished', 'The game is still going');
  if (state.hostId !== actorId) return reject('not_host', 'Only the host can start another game');

  const short = TEAM_IDS.find((team) => !manning(state, team));
  if (short) return reject('team_empty', `${TEAM_NAMES[short]} has nobody left to play`);

  return beginGame(state, state.game.characters, pick);
}

/**
 * Ends a game that has lost a whole team.
 *
 * Called after every departure. One team walking out is a walkover for the other; both going is
 * nobody's win. Without this the room would sit in `in_progress` forever waiting for a turn that
 * no connected player can take.
 */
export function endIfTeamAbandoned(state: RoomState): RoomState {
  if (state.phase !== 'in_progress' || !state.game) return state;

  const empty = TEAM_IDS.filter((team) => !manning(state, team));
  if (empty.length === 0) return state;

  const survivor = TEAM_IDS.find((team) => !empty.includes(team)) ?? null;
  return {
    ...state,
    phase: 'endgame',
    game: { ...state.game, outcome: { winner: survivor, reason: 'abandoned', guesses: state.game.guesses } },
  };
}

/**
 * Rejection sampling rather than a plain modulo, so every character is equally likely to be
 * drawn. Cheap insurance against a board where one face quietly comes up more often than the rest.
 */
export function randomIndex(upperBound: number): number {
  const ceiling = Math.floor(2 ** 32 / upperBound) * upperBound;
  const buffer = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0] ?? 0;
  } while (value >= ceiling);
  return value % upperBound;
}

/**
 * Back to the lobby with the same teams and leaders, so a rematch is one click rather than a
 * re-setup. Readiness is cleared: agreeing to one game is not agreeing to the next.
 */
function rematch(state: RoomState, actorId: string): Outcome {
  if (state.phase !== 'endgame') return reject('not_finished', 'The game is still going');
  if (state.hostId !== actorId) return reject('not_host', 'Only the host can start a rematch');

  return accept({
    ...state,
    phase: 'lobby',
    game: null,
    members: state.members.map((member) => ({ ...member, ready: false })),
  });
}

const withGame = (state: RoomState, game: GameState): RoomState => ({ ...state, game });
