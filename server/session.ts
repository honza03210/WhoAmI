/**
 * Short-lived HMAC-signed session tokens.
 *
 * The client can't be trusted to say who it is, so `/api/token` resolves the real user from
 * Discord and mints one of these. From then on the token is the client's proof of identity —
 * notably when opening the game WebSocket, where there are no cookies to lean on.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

/**
 * How a player proved who they are.
 *
 * A Discord player was resolved through OAuth and their id is a real snowflake. A guest typed a
 * name into a browser and was handed a random id by the Worker — the name is theirs to choose,
 * the identity is not.
 */
export type IdentityKind = 'discord' | 'guest';

export interface SessionProfile {
  /** Discord snowflake, or a server-issued guest id. Never supplied by the client. */
  uid: string;
  /** Display name, carried in the token so the room never has to trust the client for it. */
  name: string;
  /** Discord avatar hash. Always null for guests, whose avatar is drawn from their id. */
  avatar: string | null;
  kind: IdentityKind;
}

export interface SessionClaims extends SessionProfile {
  /** Unix seconds. */
  exp: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Backed by a plain ArrayBuffer rather than the wider ArrayBufferLike: Workers and Node disagree
// about whether a possibly-shared buffer is acceptable to crypto.subtle, and this satisfies both.
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function createSession(
  secret: string,
  profile: SessionProfile,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const claims: SessionClaims = { ...profile, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Returns the claims, or null if the token is malformed, forged, or expired. */
export async function verifySession(secret: string, token: string): Promise<SessionClaims | null> {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  let valid: boolean;
  try {
    // crypto.subtle.verify compares in constant time, so no manual string equality here.
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(signature),
      encoder.encode(payload),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  try {
    const claims = JSON.parse(decoder.decode(fromBase64Url(payload))) as SessionClaims;
    if (typeof claims.uid !== 'string' || typeof claims.exp !== 'number') return null;
    if (typeof claims.name !== 'string') return null;
    if (claims.avatar !== null && typeof claims.avatar !== 'string') return null;
    if (claims.kind !== 'discord' && claims.kind !== 'guest') return null;
    if (claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}
