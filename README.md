# guessFi

Team Guess Who, played with your own photos — as a Discord Activity, or from any browser.

Two teams, each with a leader. Every team gets a secret character; teams take turns asking yes/no
questions and flipping down tiles until a leader commits to a guess.

Runs entirely on Cloudflare's free tier.

**Status: a full game is playable, through either door.** In Discord the activity supplies the
roster and the voice channel. In a browser you open a room, send someone the link, and play — see
[Playing in a browser](#playing-in-a-browser), including the one thing that changes without voice
chat. What's left is polish: layout modes, spectator UI, disconnect handling. See
[Roadmap](#roadmap).

## Requirements

- **Node 22+** (wrangler 4 requires it; `.nvmrc` pins it — run `nvm use`)
- A Cloudflare account (free plan is enough)
- `cloudflared` for local development against Discord

## Quick look, no setup

```bash
npm install
npm run demo-pack     # 24 placeholder portraits, so there's a board to look at
npm run packs         # encode them into public/packs/
npm run dev:client
```

Open http://localhost:5173 — but for a real game you want the Worker too, since rooms live in it:

```bash
npm run dev           # Worker + Vite
```

Then open http://localhost:8787, type a name, and hit **Start a new room**. Open the `/r/<CODE>`
URL it gives you in a second window (append `?name=someone-else`, or storage will recognise you as
the same player) and you have two players without touching Discord.

## Playing in a browser

The host opens a room and gets a six-character code and a link. Anyone with either is in.

- **Codes are join credentials.** Six characters from an alphabet with `O 0 I 1 L` removed, so
  they survive being read aloud. Anyone who types one is in the room — redaction still holds, so a
  walk-in sees no secrets, but rooms cap their members and turn newcomers away once a game is
  running.
- **Identity is server-issued.** `POST /api/guest` mints a session with an id the Worker generates;
  the name is yours to pick, the identity is not. Nobody can claim someone else's seat by typing
  their name.
- **Your seat survives a refresh.** The session is kept per room in `localStorage`, so reloading
  mid-game returns you to your own team and leader role rather than as a stranger. A different
  name in the same browser is treated as a different player, which is what makes two people on one
  laptop work.
- **A mistyped code is not a room.** Rooms must be opened deliberately; a code nobody created
  reports "no such room" instead of dropping you into an empty one of your own making.

**What voice chat was doing.** The design leans on everyone being able to hear each other: secrets
are leader-only *because* the team can talk, and **Pass** exists *because* questions get asked out
loud. In a browser, bring your own call — the app does not carry voice, and in-app team chat is a
deliberate open question rather than an oversight. See
`~/.claude/plans/guessfi-browser-rooms.md`.

## Photo packs

Two ways to get faces on the board.

**Built in, shipped with the app.** Drop photos into `packs/<pack-name>/` and run `npm run packs`.
Filenames become character names. Full details — naming rules, `pack.json` overrides, what the
encoder does — in [`packs/README.md`](packs/README.md). `npm run build` runs the pack build first,
so a deploy always ships current packs.

**Custom, picked at the table.** In the lobby the host can hit **Custom photos…** and choose 10–40
images from their device. The browser centre-crops and re-encodes each one to the same 256px tile
and 512px full-size WebP the build script produces, then uploads them to the room. Quality steps
down until a photo fits the room's per-photo budget, and a photo too dense to fit even at the
lowest quality is shrunk rather than rejected.

Worth knowing about the custom path:

- **The photos live in the room, not on the asset layer.** Static assets are read-only after a
  deploy, so uploads go into the Durable Object's own storage. They are deleted when the room is
  cleaned up — a few hours after everyone leaves — which is the right default for pictures of
  people's friends.
- **They are served by a random token**, not by room id, so knowing which voice channel a game was
  in is not enough to fetch the pictures.
- **Encoding happens in the browser.** The Worker never sees a full-resolution photo, only the
  small images it stores, and the resize costs Cloudflare nothing. WebP is used where the browser
  can produce it and JPEG everywhere else — `canvas.toBlob` answers a type it cannot encode with
  PNG rather than an error, so the result is checked against its magic bytes and the pack records
  which format it actually holds.
- Only the host can upload, only in the lobby, and publishing a new board clears everyone's ready
  state — a different board is a different game.

## Running inside Discord

### 1. Create the Discord application

1. <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2** → copy the **Client ID** and **Client Secret**.
3. **OAuth2** → **Redirects** → add `https://127.0.0.1` (a placeholder; the activity never
   redirects, but the portal requires an entry before it will issue tokens).
4. **Activities** → **Settings** → enable activities for the app.

### 2. Configure

```bash
npm run setup
```

Prompts for the client ID and secret, then writes `.env`, writes `.dev.vars` with a freshly
generated `SESSION_SECRET`, sets `vars.DISCORD_CLIENT_ID` in `wrangler.jsonc`, and calls Discord
to confirm the credentials actually work — a mistyped secret otherwise shows up much later as an
opaque 502 from `/api/token`.

Non-interactive: `npm run setup -- --client-id X --client-secret Y`. Re-running is safe; existing
values are kept unless you pass new ones. Both `.env` and `.dev.vars` are gitignored, and the
client secret only ever reaches the Worker.

### 3. Start everything

```bash
npm run dev:discord
```

Starts the Worker, Vite, and a cloudflared tunnel, waits for all three, then prints the tunnel
hostname and what to do with it. Ctrl-C stops all three.

### 4. Point Discord at the tunnel

Developer portal → **Activities** → **URL Mappings** → set the **root mapping** `/` to the
hostname the previous step printed (no scheme, no trailing slash).

**This is the one step that cannot be automated.** Discord exposes no API for URL mappings —
`PATCH /applications/@me` has no such field — so it has to be done in the portal by hand.

Quick-tunnel hostnames change every run. To set the mapping once and stop thinking about it, run
`npm run deploy` and point the root mapping at the stable `guessfi.<subdomain>.workers.dev` host
instead.

With `/` mapped, the activity is served from `https://<client_id>.discordsays.com` and
same-origin paths like `/api/token` and `/packs/foo.webp` pass straight through. No `/.proxy`
prefix is needed — see [Networking](#networking-notes).

### 5. Launch it

Join a voice channel in a test server, open the activity picker (the rocket icon), and pick your
app. You should see your own username and everyone else in the channel.

> Unverified activities only run in servers with **fewer than 25 members**. That is fine for
> playing with friends. Passing 100 servers or listing in the App Directory requires app
> verification, which includes Stripe identity verification of the team owner.

## Deploying

```bash
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npm run deploy
```

Then repoint the root URL mapping from the tunnel to `guessfi.<your-subdomain>.workers.dev`.

## Layout

```
client/src/discord.ts        SDK handshake, and the single place request paths are built
client/src/join.ts           Room codes in the URL, guest sessions, localStorage
client/src/screens/Landing.tsx  The front door for anyone not arriving through Discord
client/src/net.ts            Room WebSocket, heartbeat and reconnect
client/src/packs.ts          Pack index/manifest loading
client/src/customPack.ts     Browser-side resize/encode and upload of the host's own photos
client/src/screens/Lobby.tsx Teams, leaders, pack choice, ready-up
client/src/screens/Game.tsx  Turn banner, secret card, question log, guessing, endgame
client/src/screens/Board.tsx The tile grid
client/src/App.tsx           UI shell
server/index.ts              Worker: routing, OAuth exchange, guest sessions, room creation
server/rooms.ts              Room keys, codes, guest ids, display-name cleaning
server/room.ts               GameRoom Durable Object: sockets, persistence, fan-out
server/lobby.ts              Room rules as pure functions; dispatches in-game messages
server/game.ts               Turn order, leader authority, guess resolution
server/redact.ts             Per-recipient views — the only path from state to the wire
server/customPack.ts         Upload draft/commit rules for host-supplied photos
server/protocol.ts           Wire contract shared by both sides, plus the frame validator
server/session.ts            HMAC session tokens (Web Crypto)
shared/naming.ts             Filename -> character name and id, used by the build and the browser
scripts/build-packs.ts       photos -> square WebP tiles + manifests
scripts/make-demo-pack.ts    generates the placeholder pack
wrangler.jsonc               Worker + static asset config
```

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Write config, generate `SESSION_SECRET`, verify credentials with Discord |
| `npm run doctor` | Diagnose anything misconfigured, with the fix for each |
| `npm run dev:discord` | Worker + Vite + tunnel, and print the URL mapping to paste |
| `npm run dev` | Worker + Vite only (no tunnel) |
| `npm run demo-pack` | Generate 24 placeholder portraits |
| `npm run packs` | Encode `packs/` into `public/packs/` |
| `npm run build` | Packs, then the client bundle |
| `npm run deploy` | Build and push to Cloudflare |
| `npm test` | Unit tests |
| `npm run test:e2e` | Build, boot the Worker, drive the board in headless Chrome |
| `npm run check` | Typecheck + unit + e2e — what CI runs |

`npm run typecheck` checks all three projects — client, Worker, and build scripts each have their
own tsconfig so DOM, Workers, and Node globals never leak into each other.

### What's automated, and what isn't

Everything except the URL mapping. `setup` handles config and proves the credentials work,
`doctor` explains anything broken, `dev:discord` runs the stack and extracts the tunnel hostname,
and `check` runs the whole verification suite the same way CI does.

The e2e suite drives Chrome over the DevTools Protocol directly — no Puppeteer or Playwright to
install — and asserts the things unit tests can't reach: asset routing, `/.proxy` handling, SPA
fallback, and that the board renders and responds to clicks.

The URL mapping stays manual because Discord provides no API for it. Deploying once and mapping
to the stable `workers.dev` host reduces that to a single lifetime step.

## Networking notes

Everything inside the iframe is served from `https://<client_id>.discordsays.com`, and requests to
any other origin are blocked by CSP with `blocked:csp`. Two consequences:

- **Photo packs ship as static assets**, same-origin. This sidesteps CSP entirely and costs
  nothing — Cloudflare does not bill static asset requests.
- **`cdn.discordapp.com` is allowed**, which is why avatars load directly.

On the much-repeated `/.proxy` prefix: it is **not** needed with a root mapping. The SDK's
`patchUrlMappings` only rewrites *cross-origin* URLs (it early-returns when
`url.host === window.location.host`), and Discord's own starter fetches a bare `/api/token`. The
prefix belongs to setups that map external hosts. The Worker strips a leading `/.proxy` anyway, so
both forms work if a future proxy change starts sending it.

To reach a third-party origin later, add a URL mapping in the portal and route the request through
`apiPath()` in `client/src/discord.ts` rather than hardcoding a host.

One consequence of `not_found_handling: "single-page-application"`: a missing asset returns
**200 with index.html**, not a 404. `fetchJson` in `client/src/packs.ts` therefore treats
unparseable JSON as "not built yet" rather than trusting the status code.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Scaffold, Discord handshake, participant list | ✅ done |
| 2 | Photo pack pipeline and the board grid | ✅ done |
| 3 | `GameRoom` Durable Object, WebSocket protocol, lobby with teams and leaders | ✅ done |
| 4 | Game loop: secrets, questions, tile flips, guessing, endgame | ✅ done |
| 5 | Layout modes, mobile, spectators, reconnect, room cleanup | mobile done; rest next |
| 6 | Deploy and smoke test | ✅ done |
| 7 | Browser rooms: codes, guest identity, shareable links | ✅ done |
| 8 | Team chat, so a browser room works without voice | open — see the plan |

### Taking a turn

A leader can ask a question, **Pass**, or name a character. Passing exists because everyone is in
a voice channel: most questions get asked out loud, and a leader who already has their answer has
nothing to type. The log records the pass so the turn order still reads back.

### How a game ends

On their own turn a leader can name a character instead of asking a question. That stops play at
once and reveals both boards — but it also ends the game for a team that may have been one
question away, so the endgame screen offers the host a **Let <team> finish** button.

Reopening puts the other team back on the board alone: they ask, the team that already guessed
still answers (it holds the character they are hunting), and their own guess closes the game for
good. Then:

| Guesses | Result |
|---|---|
| One team right | That team wins |
| Both right | Whoever named it first wins |
| One team wrong, the other never guessed | The other team wins by default |
| Both wrong | A draw |

So a wrong guess is still the classic penalty, and the offer to play on is a real decision rather
than a formality: it is a chance to win it properly, at the risk of turning a default win into a
draw. The screen says as much before the host clicks.

From the result screen the host can **Play again** — same teams, same board, fresh characters, no
ready-up — or go **Back to the lobby** to change the line-up or the pack.

A game also ends if a team loses its last connected player: that is a walkover for whoever is
left, and it stops the room waiting forever on a turn nobody can take. The **Leave** button in the
header closes the activity, and leaving is what triggers this.

### The design constraint that shapes everything

**A team's secret is visible to its leader only.**

Everyone in the activity shares one voice channel, including the opposing team. If a whole team
could see "you are Bob," someone would say it out loud within a minute. Restricting the secret to
the leader means teams only ever discuss *who the opponent might be* — which the public question
log already reveals, so it leaks nothing.

That is also why only the leader can answer questions, submit a question, or commit a final guess.
Everyone else flips tiles and argues in voice.

The full plan, including the hosting cost comparison, lives in
`~/.claude/plans/refactored-cooking-yeti.md`.
