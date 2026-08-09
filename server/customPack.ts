/**
 * Upload and serving of a host-supplied photo board, as pure-ish helpers over DO storage.
 *
 * Built-in packs ship on the asset layer, which is free and unmetered but read-only. Photos a
 * host picks at the table have nowhere to go, so they live in the room's own storage: one key
 * per image, deleted when the room is cleaned up. That also means they are gone within hours of
 * the game ending, which is the behaviour you want for pictures of people's friends.
 *
 * Upload is three steps — begin, add each photo, commit — so a half-finished upload can never
 * become the board. Only the committed manifest is visible in room state.
 */

import {
  CUSTOM_PACK_MAX,
  CUSTOM_PACK_MIN,
  CUSTOM_PHOTO_MAX_BYTES,
  type CustomPack,
} from './protocol';

/** Storage key holding the in-flight upload, if any. */
export const DRAFT_KEY = 'packdraft';

const imageKey = (token: string, file: string): string => `packimg:${token}:${file}`;

export interface PackDraft {
  token: string;
  ownerId: string;
  name: string;
  /** Files stored so far, so commit can prove every character has both of its images. */
  stored: string[];
  startedAt: number;
}

/** An upload nobody finished should not hold storage forever. */
const DRAFT_TTL_MS = 30 * 60 * 1000;

export function newDraft(ownerId: string, name: string): PackDraft {
  return { token: randomToken(), ownerId, name, stored: [], startedAt: Date.now() };
}

/**
 * 128 bits of URL-safe randomness. The photos are served unauthenticated by this token, so it
 * has to be unguessable rather than merely unique.
 */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isValidToken(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

/** Character ids and the two file names built from them; see shared/naming.ts for the slug rules. */
export function tileFile(characterId: string): string {
  return `${characterId}.webp`;
}

export function fullFile(characterId: string): string {
  return `${characterId}@full.webp`;
}

export function isValidFile(file: string): boolean {
  return /^[a-z0-9-]{1,64}(@full)?\.webp$/.test(file);
}

export type DraftResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): DraftResult<never> => ({ ok: false, status, error });

export function checkPhoto(draft: PackDraft, actorId: string, file: string, size: number): DraftResult<string> {
  if (draft.ownerId !== actorId) return fail(403, 'not_your_upload');
  if (!isValidFile(file)) return fail(400, 'bad_file_name');
  if (size === 0) return fail(400, 'empty_photo');
  if (size > CUSTOM_PHOTO_MAX_BYTES) return fail(413, 'photo_too_large');
  // Two files per character, plus slack, so a client cannot spend the room's storage.
  if (draft.stored.length >= CUSTOM_PACK_MAX * 2) return fail(409, 'too_many_photos');
  return { ok: true, value: file };
}

/**
 * Turns a finished draft into the manifest the room will publish, rejecting anything whose
 * photos did not all arrive — a board with a missing face is worse than a failed upload.
 */
export function commitDraft(
  draft: PackDraft,
  actorId: string,
  characters: { id: string; name: string }[],
): DraftResult<CustomPack> {
  if (draft.ownerId !== actorId) return fail(403, 'not_your_upload');
  if (characters.length < CUSTOM_PACK_MIN || characters.length > CUSTOM_PACK_MAX) {
    return fail(400, 'bad_photo_count');
  }

  const seen = new Set<string>();
  for (const character of characters) {
    if (!/^[a-z0-9-]{1,64}$/.test(character.id)) return fail(400, 'bad_character_id');
    if (seen.has(character.id)) return fail(400, 'duplicate_character');
    seen.add(character.id);

    for (const file of [tileFile(character.id), fullFile(character.id)]) {
      if (!draft.stored.includes(file)) return fail(400, 'missing_photo');
    }
  }

  return {
    ok: true,
    value: {
      token: draft.token,
      name: draft.name.trim().slice(0, 40) || 'Custom',
      characters: characters.map((character) => ({
        id: character.id,
        name: character.name.trim().slice(0, 40) || character.id,
      })),
    },
  };
}

export function draftHasExpired(draft: PackDraft, now = Date.now()): boolean {
  return now - draft.startedAt > DRAFT_TTL_MS;
}

/** Storage helpers, kept here so the key format lives in one file. */
export const packStorage = {
  imageKey,
  /** Every key belonging to a pack, for deleting one wholesale when it is replaced. */
  prefixFor: (token: string): string => `packimg:${token}:`,
};
