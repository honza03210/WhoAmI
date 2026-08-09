/**
 * One Durable Object per activity instance — the authoritative game room.
 *
 * Rooms are keyed by Discord's activity instance id, so everyone who opens the activity in the
 * same voice channel lands on the same object. All the rules live in lobby.ts as pure
 * functions; this file owns sockets, persistence and fan-out.
 *
 * Uses the WebSocket Hibernation API: an idle room is evicted from memory without dropping its
 * connections, so a lobby left open overnight costs nothing.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { apply, initialRoom, memberJoined, memberLeft, type Deps, type Profile } from './lobby';
import { viewFor } from './redact';
import {
  DRAFT_KEY,
  checkPhoto,
  commitDraft,
  contentTypeFor,
  draftHasExpired,
  isValidFile,
  isValidToken,
  newDraft,
  packStorage,
  type PackDraft,
} from './customPack';
import {
  CUSTOM_PACK_ID,
  isPackImageFormat,
  parseClientMessage,
  type RoomState,
  type ServerMessage,
} from './protocol';

/** An abandoned room is cleared out rather than paying storage forever. */
const IDLE_CLEANUP_MS = 6 * 60 * 60 * 1000;

const STORAGE_KEY = 'room';

/** Set when a code room is opened on purpose; absent means the code was never handed out. */
const CREATED_KEY = 'created';

/** Two full teams, their leaders and a gallery. Past this a code room is being abused. */
const MAX_MEMBERS = 32;

/** Keepalives are answered by the runtime, so they never wake a hibernating room. */
const PING = JSON.stringify({ type: 'ping' });
const PONG = JSON.stringify({ type: 'pong' });

