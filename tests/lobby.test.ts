import { describe, expect, it } from 'vitest';
import { apply, initialRoom, memberJoined, memberLeft, startBlockers } from '../server/lobby';
import { viewFor } from '../server/redact';
import type { RoomState } from '../server/protocol';

const profile = (userId: string, name = userId) => ({ userId, name, avatar: null });

/** `startGame` needs a board; the identity of the faces is irrelevant to lobby rules. */
const BOARD = ['ada', 'bob', 'cy', 'dee'];
const DEPS = { characters: BOARD, pick: () => 0 };

function join(state: RoomState, ...ids: string[]): RoomState {
  return ids.reduce((current, id) => memberJoined(current, profile(id)), state);
}

/** Applies a command and fails the test if it was rejected. */
function must(state: RoomState, actor: string, message: Parameters<typeof apply>[2]): RoomState {
  const outcome = apply(state, actor, message, DEPS);
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.state;
}

function rejection(state: RoomState, actor: string, message: Parameters<typeof apply>[2]) {
  const outcome = apply(state, actor, message, DEPS);
  if (outcome.ok) throw new Error('expected a rejection, got success');
  return outcome.error;
}

/** A room one `startGame` away from running. */
function readyRoom(): RoomState {
  let state = join(initialRoom(), 'host', 'p2');
  state = must(state, 'host', { type: 'setTeam', team: 'a' });
  state = must(state, 'p2', { type: 'setTeam', team: 'b' });
  state = must(state, 'host', { type: 'selectPack', packId: 'demo' });
  state = must(state, 'host', { type: 'setReady', ready: true });
  state = must(state, 'p2', { type: 'setReady', ready: true });
  return state;
}

describe('joining and leaving', () => {
  it('makes the first arrival the host', () => {
    expect(join(initialRoom(), 'a').hostId).toBe('a');
  });

  it('does not move the host when others arrive', () => {
    expect(join(initialRoom(), 'a', 'b', 'c').hostId).toBe('a');
  });

  it('passes the host on when the host leaves', () => {
    const state = memberLeft(join(initialRoom(), 'a', 'b'), 'a');
    expect(state.hostId).toBe('b');
  });

  it('leaves no host in an empty room', () => {
    const state = memberLeft(memberLeft(join(initialRoom(), 'a', 'b'), 'a'), 'b');
    expect(state.hostId).toBeNull();
    expect(state.members).toHaveLength(0);
  });

  it('drops leavers while in the lobby', () => {
    expect(memberLeft(join(initialRoom(), 'a', 'b'), 'b').members.map((m) => m.userId)).toEqual(['a']);
  });

  it('keeps leavers once the game is running so they can reconnect', () => {
    let state = readyRoom();
    state = must(state, 'host', { type: 'startGame' });
    state = memberLeft(state, 'p2');

    const member = state.members.find((m) => m.userId === 'p2');
    expect(member).toBeDefined();
    expect(member?.connected).toBe(false);
    // Their team survives, so reconnecting restores their side.
    expect(member?.team).toBe('b');
  });

  it('restores a returning member without duplicating them', () => {
    let state = readyRoom();
    state = must(state, 'host', { type: 'startGame' });
    state = memberLeft(state, 'p2');
    state = memberJoined(state, profile('p2', 'p2 renamed'));

    expect(state.members.filter((m) => m.userId === 'p2')).toHaveLength(1);
    expect(state.members.find((m) => m.userId === 'p2')?.connected).toBe(true);
    expect(state.members.find((m) => m.userId === 'p2')?.name).toBe('p2 renamed');
  });
});

