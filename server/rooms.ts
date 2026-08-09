/**
 * Addressing a room.
 *
 * A room used to be a Discord activity instance and nothing else. Now there are two ways to
 * arrive — the activity, or a link with a code in it — and both resolve to a single **room key**
 * that everything downstream takes. Nothing past this module knows which door was used.
 *
 *   Discord activity   instanceId  ->  d:<instanceId>
 *   Browser link       KP7X2M      ->  c:KP7X2M
 */

/**
 * Six characters, no `O 0 I 1 L`: codes get read aloud and typed by hand, and the pairs people
 * confuse are worth more than the ~10% of keyspace they cost. 31^6 is about 8.9e8.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export type RoomKey = string;

export interface ParsedRoomKey {
  kind: 'discord' | 'code';
  /** The instance id or the code, without the prefix. */
  value: string;
}

/** Discord instance ids are opaque; bound the length and charset rather than trusting them. */
const INSTANCE_PATTERN = /^[\w.:-]{1,128}$/;
const CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function roomKeyForInstance(instanceId: string): RoomKey {
  return `d:${instanceId}`;
}

export function roomKeyForCode(code: string): RoomKey {
  return `c:${code.toUpperCase()}`;
}

/**
 * Parses an untrusted room key. Returns null for anything unrecognised rather than throwing, so
 * a malformed URL is a 400 and never a stack trace.
 */
export function parseRoomKey(value: string): ParsedRoomKey | null {
  const rest = value.slice(2);
  if (value.startsWith('d:') && INSTANCE_PATTERN.test(rest)) return { kind: 'discord', value: rest };
  if (value.startsWith('c:') && CODE_PATTERN.test(rest)) return { kind: 'code', value: rest };
  return null;
}

export function isRoomCode(value: string): boolean {
  return CODE_PATTERN.test(value.toUpperCase());
}

/**
 * A fresh code, drawn without modulo bias so no code is quietly more likely than another —
 * the same rejection sampling the character deal uses.
 */
export function generateRoomCode(): string {
  const alphabet = ROOM_CODE_ALPHABET;
  const ceiling = Math.floor(256 / alphabet.length) * alphabet.length;
  const out: string[] = [];

  while (out.length < ROOM_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
    for (const byte of bytes) {
      if (byte >= ceiling) continue;
      out.push(alphabet[byte % alphabet.length] as string);
      if (out.length === ROOM_CODE_LENGTH) break;
    }
  }
  return out.join('');
}

/**
 * A guest id. Random rather than derived from the name, so two people called Sam are two people,
 * and so nobody can claim to be someone else by typing their name.
 */
export function generateGuestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `g${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export const MAX_NAME_LENGTH = 24;

/**
 * A display name is the one thing a guest chooses, so it is bounded and stripped of anything
 * that would let it impersonate the interface — control characters, and the runs of whitespace
 * that let a name pretend to be several.
 */
export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  // Whitespace first, so a newline separates two words instead of welding them together, and
  // only then the characters that carry no width and exist to deceive.
  const cleaned = [...value.normalize('NFC').replace(/\s+/g, ' ')]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      // C0 and C1 control ranges, plus the bidi overrides that can reverse rendered text.
      return !(code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e));
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);

  return cleaned.length > 0 ? cleaned : null;
}