export class GameRoom extends DurableObject<Env> {
  private room: RoomState = initialRoom();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Hibernation means this constructor runs again on wake, so state is reloaded from storage
    // rather than assumed to be in memory.
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomState>(STORAGE_KEY)) ?? initialRoom();
    });

    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/pack/')) return this.handlePack(request, url);
    if (url.pathname === '/room/create') return this.handleCreate();

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    // `idFromName` hands back a live object for any string, so without this a mistyped code
    // would quietly open an empty room and leave the typist waiting in it. A Discord instance
    // needs no such proof: the id only exists because Discord made the activity.
    if (request.headers.get('x-guessfi-room-kind') === 'code') {
      if (!(await this.ctx.storage.get<number>(CREATED_KEY))) {
        return Response.json({ error: 'no_such_room' }, { status: 404 });
      }
    }

    // The Worker verified the session and put the identity here. A Durable Object namespace is
    // not publicly routable, so these headers cannot come from outside.
    const profile = profileFromHeaders(request.headers);
    if (!profile) return new Response('Missing identity', { status: 401 });

    const rejection = this.admissionRefusal(profile.userId);
    if (rejection) return Response.json({ error: rejection }, { status: 403 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    // Survives hibernation, so a woken room still knows whose socket this is.
    server.serializeAttachment(profile);

    this.room = memberJoined(this.room, profile);
    await this.persist();
    this.broadcast();

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;

    const profile = attachmentOf(ws);
    if (!profile) {
      ws.close(1011, 'Unknown connection');
      return;
    }

    const message = parseClientMessage(raw);
    if (!message) {
      send(ws, { type: 'error', code: 'bad_message', message: 'Unrecognised message' });
      return;
    }
    if (message.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }

    // Dealing secrets needs the board, and the board lives in the pack manifest on the asset
    // layer. Resolved here so every rule in lobby.ts/game.ts stays a synchronous pure function.
    const deps: Deps =
      message.type === 'startGame' ? { characters: await this.loadBoard(this.room.packId) } : {};

    const outcome = apply(this.room, profile.userId, message, deps);
    if (!outcome.ok) {
      send(ws, { type: 'error', ...outcome.error });
      return;
    }
    // Commands that change nothing shouldn't cost a write or a broadcast.
    if (outcome.state === this.room) return;

    this.room = outcome.state;
    await this.persist();
    this.broadcast();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDeparture(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDeparture(ws);
  }

  override async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.room = initialRoom();
  }

  private async handleDeparture(ws: WebSocket): Promise<void> {
    const profile = attachmentOf(ws);
    if (!profile) return;

    // Someone with the activity open in two places is still present when one closes.
    const stillConnected = this.ctx
      .getWebSockets()
      .some((other) => other !== ws && attachmentOf(other)?.userId === profile.userId);
    if (stillConnected) return;

    this.room = memberLeft(this.room, profile.userId);
    await this.persist();
    this.broadcast();
  }

  /** Marks a code room as deliberately opened. Idempotent: creating twice is not an error. */
  private async handleCreate(): Promise<Response> {
    if (!(await this.ctx.storage.get<number>(CREATED_KEY))) {
      await this.ctx.storage.put(CREATED_KEY, Date.now());
      await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
    }
    return Response.json({ ok: true });
  }

  /**
   * Why somebody may not come in, or null if they may.
   *
   * A room reachable by a six-character code will eventually have the wrong person type the
   * right code. Redaction means a walk-in learns no secrets, but they can still fill a lobby or
   * wander into a game in progress, so both are bounded. Anyone already in the room is always let
   * back in — that is a reconnect, and the game is holding their team for them.
   */
  private admissionRefusal(userId: string): string | null {
    if (this.room.members.some((member) => member.userId === userId)) return null;
    if (this.room.members.length >= MAX_MEMBERS) return 'room_full';
    if (this.room.phase !== 'lobby') return 'game_in_progress';
    return null;
  }

  /**
   * Custom pack upload and serving. See handlePack in index.ts for the route shapes.
   *
   * Photos are stored one key per image while the upload is a draft, and only become the room's
   * board on commit — so a client that gives up halfway leaves nothing behind but keys the next
   * cleanup sweeps away.
   */
  private async handlePack(request: Request, url: URL): Promise<Response> {
    const segments = url.pathname.split('/').slice(2).filter(Boolean); // after "/pack/"

    if (request.method === 'GET') {
      const [token, file] = segments;
      if (!token || !file || !isValidToken(token) || !isValidFile(file)) {
        return new Response('Not found', { status: 404 });
      }
      const bytes = await this.ctx.storage.get<ArrayBuffer>(packStorage.imageKey(token, file));
      if (!bytes) return new Response('Not found', { status: 404 });

      return new Response(bytes, {
        headers: {
          'content-type': contentTypeFor(file),
          // The token changes whenever the photos do, so a URL's content never changes.
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }

    const actorId = request.headers.get('x-guessfi-user-id');
    if (!actorId) return packError(401, 'no_identity');

    if (segments[0] === 'begin') return this.beginPack(request, actorId);

    const [token, action] = segments;
    if (!token || !isValidToken(token)) return packError(404, 'no_such_upload');

    const draft = await this.ctx.storage.get<PackDraft>(DRAFT_KEY);
    if (!draft || draft.token !== token) return packError(404, 'no_such_upload');
    if (draftHasExpired(draft)) return packError(410, 'upload_expired');

    if (action === 'add') return this.addPhoto(request, url, draft, actorId);
    if (action === 'commit') return this.commitPack(request, draft, actorId);
    return packError(404, 'no_such_action');
  }

  private async beginPack(request: Request, actorId: string): Promise<Response> {
    if (this.room.hostId !== actorId) return packError(403, 'not_host');
    if (this.room.phase !== 'lobby') return packError(409, 'not_in_lobby');

    const body = (await readJson(request)) as { name?: unknown };
    const name = typeof body?.name === 'string' ? body.name : 'Custom';

    // One upload at a time per room: starting a new one abandons whatever was in flight.
    const previous = await this.ctx.storage.get<PackDraft>(DRAFT_KEY);
    if (previous) await this.deletePackImages(previous.token);

    const draft = newDraft(actorId, name);
    await this.ctx.storage.put(DRAFT_KEY, draft);
    return Response.json({ token: draft.token });
  }

  private async addPhoto(request: Request, url: URL, draft: PackDraft, actorId: string): Promise<Response> {
    const file = url.searchParams.get('file') ?? '';
    const bytes = await request.arrayBuffer();

    const allowed = checkPhoto(draft, actorId, file, bytes.byteLength);
    if (!allowed.ok) return packError(allowed.status, allowed.error);

    await this.ctx.storage.put(packStorage.imageKey(draft.token, file), bytes);
    if (!draft.stored.includes(file)) {
      draft.stored.push(file);
      await this.ctx.storage.put(DRAFT_KEY, draft);
    }
    return Response.json({ ok: true });
  }

  private async commitPack(request: Request, draft: PackDraft, actorId: string): Promise<Response> {
    const body = (await readJson(request)) as {
      characters?: { id: string; name: string }[];
      format?: unknown;
    };
    // Older clients uploaded WebP without saying so.
    const format = isPackImageFormat(body?.format) ? body.format : 'webp';

    const committed = commitDraft(draft, actorId, body?.characters ?? [], format);
    if (!committed.ok) return packError(committed.status, committed.error);

    // The board it replaces is now unreachable, so its photos go with it.
    const replaced = this.room.customPack;
    if (replaced && replaced.token !== committed.value.token) await this.deletePackImages(replaced.token);

    this.room = {
      ...this.room,
      customPack: committed.value,
      packId: CUSTOM_PACK_ID,
      // A different board is a different game; everyone confirms again.
      members: this.room.members.map((member) => ({ ...member, ready: false })),
    };
    await this.ctx.storage.delete(DRAFT_KEY);
    await this.persist();
    this.broadcast();

    return Response.json({ pack: committed.value });
  }

  private async deletePackImages(token: string): Promise<void> {
    const keys = [...(await this.ctx.storage.list<ArrayBuffer>({ prefix: packStorage.prefixFor(token) })).keys()];
    if (keys.length > 0) await this.ctx.storage.delete(keys);
  }

  /**
   * Reads the character list for a pack off the static asset layer.
   *
   * The manifest is the same file the clients render from, so the server's idea of the board and
   * theirs cannot drift. Returns undefined when it can't be read, which `startGame` turns into a
   * rejection the host can see — note the asset layer answers unknown paths with index.html, so
   * unparseable JSON means "no such pack" rather than a transport failure.
   */
  private async loadBoard(packId: string | null): Promise<string[] | undefined> {
    if (!packId) return undefined;

    // An uploaded board is already in room state; there is no manifest to fetch.
    if (packId === CUSTOM_PACK_ID) {
      const characters = this.room.customPack?.characters.map((character) => character.id);
      return characters && characters.length > 0 ? characters : undefined;
    }

    try {
      const url = new URL(`/packs/${packId}/manifest.json`, 'https://assets.invalid');
      const response = await this.env.ASSETS.fetch(new Request(url));
      if (!response.ok) return undefined;

      const manifest = (await response.json()) as { characters?: { id?: unknown }[] };
      const characters = (manifest.characters ?? [])
        .map((character) => character.id)
        .filter((id): id is string => typeof id === 'string');

      return characters.length > 0 ? characters : undefined;
    } catch {
      return undefined;
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, this.room);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
  }

  /**
   * Every client gets its own view rather than one shared blob. Nothing is redacted in the lobby,
   * but the game's secrets will be, and routing fan-out through here now means there is no
   * shared-payload path left to accidentally leak through later.
   */
  private broadcast(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const profile = attachmentOf(socket);
      if (!profile) continue;
      send(socket, { type: 'state', state: viewFor(this.room, profile.userId) });
    }
  }
}

const packError = (status: number, error: string): Response => Response.json({ error }, { status });

/** Upload bodies come from a client, so a malformed one is a 400 rather than an exception. */
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function attachmentOf(ws: WebSocket): Profile | null {
  try {
    return (ws.deserializeAttachment() as Profile | null) ?? null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket closed between selection and send; the close handler will tidy up.
  }
}

/** Names can contain any Unicode, but headers are latin-1, so the Worker percent-encodes them. */
function profileFromHeaders(headers: Headers): Profile | null {
  const userId = headers.get('x-guessfi-user-id');
  if (!userId) return null;

  let name = userId;
  try {
    name = decodeURIComponent(headers.get('x-guessfi-user-name') ?? '') || userId;
  } catch {
    // Malformed encoding: fall back to the id rather than refusing the connection.
  }

  const avatar = headers.get('x-guessfi-user-avatar');
  const kind = headers.get('x-guessfi-user-kind') === 'guest' ? 'guest' : 'discord';
  return { userId, name, avatar: avatar ? avatar : null, kind };
}
