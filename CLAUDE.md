# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Team Guess Who as a Discord Activity, played with your own photos. Two teams, each with a leader;
teams take turns asking yes/no questions and flipping tiles down until a leader names the
opponent's character. Runs on Cloudflare Workers + Durable Objects + static assets, entirely on
the free tier.

## Node version

**Node 22+ is required** (wrangler 4 refuses to start on anything older) and `.nvmrc` pins it. nvm
does not always default to it — run `nvm use` before anything else, or commands fail with a
version error rather than something informative.

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Typecheck + unit + e2e — exactly what CI runs. The one to run before saying something works. |
| `npm run typecheck` | All three TS projects (see below) |
| `npm test` | Unit tests (vitest, `tests/**/*.test.ts`) |
| `npm run test:e2e` | Builds, boots the real Worker, drives headless Chrome |
| `npm run doctor` | Diagnoses config problems and prints the fix for each |
| `npm run setup` | Writes `.env`/`.dev.vars`, generates `SESSION_SECRET`, verifies credentials against Discord |
| `npm run dev:discord` | Worker + Vite + cloudflared tunnel, prints the URL mapping to paste |
| `npm run dev` | Worker + Vite only |
| `npm run packs` | Encode `packs/` into `public/packs/` |
| `npm run demo-pack` | Generate 24 placeholder portraits |
| `npm run deploy` | Build and push to Cloudflare |

Single test file: `npx vitest run tests/game.test.ts`. Single test: `npx vitest run -t 'name'`.

The e2e suite is one script (`scripts/e2e.ts`) with no per-section flag — it runs start to finish
(~90s). `--keep-open` leaves the Worker up on failure for poking at.

## Four TypeScript projects, deliberately separate

`tsconfig.client.json` (DOM), `tsconfig.server.json` (`@cloudflare/workers-types`),
`tsconfig.scripts.json` (Node) and `tsconfig.tests.json` (Node) exist so DOM, Workers, and Node
globals never leak into each other. A file shared between projects must be added to each
`include` list — this is why `server/protocol.ts` and `shared/` appear in the client's config.
The tests project includes only `tests/` and lets TypeScript follow the imports, which keeps the
Worker entry points out of it. `npm run typecheck` runs all four; typechecking only one hides
real breakage.

## Architecture

### The layering that matters

Rules are pure functions over `RoomState`; the Durable Object owns only sockets, storage and
fan-out. Keep it that way — it is what makes turn order, leader authority and redaction testable
without booting a runtime.

```
server/protocol.ts  wire contract + frame validator (imported by both sides, so they can't drift)
server/lobby.ts     apply() — the single entry point for any client command; lobby transitions
server/game.ts      in-game transitions, delegated to from apply()
server/redact.ts    RoomState -> RoomView, per recipient
server/room.ts      GameRoom DO: WebSockets, DO storage, per-connection broadcast
server/index.ts     Worker: routing, OAuth exchange, WS upgrade, custom pack routes
```

`apply(state, actorId, message, deps)` is synchronous and total. Anything needing I/O is resolved
by `room.ts` first and passed in via `deps` — that is why `startGame` takes a `characters` list
rather than fetching the pack manifest itself.

### Secrecy is the load-bearing constraint

Everyone in the activity shares one voice channel, including the opposing team. So:

- **A team's secret goes to that team's leader only** — not to their own teammates.
- **Each team's flipped tiles are private to that team.** They are the team's deductions.
- Only a leader may ask, answer, or guess. Everyone else flips tiles and argues.

`redact.ts` is the **only** path from `RoomState` to something sent over a socket, and `room.ts`
broadcasts per connection rather than one shared blob. `RoomView` deliberately `Omit`s `game`
from `RoomState` instead of extending it, so adding a field to `GameState` produces a compile
error until someone decides who may see it. Do not "simplify" that into a spread.

Redaction tests assert on **serialized frames**, not parsed objects — `JSON.stringify(view)` must
not contain the other side's secret. This is also why `GameView` omits the character list: the
client already has it from the pack manifest, and including it would put every secret in every
frame and make the byte-level assertion impossible.

### Rooms and identity

One Durable Object per room, keyed `idFromName(roomKey)`. There are two doors and `server/rooms.ts`
reduces both to one key, so nothing downstream knows which was used:

```
Discord activity   instanceId  ->  d:<instanceId>     auto-creates; the id proves it exists
Browser link       KP7X2M      ->  c:KP7X2M           must be opened via POST /api/rooms first
```

`idFromName` returns a live object for *any* string, so a code room records a `created` marker and
the upgrade refuses one without it — otherwise a mistyped code silently opens an empty room and
the typist sits in it alone. A code is a join credential, so code rooms also cap members and turn
away newcomers once a game is running (existing members always get back in — that is a reconnect).

Identity is verified by the Worker (HMAC session token from `server/session.ts`) and passed to the
DO in `x-guessfi-user-*` headers, trustworthy because a DO namespace is not publicly routable.
Guest ids are generated server-side and never read from the request — that is the whole security
model of guest play. **Never trust identity from the client frame.**

### Photo packs, two kinds

- **Built-in**: `scripts/build-packs.ts` turns `packs/<name>/` into WebP tiles and manifests in
  `public/packs/`, shipped as static assets. Free, unmetered, same-origin.
- **Custom**: the host picks 10–40 photos in the lobby; the browser crops and re-encodes them
  (`client/src/customPack.ts`) and uploads via begin → add → commit to the room, which stores them
  in DO storage (`server/customPack.ts`). Served under a random per-pack token, deleted when the
  room is cleaned up.

`shared/naming.ts` derives character names and ids from filenames and is used by **both** paths,
so ids stay identical. It must stay free of `node:path` — the client bundles it.

## Discord and networking

- The activity is served from `https://<client_id>.discordsays.com` with a **root URL mapping**;
  same-origin paths pass straight through, so **`/.proxy` is not needed** (the Worker strips it
  anyway). Requests to other origins are blocked by CSP.
- All request paths go through `apiPath()` in `client/src/discord.ts`, so adding an external URL
  mapping later is a one-line change.
- Static assets use `not_found_handling: "single-page-application"`, so **a missing asset returns
  200 with index.html, not 404**. Code that fetches JSON must treat unparseable bodies as missing
  rather than trusting the status code.
- Outside Discord (no `frame_id` param) the client shows a landing screen instead: `POST
  /api/guest` mints a session with a **server-generated** id, and `POST /api/rooms` opens a room
  reachable at `/r/<CODE>`. This is a shipping path, not a dev affordance — there is no dev-only
  session route. `?name=alice` on any URL prefills the name and skips the form, which is how the
  e2e suite drives two players.
- **The URL mapping in the developer portal is the one thing that cannot be automated** — Discord
  exposes no API for it.

## Testing conventions

Unit tests drive the pure functions directly and read as statements about the rules ("lets only
the active team's leader ask"). The e2e script covers three layers the unit tests cannot: the room
over real WebSockets (including frame-level redaction across five clients), the game through two
real browsers, and the custom pack upload driven through an actual file input via CDP. Prefer
adding to the right layer over duplicating a rule at every layer.