describe('teams', () => {
  it('makes the first player on a team its leader', () => {
    const state = must(join(initialRoom(), 'a'), 'a', { type: 'setTeam', team: 'a' });
    expect(state.leaders.a).toBe('a');
  });

  it('does not displace an existing leader', () => {
    let state = join(initialRoom(), 'p1', 'p2');
    state = must(state, 'p1', { type: 'setTeam', team: 'a' });
    state = must(state, 'p2', { type: 'setTeam', team: 'a' });
    expect(state.leaders.a).toBe('p1');
  });

  it('hands leadership to a teammate when the leader switches sides', () => {
    let state = join(initialRoom(), 'p1', 'p2');
    state = must(state, 'p1', { type: 'setTeam', team: 'a' });
    state = must(state, 'p2', { type: 'setTeam', team: 'a' });
    state = must(state, 'p1', { type: 'setTeam', team: 'b' });

    expect(state.leaders.a).toBe('p2');
    expect(state.leaders.b).toBe('p1');
  });

  it('leaves a team leaderless when its last member goes', () => {
    let state = join(initialRoom(), 'p1');
    state = must(state, 'p1', { type: 'setTeam', team: 'a' });
    state = must(state, 'p1', { type: 'setTeam', team: null });
    expect(state.leaders.a).toBeNull();
  });

  it('clears readiness on a team change', () => {
    let state = join(initialRoom(), 'p1');
    state = must(state, 'p1', { type: 'setTeam', team: 'a' });
    state = must(state, 'p1', { type: 'setReady', ready: true });
    state = must(state, 'p1', { type: 'setTeam', team: 'b' });
    expect(state.members[0]?.ready).toBe(false);
  });

  it('refuses readiness from someone with no team', () => {
    expect(rejection(join(initialRoom(), 'p1'), 'p1', { type: 'setReady', ready: true }).code).toBe('no_team');
  });

  it('promotes a teammate when the leader disconnects', () => {
    let state = join(initialRoom(), 'p1', 'p2');
    state = must(state, 'p1', { type: 'setTeam', team: 'a' });
    state = must(state, 'p2', { type: 'setTeam', team: 'a' });
    state = memberLeft(state, 'p1');
    expect(state.leaders.a).toBe('p2');
  });
});

describe('leadership', () => {
  it('can be claimed when the post is vacant', () => {
    let state = join(initialRoom(), 'p1', 'p2');
    state = must(state, 'p1', { type: 'setTeam', team: 'a' });
    state = must(state, 'p2', { type: 'setTeam', team: 'a' });
    // p1 leads; vacate by moving away, leaving p2 as leader, then p1 returns and claims.
    state = { ...state, leaders: { ...state.leaders, a: null } };
    state = must(state, 'p2', { type: 'claimLeader' });
    expect(state.leaders.a).toBe('p2');
  });

  it('cannot be seized from a connected leader', () => {
    let state = join(initialRoom(), 'p1', 'p2');
    state = must(state, 'p1', { type: 'setTeam', team: 'a' });
    state = must(state, 'p2', { type: 'setTeam', team: 'a' });
    expect(rejection(state, 'p2', { type: 'claimLeader' }).code).toBe('leader_taken');
  });

  it('cannot be claimed without a team', () => {
    expect(rejection(join(initialRoom(), 'p1'), 'p1', { type: 'claimLeader' }).code).toBe('no_team');
  });

  it('can be handed over by the current leader', () => {
    let state = join(initialRoom(), 'p1', 'p2');
    state = must(state, 'p1', { type: 'setTeam', team: 'a' });
    state = must(state, 'p2', { type: 'setTeam', team: 'a' });
    state = must(state, 'p1', { type: 'assignLeader', userId: 'p2' });
    expect(state.leaders.a).toBe('p2');
  });

  it('can be reassigned by the host', () => {
    let state = join(initialRoom(), 'host', 'p1', 'p2');
    state = must(state, 'p1', { type: 'setTeam', team: 'a' });
    state = must(state, 'p2', { type: 'setTeam', team: 'a' });
    state = must(state, 'host', { type: 'assignLeader', userId: 'p2' });
    expect(state.leaders.a).toBe('p2');
  });

  it('cannot be reassigned by an ordinary teammate', () => {
    let state = join(initialRoom(), 'host', 'p1', 'p2', 'p3');
    state = must(state, 'p1', { type: 'setTeam', team: 'a' });
    state = must(state, 'p2', { type: 'setTeam', team: 'a' });
    state = must(state, 'p3', { type: 'setTeam', team: 'a' });
    expect(rejection(state, 'p3', { type: 'assignLeader', userId: 'p2' }).code).toBe('not_allowed');
  });

  it('cannot be given to someone without a team', () => {
    let state = join(initialRoom(), 'host', 'p2');
    state = must(state, 'host', { type: 'setTeam', team: 'a' });
    expect(rejection(state, 'host', { type: 'assignLeader', userId: 'p2' }).code).toBe('target_no_team');
  });

  it('cannot be given to a stranger', () => {
    const state = join(initialRoom(), 'host');
    expect(rejection(state, 'host', { type: 'assignLeader', userId: 'ghost' }).code).toBe('no_such_member');
  });
});

