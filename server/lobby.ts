/**
 * Room rules as pure functions over RoomState.
 *
 * Deliberately free of Durable Object plumbing: every transition is a plain value-in/value-out
 * function, which is what makes the permission and leadership rules testable without booting a
 * runtime. `room.ts` owns persistence and sockets; this owns what is allowed to happen.
 *
 * `apply` is the single entry point for anything a client asks for. Lobby transitions live here;
 * once a game is running it hands over to game.ts, which enforces turns and leader authority.
 */

import type { ClientMessage, Member, RoomState, TeamId } from './protocol';
import { CUSTOM_PACK_ID, TEAM_IDS, TEAM_NAMES, isTeamId } from './protocol';
import { applyGame, beginGame, type Outcome, type Pick, type Rejection } from './game';

export type { Outcome, Rejection };

export interface Profile {
  userId: string;
  name: string;
  avatar: string | null;
}

/**
 * What a transition needs from the outside world. Only `startGame` uses either: it has to know
 * the board before it can deal secrets, and room.ts resolves that from the pack manifest.
 */
export interface Deps {
  characters?: readonly string[];
  pick?: Pick;
}

const reject = (code: string, message: string): Outcome => ({ ok: false, error: { code, message } });
const accept = (state: RoomState): Outcome => ({ ok: true, state });

export function initialRoom(): RoomState {
  return {
    phase: 'lobby',
    hostId: null,
    packId: null,
    customPack: null,
    leaders: { a: null, b: null },
    members: [],
    game: null,
  };
}

const find = (state: RoomState, userId: string): Member | undefined =>
  state.members.find((member) => member.userId === userId);

const teamMembers = (state: RoomState, team: TeamId): Member[] =>
  state.members.filter((member) => member.team === team);

/**
 * Leadership and hosting must never point at someone who has gone. Rather than patching those
 * fields at every call site, every transition ends here.
 */
function reconcile(state: RoomState): RoomState {
  const present = state.members.filter((member) => member.connected);

  const hostId =
    state.hostId && present.some((member) => member.userId === state.hostId)
      ? state.hostId
      : (present[0]?.userId ?? null);

  const leaders = { ...state.leaders };
  for (const team of TEAM_IDS) {
    const current = leaders[team];
    const stillEligible =
      current && present.some((member) => member.userId === current && member.team === team);
    if (!stillEligible) {
      // Longest-standing connected member of the team inherits it.
      leaders[team] = present.find((member) => member.team === team)?.userId ?? null;
    }
  }

  return { ...state, hostId, leaders };
}

export function memberJoined(state: RoomState, profile: Profile): RoomState {
  const existing = find(state, profile.userId);

  const members = existing
    ? state.members.map((member) =>
        member.userId === profile.userId
          ? { ...member, name: profile.name, avatar: profile.avatar, connected: true }
          : member,
      )
    : [
        ...state.members,
        {
          userId: profile.userId,
          name: profile.name,
          avatar: profile.avatar,
          team: null,
          ready: false,
          connected: true,
        },
      ];

  return reconcile({ ...state, members });
}

export function memberLeft(state: RoomState, userId: string): RoomState {
  // In the lobby there is nothing to come back to, so leavers are dropped outright. Once a game
  // is running the record is kept so a reconnect can restore the player's team and role.
  const members =
    state.phase === 'lobby'
      ? state.members.filter((member) => member.userId !== userId)
      : state.members.map((member) => (member.userId === userId ? { ...member, connected: false } : member));

  return reconcile({ ...state, members });
}

/** Reasons the host can't start yet, in the order worth fixing them. */
export function startBlockers(state: RoomState): string[] {
  if (state.phase !== 'lobby') return ['The game has already started'];

  const blockers: string[] = [];
  if (!state.packId) blockers.push('Pick a photo pack');

  for (const team of TEAM_IDS) {
    const present = teamMembers(state, team).filter((member) => member.connected);
    if (present.length === 0) blockers.push(`${TEAM_NAMES[team]} needs at least one player`);
    else if (!state.leaders[team]) blockers.push(`${TEAM_NAMES[team]} needs a leader`);
  }

  const notReady = state.members.filter((member) => member.team && member.connected && !member.ready);
  if (notReady.length > 0) {
    blockers.push(
      notReady.length === 1
        ? `${notReady[0]?.name ?? 'A player'} is not ready`
        : `${notReady.length} players are not ready`,
    );
  }

  return blockers;
}

