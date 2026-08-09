import type { GameRoom } from './room';

export interface Env {
  ASSETS: Fetcher;
  GAME_ROOM: DurableObjectNamespace<GameRoom>;

  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  SESSION_SECRET: string;

  /**
   * Set to "true" in .dev.vars to expose /api/dev-session, which mints a session for a made-up
   * user so the lobby can be driven without Discord. .dev.vars is local-only and never deployed,
   * and the var is absent from wrangler.jsonc, so production cannot turn this on.
   */
  ALLOW_DEV_SESSIONS?: string;
}
