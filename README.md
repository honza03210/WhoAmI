# guessFi

Team Guess Who as a Discord Activity, played with your own photos.

Two teams, each with a leader. Every team gets a secret character; teams take turns asking yes/no
questions and flipping down tiles until a leader commits to a guess. Voice chat and the player
roster come from Discord — the app only owns game state.

Runs entirely on Cloudflare's free tier.

**Status: phase 1 of 6 complete.** The activity boots inside Discord, authenticates, and shows the
live participant list. The game itself is not built yet — see [Roadmap](#roadmap).

## Requirements

- **Node 22+** (wrangler 4 requires it; `.nvmrc` pins it — run `nvm use`)
- A Cloudflare account (free plan is enough)
- `cloudflared` for local development against Discord

## Quick look, no setup

```bash
npm install
npm run dev:client
```

Open http://localhost:5173. Outside Discord the app detects the missing `frame_id` param and
falls back to `DiscordSDKMock`, so the UI renders with fake participants and no Discord app of
your own. Good enough for UI work; useless for testing anything involving real identity.

## Running inside Discord

### 1. Create the Discord application

1. <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2** → copy the **Client ID** and **Client Secret**.
3. **OAuth2** → **Redirects** → add `https://127.0.0.1` (a placeholder; the activity never
   redirects, but the portal requires an entry before it will issue tokens).
4. **Activities** → **Settings** → enable activities for the app.

### 2. Configure local secrets

```bash
cp .env.example .env          # VITE_DISCORD_CLIENT_ID — public, baked into the client bundle
```

Then put the client ID into `wrangler.jsonc` under `vars.DISCORD_CLIENT_ID`, and the secret into
`.dev.vars`:

```
DISCORD_CLIENT_SECRET=<from the OAuth2 page>
SESSION_SECRET=<already generated for you; openssl rand -base64 32 to replace>
```

Both `.env` and `.dev.vars` are gitignored. The client secret must never reach the client bundle —
only the Worker touches it.

### 3. Start everything

Three processes. In separate terminals, or `npm run dev` for the first two:

```bash
npm run dev:worker    # Worker + /api on :8787
npm run dev:client    # Vite on :5173, proxies /api to the Worker
npm run tunnel        # cloudflared, prints a https://<random>.trycloudflare.com URL
```

### 4. Point Discord at the tunnel

Developer portal → **Activities** → **URL Mappings** → set the **root mapping** `/` to the
`trycloudflare.com` hostname (no scheme, no trailing slash).

This is the mapping that makes everything else work: with `/` mapped, the activity is served from
`https://<client_id>.discordsays.com` and same-origin paths like `/api/token` and
`/packs/foo.webp` pass straight through. No `/.proxy` prefix is needed — see
[Networking](#networking-notes).

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
client/src/discord.ts   SDK handshake, participant roster, the single place request paths are built
client/src/App.tsx      UI shell
server/index.ts         Worker: routing, /api/token OAuth exchange
server/session.ts       HMAC session tokens (Web Crypto)
wrangler.jsonc          Worker + static asset config
```

`npm run typecheck` checks both projects — client and Worker have separate tsconfigs so DOM and
Workers globals never leak into each other.

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

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Scaffold, Discord handshake, participant list | ✅ done |
| 2 | Photo pack pipeline (`scripts/build-packs.ts`, sharp → square webp + manifest) | next |
| 3 | `GameRoom` Durable Object, WebSocket protocol, lobby with teams and leaders | |
| 4 | Game loop: secrets, questions, tile flips, guessing, endgame | |
| 5 | Layout modes, mobile, spectators, reconnect, room cleanup | |
| 6 | Deploy and smoke test | |

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
