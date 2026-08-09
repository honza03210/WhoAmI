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

import type { ClientMessage, GameState, RoomState, TeamId } from './protocol';
import { otherTeam } from './protocol';

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
export function beginGame(state: RoomState, characters: readonly string[], pick: Pick): Outcome {
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

export function applyGame(state: RoomState, actorId: string, message: ClientMessage): Outcome {
  if (message.type === 'rematch') return rematch(state, actorId);

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

      const log = [
        ...game.log,
        { id: game.nextQuestionId, askedBy: actor.team, text: message.text, answer: null },
      ];
      return accept(withGame(state, { ...game, log, nextQuestionId: game.nextQuestionId + 1, stage: 'answering' }));
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
      // Answering ends the turn: play passes to the team that just answered.
      return accept(withGame(state, { ...game, log, stage: 'asking', activeTeam: answering }));
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
      if (!game.characters.includes(message.characterId)) {
        return reject('no_such_character', 'That character is not on this board');
      }

      const target = otherTeam(actor.team);
      const correct = game.secrets[target] === message.characterId;

      return accept({
        ...state,
        phase: 'endgame',
        game: {
          ...game,
          // A wrong guess hands the game over: the bluff costs you, exactly as at the table.
          outcome: {
            winner: correct ? actor.team : target,
            reason: correct ? 'correct_guess' : 'wrong_guess',
            guess: { team: actor.team, characterId: message.characterId, correct },
          },
        },
      });
    }

    default:
      return reject('not_in_game', 'That does not apply once the game has started');
  }
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
