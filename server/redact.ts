/**
 * Builds the view of the room for one specific recipient.
 *
 * This is the only place a `RoomState` is allowed to turn into something sent over a socket, and
 * the reason `room.ts` fans out per-connection instead of broadcasting one shared blob. Two
 * things must never reach the wrong client:
 *
 *   - **A team's secret.** Its own leader sees it. Nobody else does, including that leader's own
 *     teammates — they share a voice channel with the opposition.
 *   - **A team's flipped tiles.** Which faces you have ruled out is your working deduction; handing
 *     it to the opponent hands them the answer.
 *
 * Both are dropped by construction here rather than trimmed from a fuller object, so a field
 * added to `GameState` later is invisible until someone deliberately exposes it.
 */

import type { GameState, GameView, RoomState, RoomView, TeamId } from './protocol';
import { startBlockers } from './lobby';

export function viewFor(state: RoomState, userId: string): RoomView {
  const member = state.members.find((candidate) => candidate.userId === userId);
  const team = member?.team ?? null;
  const isLeader = team !== null && state.leaders[team] === userId;

  return {
    phase: state.phase,
    hostId: state.hostId,
    packId: state.packId,
    // Public: everyone in the room has to be able to load the faces on the board.
    customPack: state.customPack,
    leaders: state.leaders,
    members: state.members,
    game: state.game ? gameViewFor(state.game, team, isLeader) : null,
    you: {
      userId,
      team,
      isHost: state.hostId === userId,
      isLeader,
    },
    startBlockers: startBlockers(state),
  };
}

function gameViewFor(game: GameState, team: TeamId | null, isLeader: boolean): GameView {
  // Nothing is worth hiding once the game is decided, and the reveal is the payoff.
  const over = game.outcome !== null;

  return {
    activeTeam: game.activeTeam,
    stage: game.stage,
    flipped: visibleFlips(game, team, over),
    yourSecret: team !== null && isLeader ? game.secrets[team] : null,
    reveal: over ? game.secrets : null,
    log: game.log,
    outcome: game.outcome,
  };
}

/**
 * Players see their own board only. Spectators have no side to give away, so they get both —
 * which is what makes watching a game worth doing.
 */
function visibleFlips(
  game: GameState,
  team: TeamId | null,
  over: boolean,
): Partial<Record<TeamId, string[]>> {
  if (team === null || over) return game.flipped;
  return { [team]: game.flipped[team] };
}