export function apply(
  state: RoomState,
  actorId: string,
  message: ClientMessage,
  deps: Deps = {},
): Outcome {
  const actor = find(state, actorId);
  if (!actor) return reject('not_in_room', 'You are not in this room');

  const lobbyOnly = (): Rejection | null =>
    state.phase === 'lobby' ? null : { code: 'not_in_lobby', message: 'The game has already started' };

  switch (message.type) {
    case 'ping':
      return accept(state);

    case 'askQuestion':
    case 'answerQuestion':
    case 'flipTile':
    case 'resetFlips':
    case 'submitGuess':
    case 'rematch':
      return applyGame(state, actorId, message);

    case 'setTeam': {
      const blocked = lobbyOnly();
      if (blocked) return { ok: false, error: blocked };
      if (message.team !== null && !isTeamId(message.team)) return reject('bad_team', 'Unknown team');
      if (actor.team === message.team) return accept(state);

      // Changing side invalidates readiness — you're agreeing to a different setup now.
      const members = state.members.map((member) =>
        member.userId === actorId ? { ...member, team: message.team, ready: false } : member,
      );

      let next = reconcile({ ...state, members });

      // An unled team you just joined has no reason to stay leaderless.
      if (message.team && !next.leaders[message.team]) {
        next = { ...next, leaders: { ...next.leaders, [message.team]: actorId } };
      }
      return accept(next);
    }

    case 'claimLeader': {
      const blocked = lobbyOnly();
      if (blocked) return { ok: false, error: blocked };
      if (!actor.team) return reject('no_team', 'Join a team before leading it');

      const current = state.leaders[actor.team];
      if (current === actorId) return accept(state);
      if (current) {
        const holder = find(state, current);
        // Only a vacancy can be claimed; taking it from an active leader needs a handover.
        if (holder?.connected) return reject('leader_taken', `${holder.name} is already leading`);
      }
      return accept({ ...state, leaders: { ...state.leaders, [actor.team]: actorId } });
    }

    case 'assignLeader': {
      const blocked = lobbyOnly();
      if (blocked) return { ok: false, error: blocked };

      const target = find(state, message.userId);
      if (!target) return reject('no_such_member', 'That player is not in the room');
      if (!target.team) return reject('target_no_team', 'That player is not on a team');
      if (!target.connected) return reject('target_offline', `${target.name} is not connected`);

      const isLeaderOfThatTeam = state.leaders[target.team] === actorId;
      if (!isLeaderOfThatTeam && state.hostId !== actorId) {
        return reject('not_allowed', 'Only the host or the current leader can hand over');
      }
      return accept({ ...state, leaders: { ...state.leaders, [target.team]: target.userId } });
    }

    case 'setReady': {
      const blocked = lobbyOnly();
      if (blocked) return { ok: false, error: blocked };
      if (!actor.team) return reject('no_team', 'Join a team before readying up');

      const members = state.members.map((member) =>
        member.userId === actorId ? { ...member, ready: message.ready } : member,
      );
      return accept({ ...state, members });
    }

    case 'selectPack': {
      const blocked = lobbyOnly();
      if (blocked) return { ok: false, error: blocked };
      if (state.hostId !== actorId) return reject('not_host', 'Only the host can choose the pack');
      if (message.packId === CUSTOM_PACK_ID && !state.customPack) {
        return reject('no_custom_pack', 'Upload some photos first');
      }
      if (state.packId === message.packId) return accept(state);

      // A different board is a different game; make everyone confirm again.
      const members = state.members.map((member) => ({ ...member, ready: false }));
      return accept({ ...state, packId: message.packId, members });
    }

    case 'startGame': {
      const blocked = lobbyOnly();
      if (blocked) return { ok: false, error: blocked };
      if (state.hostId !== actorId) return reject('not_host', 'Only the host can start');

      const blockers = startBlockers(state);
      if (blockers.length > 0) return reject('not_ready', blockers[0] ?? 'Not ready to start');

      // The board has to be resolved before secrets can be dealt, which is I/O; room.ts fetches
      // the manifest and passes it down rather than making every transition async.
      if (!deps.characters) return reject('pack_unavailable', 'That pack could not be loaded');

      return beginGame(state, deps.characters, deps.pick ?? randomIndex);
    }
  }
}

/**
 * Rejection sampling rather than a plain modulo, so every character is equally likely to be
 * drawn. Cheap insurance against a board where one face quietly comes up more often than the rest.
 */
function randomIndex(upperBound: number): number {
  const ceiling = Math.floor(2 ** 32 / upperBound) * upperBound;
  const buffer = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0] ?? 0;
  } while (value >= ceiling);
  return value % upperBound;
}
