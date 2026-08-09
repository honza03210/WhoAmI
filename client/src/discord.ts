import { DiscordSDK, RPCCloseCodes } from '@discord/embedded-app-sdk';
import { avatarUrl } from './avatar';
import type { IDiscordSDK } from '@discord/embedded-app-sdk';
import { describeError } from './errors';

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;

// Re-exported so callers have one obvious place to reach for Discord helpers.
export { avatarUrl };

/**
 * Discord loads the activity with a `frame_id` query param.
 *
 * Keying off that rather than `import.meta.env.PROD` means a *production* build still runs in a
 * plain browser, which is now a supported way to play rather than only a way to iterate.
 */
export const isEmbedded = new URLSearchParams(window.location.search).has('frame_id');

/**
 * Builds a path for a request back to our own Worker.
 *
 * With a root URL mapping ("/" -> the Worker) Discord serves us from
 * https://<client_id>.discordsays.com and same-origin paths pass through untouched, so there is
 * nothing to rewrite today. Everything funnels through here anyway so that adding an external
 * URL mapping later is a one-line change instead of a hunt through the codebase.
 */
export const apiPath = (path: string): string => path;

export function apiSocketUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${apiPath(path)}`;
}

export interface AppUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
}

/**
 * A player, in a room, with proof of who they are.
 *
 * Both doors produce one of these. `sdk` is null in a plain browser — there is no activity to
 * talk to — so anything Discord-only must check it rather than assume.
 */
export interface Connection {
  sdk: IDiscordSDK | null;
  user: AppUser;
  /** HMAC session token minted by our Worker. */
  session: string;
  /** `d:<instanceId>` or `c:<CODE>`; see server/rooms.ts. */
  roomKey: string;
  /** The shareable code, when the room has one. Discord rooms do not. */
  code: string | null;
}

interface TokenResponse {
  access_token: string;
  session: string;
  user: { id: string; username: string; displayName: string; avatar: string | null };
}

/** Names the step that failed, so a rejected handshake says which one. */
async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${what} failed — ${describeError(error)}`);
  }
}

/**
 * Runs the full Discord handshake: SDK ready -> OAuth authorize -> server-side code exchange ->
 * authenticate. Resolves once Discord considers us an authenticated activity.
 */
export async function connectDiscord(): Promise<Connection> {
  if (!CLIENT_ID) {
    throw new Error('VITE_DISCORD_CLIENT_ID is not set. Copy .env.example to .env and fill it in.');
  }

  const sdk = new DiscordSDK(CLIENT_ID);
  await step('Connecting to Discord', () => sdk.ready());

  // The usual first-run failure: a new application has no OAuth2 redirect and no URL mapping,
  // and the portal refuses to issue a code until both exist.
  const { code } = await step('Authorizing', () =>
    sdk.commands.authorize({
      client_id: CLIENT_ID,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify', 'guilds'],
    }),
  );

  const response = await fetch(apiPath('/api/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}). Is the Worker running?`);
  }
  const { access_token: accessToken, session, user } = (await response.json()) as TokenResponse;

  await step('Authenticating', () => sdk.commands.authenticate({ access_token: accessToken }));

  return {
    sdk,
    session,
    roomKey: `d:${sdk.instanceId}`,
    code: null,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: avatarUrl(user.id, user.avatar, 'discord'),
    },
  };
}

/**
 * Closes the activity from inside it.
 *
 * Discord tears the iframe down, which drops the room socket. In a plain browser there is no
 * frame to close, so this does nothing and the caller shows its own exit screen either way.
 */
export function leaveActivity(sdk: IDiscordSDK | null): void {
  if (!sdk) return;
  try {
    sdk.close(RPCCloseCodes.CLOSE_NORMAL, 'Left the game');
  } catch {
    // A Discord client that refused; the caller has already left the room.
  }
}