describe('pack selection', () => {
  it('is host-only', () => {
    const state = join(initialRoom(), 'host', 'p2');
    expect(rejection(state, 'p2', { type: 'selectPack', packId: 'demo' }).code).toBe('not_host');
  });

  it('resets readiness, since a new board is a new game', () => {
    let state = readyRoom();
    expect(state.members.every((m) => m.ready)).toBe(true);
    state = must(state, 'host', { type: 'selectPack', packId: 'other' });
    expect(state.members.every((m) => !m.ready)).toBe(true);
  });

  it('is a no-op when the pack is unchanged', () => {
    const state = readyRoom();
    const after = must(state, 'host', { type: 'selectPack', packId: 'demo' });
    expect(after.members.every((m) => m.ready)).toBe(true);
  });
});

describe('starting', () => {
  it('lists what is missing', () => {
    const state = join(initialRoom(), 'host');
    const blockers = startBlockers(state);
    expect(blockers).toContain('Pick a photo pack');
    expect(blockers.some((b) => b.includes('Red'))).toBe(true);
    expect(blockers.some((b) => b.includes('Blue'))).toBe(true);
  });

  it('names a single unready player', () => {
    let state = join(initialRoom(), 'host', 'p2');
    state = must(state, 'host', { type: 'setTeam', team: 'a' });
    state = must(state, 'p2', { type: 'setTeam', team: 'b' });
    state = must(state, 'host', { type: 'selectPack', packId: 'demo' });
    state = must(state, 'host', { type: 'setReady', ready: true });
    expect(startBlockers(state)).toContain('p2 is not ready');
  });

  it('counts several unready players', () => {
    let state = join(initialRoom(), 'host', 'p2', 'p3');
    state = must(state, 'host', { type: 'setTeam', team: 'a' });
    state = must(state, 'p2', { type: 'setTeam', team: 'b' });
    state = must(state, 'p3', { type: 'setTeam', team: 'b' });
    state = must(state, 'host', { type: 'selectPack', packId: 'demo' });
    state = must(state, 'host', { type: 'setReady', ready: true });
    expect(startBlockers(state)).toContain('2 players are not ready');
  });

  it('ignores spectators when deciding readiness', () => {
    let state = readyRoom();
    state = memberJoined(state, profile('watcher'));
    expect(startBlockers(state)).toEqual([]);
  });

  it('succeeds once nothing is blocking', () => {
    const state = must(readyRoom(), 'host', { type: 'startGame' });
    expect(state.phase).toBe('in_progress');
  });

  it('is host-only', () => {
    expect(rejection(readyRoom(), 'p2', { type: 'startGame' }).code).toBe('not_host');
  });

  it('is refused while anything is blocking', () => {
    let state = join(initialRoom(), 'host');
    state = must(state, 'host', { type: 'setTeam', team: 'a' });
    expect(rejection(state, 'host', { type: 'startGame' }).code).toBe('not_ready');
  });

  it('is refused when the pack could not be read', () => {
    const outcome = apply(readyRoom(), 'host', { type: 'startGame' }, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.ok || outcome.error.code).toBe('pack_unavailable');
  });

  it('refuses lobby commands once running', () => {
    const state = must(readyRoom(), 'host', { type: 'startGame' });
    expect(rejection(state, 'p2', { type: 'setTeam', team: 'a' }).code).toBe('not_in_lobby');
    expect(rejection(state, 'host', { type: 'selectPack', packId: 'x' }).code).toBe('not_in_lobby');
    expect(rejection(state, 'host', { type: 'startGame' }).code).toBe('not_in_lobby');
  });
});

describe('permissions', () => {
  it('rejects commands from someone not in the room', () => {
    expect(rejection(join(initialRoom(), 'p1'), 'stranger', { type: 'claimLeader' }).code).toBe('not_in_room');
  });
});

describe('viewFor', () => {
  it('tells each player their own role', () => {
    const state = readyRoom();

    const host = viewFor(state, 'host');
    expect(host.you).toMatchObject({ userId: 'host', team: 'a', isHost: true, isLeader: true });

    const other = viewFor(state, 'p2');
    expect(other.you).toMatchObject({ userId: 'p2', team: 'b', isHost: false, isLeader: true });
  });

  it('reports a spectator as neither host nor leader', () => {
    const state = memberJoined(readyRoom(), profile('watcher'));
    expect(viewFor(state, 'watcher').you).toMatchObject({ team: null, isHost: false, isLeader: false });
  });

  it('carries the start blockers', () => {
    expect(viewFor(readyRoom(), 'host').startBlockers).toEqual([]);
    expect(viewFor(join(initialRoom(), 'host'), 'host').startBlockers.length).toBeGreaterThan(0);
  });
});
