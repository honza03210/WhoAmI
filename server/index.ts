import type { Env } from './env';
import { CUSTOM_PHOTO_MAX_BYTES } from './protocol';
import { createSession, verifySession } from './session';

export { GameRoom } from './room';
export type { Env };

const DISCORD_API = 'https://discord.com/api/v10';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Discord serves the activity from https://<client_id>.discordsays.com. With a root URL
    // mapping ("/" -> this Worker) same-origin paths arrive unchanged, which is what the client
    // sends. Some proxy configurations keep a "/.proxy" prefix, so strip it if present rather
    // than depending on which behaviour we get.
    const path = url.pathname.startsWith('/.proxy/') ? url.pathname.slice('/.proxy'.length) : url.pathname;

    if (path.startsWith('/api/')) {
      // Custom pack traffic carries photo bytes rather than JSON, and is addressed by room, so
      // it is forwarded to the Durable Object instead of being handled here.
      if (path.startsWith('/api/pack/')) return handlePack(request, url, path, env);

      switch (path) {
        case '/api/health':
          return json({ ok: true });
        case '/api/token':
          return request.method === 'POST'
            ? handleToken(request, env)
            : json({ error: 'method_not_allowed' }, 405);
        case '/api/dev-session':
          return handleDevSession(url, env);
        case '/api/ws':
          return handleWebSocket(request, url, env);
        default:
          return json({ error: 'not_found' }, 404);
      }
    }

    // Static assets. If we stripped a prefix above, ask for the rewritten path.
    if (path !== url.pathname) {
      const rewritten = new URL(url);
      rewritten.pathname = path;
      return env.ASSETS.fetch(new Request(rewritten, request));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

/**
 * Exchanges the OAuth2 code the activity obtained via `authorize()` for an access token.
 *
 * This has to happen server-side: the exchange needs the client secret, which must never be
 * shipped in the client bundle.
 */
async function handleToken(request: Request, env: Env): Promise<Response> {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.SESSION_SECRET) {
    console.error('Missing DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, or SESSION_SECRET');
    return json({ error: 'server_misconfigured' }, 500);
  }

  let code: string;
  try {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body.code !== 'string' || body.code === '') return json({ error: 'missing_code' }, 400);
    code = body.code;
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  });

  if (!tokenResponse.ok) {
    // Body is logged, not returned — it can echo parts of the request.
    console.error('oauth2/token failed', tokenResponse.status, await tokenResponse.text());
    return json({ error: 'token_exchange_failed' }, 502);
  }

  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };

  // Resolve the user from Discord instead of trusting anything the iframe claimed. Everything
  // downstream (team membership, leader authority) keys off this id.
  const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!userResponse.ok) {
    console.error('users/@me failed', userResponse.status);
    return json({ error: 'user_lookup_failed' }, 502);
  }
  const user = (await userResponse.json()) as DiscordUser;
  const displayName = user.global_name ?? user.username;

  return json({
    access_token: accessToken,
    session: await createSession(env.SESSION_SECRET, {
      uid: user.id,
      name: displayName,
      avatar: user.avatar ?? null,
    }),
    user: { id: user.id, username: user.username, displayName, avatar: user.avatar ?? null },
  });
}

/**
 * Mints a session for a fabricated user, so the lobby can be exercised — by hand or by the e2e
 * suite — without two real Discord accounts.
 *
 * Only reachable when ALLOW_DEV_SESSIONS is set, which lives in .dev.vars and is therefore never
 * deployed. Absent that, the route 404s exactly like any other unknown path.
 */
async function handleDevSession(url: URL, env: Env): Promise<Response> {
  if (env.ALLOW_DEV_SESSIONS !== 'true') return json({ error: 'not_found' }, 404);
  if (!env.SESSION_SECRET) return json({ error: 'server_misconfigured' }, 500);

  const name = (url.searchParams.get('name') ?? 'dev').slice(0, 32);
  // Deterministic per name, so reconnecting as "alice" is the same player each time.
  const uid = `dev-${name}`;

  return json({
    session: await createSession(env.SESSION_SECRET, { uid, name, avatar: null }),
    user: { id: uid, username: name, displayName: name, avatar: null },
  });
}

