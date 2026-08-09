import { createSession } from './session';

export interface Env {
  ASSETS: Fetcher;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}

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
      switch (path) {
        case '/api/health':
          return json({ ok: true });
        case '/api/token':
          return request.method === 'POST'
            ? handleToken(request, env)
            : json({ error: 'method_not_allowed' }, 405);
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

  return json({
    access_token: accessToken,
    session: await createSession(env.SESSION_SECRET, user.id),
    user: {
      id: user.id,
      username: user.username,
      displayName: user.global_name ?? user.username,
      avatar: user.avatar ?? null,
    },
  });
}
