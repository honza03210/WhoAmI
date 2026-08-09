/**
 * Getting into a room from a browser.
 *
 * Discord hands the activity an instance id and an identity. A browser has neither, so this
 * module works out which room the URL is pointing at, and gets the visitor a guest session for
 * it — creating one if they have never been here, reusing one if they have.
 */

import { apiPath } from './discord';

/** `/r/KP7X2M` is the shareable form; the code is the only thing in the path. */
const ROOM_PATH = /^\/r\/([A-Za-z0-9]{6})\/?$/;

const NAME_KEY = 'guessfi:name';
const sessionKey = (roomKey: string) => `guessfi:session:${roomKey}`;

/**
 * Sessions last six hours server-side. Treating them as stale an hour early means a returning
 * player gets a fresh one rather than a socket that opens and immediately closes.
 */
const SESSION_STALE_MS = 5 * 60 * 60 * 1000;

export interface GuestUser {
  id: string;
  displayName: string;
}

export interface StoredSession {
  token: string;
  user: GuestUser;
  createdAt: number;
}

export class JoinError extends Error {}

/** The room this URL is asking for, or null when the visitor has just landed on the site. */
export function roomCodeFromUrl(pathname = window.location.pathname): string | null {
  const match = ROOM_PATH.exec(pathname);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function roomKeyForCode(code: string): string {
  return `c:${code.toUpperCase()}`;
}

export function roomUrlFor(code: string): string {
  return `${window.location.origin}/r/${code.toUpperCase()}`;
}

/** Remembered so a returning player is not asked their name for every room. */
export function rememberedName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    // Private browsing with storage denied — the name field simply starts empty.
    return '';
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience here, never a requirement; a refresh just costs a new identity.
  }
}

function storedSession(roomKey: string): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(sessionKey(roomKey));
    if (!raw) return null;

    const stored = JSON.parse(raw) as StoredSession;
    if (typeof stored?.token !== 'string' || typeof stored?.createdAt !== 'number') return null;
    if (Date.now() - stored.createdAt > SESSION_STALE_MS) return null;
    return stored;
  } catch {
    return null;
  }
}

/**
 * A session for this room, reused if there is a usable one.
 *
 * Reuse is what makes a refresh mid-game survivable: the room holds a disconnected player's team
 * and leader role against their id, so coming back with a new identity would leave them watching
 * their own seat from the outside.
 */
export async function sessionForRoom(roomKey: string, name: string): Promise<StoredSession> {
  const existing = storedSession(roomKey);
  // Only if it is the same person. Storage is per-origin, so a second tab — or a second player
  // on a shared laptop — would otherwise inherit the first one's seat and the room would see a
  // single player twice over. A different name is a different player.
  if (existing && existing.user.displayName === name) return existing;

  const response = await fetch(apiPath('/api/guest'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new JoinError(
      response.status === 400 ? 'Pick a name with at least one letter in it.' : 'Could not join. Try again.',
    );
  }

  const { session, user } = (await response.json()) as {
    session: string;
    user: { id: string; displayName: string };
  };

  const stored: StoredSession = {
    token: session,
    user: { id: user.id, displayName: user.displayName },
    createdAt: Date.now(),
  };
  remember(NAME_KEY, user.displayName);
  remember(sessionKey(roomKey), JSON.stringify(stored));
  return stored;
}

/** Opens a new room and returns its code. The caller navigates to it. */
export async function createRoom(session: string): Promise<string> {
  const response = await fetch(apiPath(`/api/rooms?session=${encodeURIComponent(session)}`), { method: 'POST' });
  if (!response.ok) throw new JoinError('Could not open a room. Try again in a moment.');

  const { code } = (await response.json()) as { code: string };
  return code;
}
