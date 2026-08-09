import { DiscordSDK, DiscordSDKMock, RPCCloseCodes } from '@discord/embedded-app-sdk';
import { avatarUrl } from './avatar';
import { describeError } from './errors';
import type { EventPayloadData, IDiscordSDK } from '@discord/embedded-app-sdk';

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;

// Re-exported so callers have one obvious place to reach for Discord helpers.
export { avatarUrl };

/**
 * Discord loads the activity with a `frame_id` query param.
 *
 * Keying off that rather than `import.meta.env.PROD` means a *production* build still runs
 * standalone in a plain browser, which is how we iterate on the UI without needing two Discord
 * accounts online.
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

/** Names the step that failed, so a rejected handshake says which one. */
async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${what} failed — ${describeError(error)}`);
  }
}

export interface AppUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
}

export interface Connection {
  sdk: IDiscordSDK;
  user: AppUser;
  /** HMAC session token minted by our Worker. Null if the room can't be joined. */
  session: string | null;
  /** Rooms are keyed by this, so everyone in one voice channel shares a game. */
  instanceId: string;
}

interface TokenResponse {
  access_token: string;
  session: string;
  user: { id: string; username: string; displayName: string; avatar: string | null };
}

type RawParticipant = EventPayloadData<'ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE'>['participants'][number];

function toAppUser(participant: RawParticipant): AppUser {
  return {
    id: participant.id,
    username: participant.username,
    displayName: participant.nickname || participant.global_name || participant.username,
    avatarUrl: avatarUrl(participant.id, participant.avatar),
  };
}

/**
 * Runs the full handshake: SDK ready -> OAuth authorize -> server-side code exchange ->
 * authenticate. Resolves once Discord considers us an authenticated activity.
 */
export async function connect(): Promise<Connection> {
  // Standalone runs entirely against the mock, so it needs no real app — a fresh clone can
  // `npm run dev` and see the UI before touching the developer portal.
  if (!isEmbedded) return connectStandalone();

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
    instanceId: sdk.instanceId,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: avatarUrl(user.id, user.avatar),
    },
  };
}

/**
 * Fake connection for `npm run dev` in an ordinary browser tab, outside Discord.
 *
 * `?user=` and `?instance=` let several tabs act as different people in the same (or different)
 * rooms, which is how the lobby gets exercised without two real Discord accounts. The session
 * comes from /api/dev-session, which only exists when ALLOW_DEV_SESSIONS is set in .dev.vars.
 */
async function connectStandalone(): Promise<Connection> {
  const params = new URLSearchParams(window.location.search);
  const who = params.get('user') ?? 'dev';
  const instanceId = params.get('instance') ?? 'standalone-room';

  const sdk = new DiscordSDKMock(CLIENT_ID || 'standalone-dev', 'mock-guild-id', 'mock-channel-id', null);

  const fake = (id: string, username: string): RawParticipant => ({
    id,
    username,
    discriminator: '0',
    global_name: username,
    avatar: null,
    bot: false,
    flags: 0,
  });

  sdk._updateCommandMocks({
    getInstanceConnectedParticipants: async () => ({
      participants: [fake('100000000000000001', 'you'), fake('100000000000000002', 'teammate')],
    }),
  });

  await sdk.ready();

  // 404 here just means dev sessions are switched off; the UI still renders, minus the room.
  let session: string | null = null;
  try {
    const response = await fetch(apiPath(`/api/dev-session?name=${encodeURIComponent(who)}`));
    if (response.ok) session = ((await response.json()) as { session: string }).session;
  } catch {
    // No Worker running — standalone still shows the board.
  }

  return {
    sdk,
    session,
    instanceId,
    user: {
      id: `dev-${who}`,
      username: who,
      displayName: `${who} (standalone)`,
      avatarUrl: avatarUrl('100000000000000001', null),
    },
  };
}

/**
 * Closes the activity from inside it.
 *
 * Discord tears the iframe down, which drops the room socket and takes the player out of the
 * game. Outside Discord the mock accepts the call and nothing visible happens, so the caller
 * shows its own "you left" screen either way rather than depending on the frame going away.
 */
export function leaveActivity(sdk: IDiscordSDK): void {
  try {
    sdk.close(RPCCloseCodes.CLOSE_NORMAL, 'Left the game');
  } catch {
    // Standalone, or a Discord client that refused; the caller has already left the room.
  }
}

export async function getParticipants(sdk: IDiscordSDK): Promise<AppUser[]> {
  const { participants } = await sdk.commands.getInstanceConnectedParticipants();
  return participants.map(toAppUser);
}

/**
 * Discord tracks who is in the activity for us, so there is no presence system to build.
 * Returns an unsubscribe function.
 */
export function onParticipantsChange(sdk: IDiscordSDK, callback: (users: AppUser[]) => void): () => void {
  const listener = (event: EventPayloadData<'ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE'>) => {
    callback(event.participants.map(toAppUser));
  };
  void sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', listener);
  return () => {
    void sdk.unsubscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', listener);
  };
}