/**
 * Routes custom pack requests to the room that owns them.
 *
 *   POST /api/pack/<instance>/begin              start an upload   (host, session required)
 *   POST /api/pack/<instance>/<token>/add        one photo         (uploader, session required)
 *   POST /api/pack/<instance>/<token>/commit     publish the board (uploader, session required)
 *   GET  /api/pack/<instance>/<token>/<file>     a photo           (token is the credential)
 *
 * Reads are deliberately unauthenticated: they are `<img src>` targets inside the activity, and
 * a session in a URL ends up in history and referrers. The random token is what protects them.
 */
async function handlePack(request: Request, url: URL, path: string, env: Env): Promise<Response> {
  const segments = path.split('/').slice(3).filter(Boolean); // after "/api/pack/"
  const instanceId = segments[0] ?? '';
  if (!isInstanceId(instanceId)) return json({ error: 'bad_instance' }, 400);

  const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(instanceId));
  const forwarded = new URL(url);
  forwarded.pathname = `/pack/${segments.slice(1).join('/')}`;

  // A GET is a plain photo fetch and needs no identity; everything else mutates the room.
  if (request.method === 'GET') {
    return room.fetch(new Request(forwarded, request));
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!env.SESSION_SECRET) return json({ error: 'server_misconfigured' }, 500);

  const claims = await verifySession(env.SESSION_SECRET, url.searchParams.get('session') ?? '');
  if (!claims) return json({ error: 'bad_session' }, 401);

  const headers = new Headers(request.headers);
  headers.set('x-guessfi-user-id', claims.uid);
  headers.set('x-guessfi-user-name', encodeURIComponent(claims.name));

  // Read the body here rather than piping the stream on. The room rejects some uploads without
  // ever reading them — wrong user, bad file name — and an unread client stream throws once the
  // response goes out. Bodies are one small photo at most, so buffering costs nothing.
  if (Number(request.headers.get('content-length') ?? 0) > MAX_UPLOAD_BODY_BYTES) {
    return json({ error: 'photo_too_large' }, 413);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_UPLOAD_BODY_BYTES) return json({ error: 'photo_too_large' }, 413);

  return room.fetch(new Request(forwarded, { method: 'POST', headers, body }));
}

/** One photo plus headroom for the commit manifest. Anything larger is not a legitimate upload. */
const MAX_UPLOAD_BODY_BYTES = 2 * CUSTOM_PHOTO_MAX_BYTES;

/** Discord instance ids are opaque; bound the length and charset rather than trusting them. */
function isInstanceId(value: string): boolean {
  return /^[\w.:-]{1,128}$/.test(value);
}

/**
 * Upgrades to the room's WebSocket.
 *
 * The identity comes from the signed session token, never from the query string, and is handed
 * to the Durable Object in headers it can trust because the namespace is not publicly routable.
 */
async function handleWebSocket(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'expected_websocket' }, 426);
  }
  if (!env.SESSION_SECRET) return json({ error: 'server_misconfigured' }, 500);

  const instanceId = url.searchParams.get('instance') ?? '';
  if (!isInstanceId(instanceId)) return json({ error: 'bad_instance' }, 400);

  const claims = await verifySession(env.SESSION_SECRET, url.searchParams.get('session') ?? '');
  if (!claims) return json({ error: 'bad_session' }, 401);

  const headers = new Headers(request.headers);
  headers.set('x-guessfi-user-id', claims.uid);
  // Headers are latin-1; display names are not.
  headers.set('x-guessfi-user-name', encodeURIComponent(claims.name));
  headers.set('x-guessfi-user-avatar', claims.avatar ?? '');

  const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(instanceId));
  return room.fetch(new Request(url, { ...request, headers }));
}
