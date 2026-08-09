import { describe, expect, it } from 'vitest';
import { createSession, verifySession } from '../server/session';

const SECRET = 'test-secret';
const OTHER_SECRET = 'a-different-secret';
const USER_ID = '123456789012345678';
const PROFILE = { uid: USER_ID, name: 'Ada', avatar: null };

describe('createSession / verifySession', () => {
  it('round-trips the user id', async () => {
    const token = await createSession(SECRET, PROFILE);
    await expect(verifySession(SECRET, token)).resolves.toMatchObject({ uid: USER_ID });
  });

  it('produces a url-safe token', async () => {
    // The token travels as a WebSocket query parameter, so base64 padding and +/ would break it.
    const token = await createSession(SECRET, PROFILE);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('survives user ids and lengths that stress base64 padding', async () => {
    for (const uid of ['a', 'ab', 'abc', 'abcd', 'abcde', '0', '99999999999999999999']) {
      const token = await createSession(SECRET, { uid, name: 'x', avatar: null });
      await expect(verifySession(SECRET, token)).resolves.toMatchObject({ uid });
    }
  });

  it('round-trips non-ascii payloads', async () => {
    const token = await createSession(SECRET, { uid: 'é中文-🎲', name: 'é中文-🎲', avatar: null });
    await expect(verifySession(SECRET, token)).resolves.toMatchObject({ uid: 'é中文-🎲' });
  });

  it('sets an expiry in the future', async () => {
    const token = await createSession(SECRET, PROFILE, 60);
    const claims = await verifySession(SECRET, token);
    expect(claims?.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims?.exp).toBeLessThanOrEqual(Date.now() / 1000 + 60);
  });
});

describe('verifySession rejects', () => {
  it('a token signed with a different secret', async () => {
    const token = await createSession(SECRET, PROFILE);
    await expect(verifySession(OTHER_SECRET, token)).resolves.toBeNull();
  });

  it('a tampered payload', async () => {
    // The whole point: a client must not be able to rewrite its own user id.
    const token = await createSession(SECRET, PROFILE);
    const [, signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ uid: 'someone-else', name: 'x', avatar: null, exp: 2_000_000_000 }))
      .toString('base64url');
    await expect(verifySession(SECRET, `${forgedPayload}.${signature}`)).resolves.toBeNull();
  });

  it('a tampered signature', async () => {
    const token = await createSession(SECRET, PROFILE);
    await expect(verifySession(SECRET, `${token.slice(0, -2)}AA`)).resolves.toBeNull();
  });

  it('an expired token', async () => {
    const token = await createSession(SECRET, PROFILE, -10);
    await expect(verifySession(SECRET, token)).resolves.toBeNull();
  });

  it('malformed input without throwing', async () => {
    for (const bad of ['', '.', 'nonsense', 'a.b.c', 'onlyonepart', '.sig', 'payload.', '!!!.???']) {
      await expect(verifySession(SECRET, bad)).resolves.toBeNull();
    }
  });

  it('a validly signed token whose payload is not session claims', async () => {
    // Signed with the right key, but the shape is wrong — must not be trusted.
    const payload = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64url');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
    ).toString('base64url');
    await expect(verifySession(SECRET, `${payload}.${signature}`)).resolves.toBeNull();
  });
});
