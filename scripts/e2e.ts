/**
 * End-to-end smoke test: builds the app, serves it through the real Worker, and drives a
 * headless Chrome over the DevTools Protocol.
 *
 *   npm run test:e2e
 *   npm run test:e2e -- --no-build     reuse the existing dist/
 *   npm run test:e2e -- --keep-open    leave the server up on failure for poking at
 *
 * This covers the things unit tests can't: asset routing, the /.proxy prefix, SPA fallback,
 * and whether the board actually renders and responds to clicks. Chrome is driven directly
 * over CDP so there is no puppeteer/playwright dependency to install or keep current.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  process.env['CHROME_PATH'],
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((value): value is string => Boolean(value));

// High ports, chosen to avoid a dev server already on 8787.
const SERVER_PORT = 8891;
const DEBUG_PORT = 9333;
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;

const args = process.argv.slice(2);
const shouldBuild = !args.includes('--no-build');
const keepOpen = args.includes('--keep-open');

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  checks++;
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
  }
}

function checkEqual(name: string, actual: unknown, expected: unknown): void {
  check(`${name} = ${JSON.stringify(expected)}`, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), actual);
}

/**
 * wrangler spawns workerd, and Chrome spawns zygote/renderer children. Killing only the direct
 * child orphans those, leaving a port bound and processes running after the test exits — so
 * everything is started in its own process group and the whole group is signalled.
 */
function spawnGroup(command: string, commandArgs: string[], stdio: 'ignore' | ['ignore', 'ignore', 'pipe']): ChildProcess {
  return spawn(command, commandArgs, { stdio, detached: true });
}

function killGroup(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * SIGKILL on wrangler orphans the workerd runtime it manages, leaving the port bound after the
 * test exits. SIGINT lets it shut workerd down itself; SIGKILL is only the fallback.
 */
async function stopGracefully(child: ChildProcess | undefined, graceMs = 5_000): Promise<void> {
  if (!child || child.exitCode !== null) return;
  killGroup(child, 'SIGINT');
  await awaitExit(child, graceMs);
  if (child.exitCode === null) killGroup(child, 'SIGKILL');
  await awaitExit(child, 2_000);
}

function awaitExit(child: ChildProcess | undefined, timeoutMs = 5_000): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once('exit', done);
    setTimeout(done, timeoutMs);
  });
}

function run(command: string, commandArgs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

/**
 * Each probe is raced against its own timeout. Without that, a single hung probe blocks past
 * the overall deadline forever — a half-dead server that accepts connections but never answers
 * will wedge an un-timed `fetch` indefinitely.
 */
async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  timeoutMs = 60_000,
  probeTimeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const settled = await Promise.race([
      probe().catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), probeTimeoutMs)),
    ]);
    if (settled) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Every request in this script is bounded, for the reason above. */
function get(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}

async function isPortFree(port: number): Promise<boolean> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function findChrome(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.includes('/') && existsSync(candidate)) return candidate;
    if (!candidate.includes('/')) return candidate; // resolved via PATH by spawn
  }
  return null;
}

/**
 * Minimal CDP client over the WebSocket built into Node 22.
 *
 * Opens a blank target and navigates via Page.navigate rather than passing the URL to
 * /json/new, whose query string can't unambiguously carry a URL that has its own parameters.
 */
async function openPage(pageUrl: string) {
  const page = await connectCdp('about:blank');
  await page.call('Page.enable', {});
  await page.call('Page.navigate', { url: pageUrl });

  const origin = new URL(pageUrl).origin;
  // The first execution context may still be about:blank, and is torn down when the real
  // navigation commits, so wait until the page is genuinely ours and loaded.
  await waitFor(
    `${pageUrl} to load`,
    async () =>
      (await page.evaluate<boolean>(
        `location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`,
      )) === true,
  );
  return page;
}

async function connectCdp(pageUrl: string) {
  const target = (await (
    await get(`http://127.0.0.1:${DEBUG_PORT}/json/new?${pageUrl}`, { method: 'PUT' })
  ).json()) as { webSocketDebuggerUrl: string };

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map<number, (message: { result?: unknown }) => void>();
  let nextId = 0;

  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number };
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)!(message as { result?: unknown });
      pending.delete(message.id);
    }
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('CDP socket failed'));
  });

  const call = (method: string, params: Record<string, unknown>): Promise<{ result?: unknown }> => {
    const id = ++nextId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  return {
    call,
    async evaluate<T>(expression: string): Promise<T> {
      const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const result = reply.result as
        | { exceptionDetails?: { text?: string; exception?: { description?: string } }; result?: { value?: T } }
        | undefined;
      if (result?.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'CDP evaluate failed',
        );
      }
      // A destroyed execution context (mid-navigation) yields no result rather than an error.
      return result?.result?.value as T;
    },
    close: () => socket.close(),
  };
}

interface BoardReport {
  tileCount: number;
  initialHeading: string;
  resetDisabledInitially: boolean;
  afterThreeFlips: string;
  flippedCount: number;
  ariaPressed: string | null;
  ariaLabel: string | null;
  afterUnflip: string;
  flippedAfterUnflip: number;
  afterReset: string;
  flippedAfterReset: number;
  resetDisabledAfterReset: boolean;
  brokenImages: number;
  firstTileName: string;
  distinctNames: number;
}

const BOARD_SCRIPT = `(async () => {
  const wait = async (test, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (test()) return true; await new Promise(r => setTimeout(r, 50)); }
    // Report what the page actually shows: a blank body means the app threw, whereas
    // "Loading the board…" means the pack fetch is the problem.
    throw new Error('timed out — page reads: ' + JSON.stringify(document.body.innerText.slice(0, 400)));
  };
  await wait(() => document.querySelectorAll('.tile').length > 0);
  const tiles = () => [...document.querySelectorAll('.tile')];
  const heading = () => document.querySelector('.board-header h2').textContent.trim();
  const flipped = () => document.querySelectorAll('.tile.is-flipped').length;
  // Scoped to the board: the in-game actions above it carry link buttons of their own.
  const resetBtn = () => document.querySelector('.board-header .link-button');
  // Flips round-trip through the Durable Object now, so wait for the room to agree rather
  // than sleeping and hoping.
  const settle = (n) => wait(() => flipped() === n, 5000);

  const out = {
    tileCount: tiles().length,
    initialHeading: heading(),
    resetDisabledInitially: resetBtn().disabled,
    firstTileName: tiles()[0].querySelector('.tile-name').textContent,
    distinctNames: new Set(tiles().map(t => t.querySelector('.tile-name').textContent)).size,
  };

  tiles()[0].click(); tiles()[5].click(); tiles()[11].click();
  await settle(3);
  out.afterThreeFlips = heading();
  out.flippedCount = flipped();
  out.ariaPressed = tiles()[0].getAttribute('aria-pressed');
  out.ariaLabel = tiles()[0].getAttribute('aria-label');

  tiles()[5].click();
  await settle(2);
  out.afterUnflip = heading();
  out.flippedAfterUnflip = flipped();

  resetBtn().click();
  await settle(0);
  out.afterReset = heading();
  out.flippedAfterReset = flipped();
  out.resetDisabledAfterReset = resetBtn().disabled;

  // Tiles are lazy-loaded, and with the game UI above the board most of them never come near
  // the viewport in a headless window. Opt them out rather than trying to scroll past each one:
  // the point of this check is that all 24 assets resolve, not when the browser asks for them.
  for (const img of document.querySelectorAll('.tile img')) img.loading = 'eager';
  await wait(() => [...document.querySelectorAll('.tile img')].every(i => i.complete), 20000);
  out.brokenImages = [...document.querySelectorAll('.tile img')].filter(i => i.naturalWidth === 0).length;
  return out;
})()`;

/**
 * Exercises the Durable Object directly over WebSockets, with no browser in the way.
 *
 * The browser test proves the UI wiring; this proves the room's rules and, crucially, that
 * rejections are enforced server-side rather than merely hidden by a disabled button.
 */
async function connectClient(roomKey: string, name: string) {
  const identity = await guestSession(name);
  return openSocket(roomKey, identity, name);
}

/** A guest identity, without a socket. What a browser stores in localStorage. */
async function guestSession(name: string): Promise<{ session: string; userId: string }> {
  const { session, user } = (await (
    await get(`${BASE_URL}/api/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  ).json()) as { session: string; user: { id: string } };

  return { session, userId: user.id };
}

/**
 * Reopens a socket with an identity the room already knows.
 *
 * This is what a browser refresh does: the session is in localStorage, so the same player comes
 * back to their own seat rather than arriving as a stranger.
 */
async function reconnectClient(roomKey: string, previous: RoomClientLike) {
  return openSocket(roomKey, { session: previous.session, userId: previous.userId }, previous.name);
}

async function openSocket(roomKey: string, identity: { session: string; userId: string }, name: string) {
  const { session } = identity;
  const room = encodeURIComponent(roomKey);
  const socket = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/api/ws?room=${room}&session=${session}`);
  const states: RoomStateLike[] = [];
  const errors: { code: string }[] = [];
  // Kept verbatim: the redaction checks assert on the bytes, not on a parsed view that might
  // quietly drop a field the server actually sent.
  const frames: string[] = [];

  socket.onmessage = (event) => {
    const raw = String(event.data);
    frames.push(raw);
    const message = JSON.parse(raw) as { type: 'state'; state: RoomStateLike } | { type: 'error'; code: string };
    if (message.type === 'state') states.push(message.state);
    if (message.type === 'error') errors.push({ code: message.code });
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error(`${name} could not open a socket`));
  });

  return {
    name,
    session,
    /** Server-issued, so tests assert against the identity the room actually saw. */
    userId: identity.userId,
    frames,
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    latest: () => states[states.length - 1],
    until: async (predicate: (state: RoomStateLike) => boolean, ms = 5_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const state = states[states.length - 1];
        if (state && predicate(state)) return state;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`${name}: state never satisfied the predicate`);
    },
    nextError: async (ms = 2_000) => {
      const before = errors.length;
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (errors.length > before) return errors[errors.length - 1];
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return null;
    },
  };
}

type RoomClientLike = Awaited<ReturnType<typeof openSocket>>;

async function checkRoomProtocol(): Promise<void> {
  const roomKey = `d:e2e-proto-${Date.now()}`;
  const connect = (name: string) => connectClient(roomKey, name);

  // A real room key, so this asserts the upgrade requirement rather than key validation —
  // malformed keys are covered in checkBrowserRooms.
  checkEqual(
    'a plain GET to the socket endpoint is refused',
    (await get(`${BASE_URL}/api/ws?room=${encodeURIComponent('d:whatever')}`)).status,
    426,
  );

  const alice = await connect('alice');
  await alice.until((state) => state.members.length === 1);
  checkEqual('first joiner is host', alice.latest()?.hostId, alice.userId);

  const bob = await connect('bob');
  await Promise.all([alice.until((s) => s.members.length === 2), bob.until((s) => s.members.length === 2)]);
  check('both clients see both members', true);

  alice.send({ type: 'setTeam', team: 'a' });
  await bob.until((state) => state.leaders.a === alice.userId);
  check('team change and leadership propagate', true);

  bob.send({ type: 'selectPack', packId: 'demo' });
  checkEqual('non-host pack change rejected by the server', (await bob.nextError())?.code, 'not_host');

  bob.send({ type: 'setTeam', team: 'b' });
  alice.send({ type: 'selectPack', packId: 'demo' });
  await bob.until((state) => state.packId === 'demo');

  alice.send({ type: 'startGame' });
  checkEqual('start refused while players are unready', (await alice.nextError())?.code, 'not_ready');

  alice.send({ type: 'setReady', ready: true });
  bob.send({ type: 'setReady', ready: true });
  await alice.until((state) => state.startBlockers.length === 0);

  bob.send({ type: 'startGame' });
  checkEqual('non-host start rejected by the server', (await bob.nextError())?.code, 'not_host');

  alice.send({ type: 'startGame' });
  await bob.until((state) => state.phase === 'in_progress');
  check('game start reaches every client', true);

  bob.send('not json at all');
  checkEqual('malformed frame rejected', (await bob.nextError())?.code, 'bad_message');
  checkEqual('room survives a malformed frame', alice.latest()?.phase, 'in_progress');

  // Mid-game departures are remembered so the player can come back to their team.
  bob.close();
  await alice.until((state) => state.members.find((m) => m.userId === bob.userId)?.connected === false);
  checkEqual('a departed player is kept mid-game', alice.latest()?.members.length, 2);

  // Reconnecting means presenting the same identity, which is what a stored session gives a
  // browser; here the socket is reopened with the id the room already knows.
  const bobAgain = await reconnectClient(roomKey, bob);
  const restored = await bobAgain.until((state) => state.you.userId === bob.userId && state.you.team === 'b');
  checkEqual('reconnect restores the team', restored.you.team, 'b');
  checkEqual('reconnect restores leadership', restored.leaders.b, bob.userId);
  checkEqual(
    'reconnect does not duplicate the player',
    restored.members.filter((m) => m.userId === bob.userId).length,
    1,
  );

  alice.close();
  bobAgain.close();
}

interface RoomStateLike {
  phase: string;
  hostId: string | null;
  packId: string | null;
  leaders: { a: string | null; b: string | null };
  members: { userId: string; team: string | null; connected: boolean; ready: boolean; kind: string }[];
  startBlockers: string[];
  you: { userId: string; team: string | null; isHost: boolean; isLeader: boolean };
  customPack: { token: string; name: string; characters: { id: string; name: string }[] } | null;
  game: {
    activeTeam: string;
    stage: string;
    flipped: Record<string, string[]>;
    yourSecret: string | null;
    reveal: Record<string, string> | null;
    log: { id: number; kind: string; askedBy: string; text: string; answer: string | null }[];
    guesses: { team: string; characterId: string; correct: boolean }[];
    canPlayOn: boolean;
    outcome: {
      winner: string | null;
      reason: string;
      guesses: { team: string; characterId: string; correct: boolean }[];
    } | null;
  } | null;
}

/**
 * Plays a whole game over WebSockets: deal, question, answer, turn swap, flips, guess, reveal,
 * rematch — plus the checks that matter most, which are about what each client is *not* sent.
 *
 * Four people, because the leaks only become visible with more than one player per team: a
 * teammate must not see their own leader's secret, and the opposing team must see neither the
 * secret nor which faces have been ruled out.
 */
async function checkGameProtocol(packId: string, characterIds: string[]): Promise<void> {
  const roomKey = `d:e2e-game-${Date.now()}`;
  const connect = (name: string) => connectClient(roomKey, name);

  const alice = await connect('alice'); // Red leader, and host
  const carol = await connect('carol'); // Red, not leader
  const bob = await connect('bob'); // Blue leader
  const erin = await connect('erin'); // Blue, not leader
  const dave = await connect('dave'); // spectator

  const everyone = [alice, carol, bob, erin, dave];
  await alice.until((state) => state.members.length === 5);

  alice.send({ type: 'setTeam', team: 'a' });
  carol.send({ type: 'setTeam', team: 'a' });
  bob.send({ type: 'setTeam', team: 'b' });
  erin.send({ type: 'setTeam', team: 'b' });
  await alice.until((state) => state.leaders.a === alice.userId && state.leaders.b === bob.userId);

  alice.send({ type: 'selectPack', packId });
  for (const player of [alice, carol, bob, erin]) player.send({ type: 'setReady', ready: true });
  await alice.until((state) => state.startBlockers.length === 0);

  // The two secrets are drawn independently, so both teams can be dealt the same character —
  // legitimate in play, but it would quietly gut the leak checks below, because Red's secret
  // appearing in Blue's frames would then be Blue's own. Re-deal until they differ so every
  // assertion stays unconditional rather than skipped one run in twenty-four.
  let redSecret: string | null | undefined;
  let blueSecret: string | null | undefined;

  for (let attempt = 0; attempt < 12; attempt++) {
    if (attempt === 0) {
      alice.send({ type: 'startGame' });
    } else {
      // Redealing means finishing the hand first — `playAgain` only exists at an endgame, and
      // ending it with a guess is the one move always available to the team on turn.
      alice.send({ type: 'submitGuess', characterId: characterIds[0] ?? '' });
      for (const client of everyone) await client.until((state) => state.phase === 'endgame');
      alice.send({ type: 'playAgain' });
    }

    for (const client of everyone) await client.until((state) => state.phase === 'in_progress');
    redSecret = alice.latest()?.game?.yourSecret;
    blueSecret = bob.latest()?.game?.yourSecret;
    if (redSecret !== blueSecret) break;
  }

  check('a spectator does not block the start', true);
  check('Red’s leader is told their character', typeof redSecret === 'string', redSecret);
  check('Blue’s leader is told their character', typeof blueSecret === 'string', blueSecret);
  check('the teams hold different characters, so the leak checks mean something', redSecret !== blueSecret);
  check('the dealt characters are on the board', characterIds.includes(redSecret ?? ''), redSecret);
  checkEqual('a teammate is not told the secret', carol.latest()?.game?.yourSecret, null);
  checkEqual('a spectator is not told either secret', dave.latest()?.game?.yourSecret, null);
  checkEqual('nothing is revealed while the game runs', alice.latest()?.game?.reveal, null);

  checkEqual('a player is sent only their own board', Object.keys(alice.latest()?.game?.flipped ?? {}), ['a']);
  checkEqual('a spectator is sent both boards', Object.keys(dave.latest()?.game?.flipped ?? {}).sort(), ['a', 'b']);

  // Turn order.
  checkEqual('Red opens', alice.latest()?.game?.activeTeam, 'a');
  carol.send({ type: 'askQuestion', text: 'Am I allowed to ask?' });
  checkEqual('a non-leader cannot ask', (await carol.nextError())?.code, 'not_leader');
  bob.send({ type: 'askQuestion', text: 'Can I ask out of turn?' });
  checkEqual('the waiting team cannot ask', (await bob.nextError())?.code, 'not_your_turn');

  // Passing: most questions get asked out loud, so a leader can hand the turn over untyped.
  alice.send({ type: 'passTurn' });
  await bob.until((state) => state.game?.activeTeam === 'b');
  checkEqual('passing is recorded in the log', alice.latest()?.game?.log[0]?.kind, 'pass');
  checkEqual('passing hands the turn over without a question', alice.latest()?.game?.stage, 'asking');
  bob.send({ type: 'passTurn' });
  await alice.until((state) => state.game?.activeTeam === 'a');
  check('the turn comes back after both pass', true);

  alice.send({ type: 'askQuestion', text: 'Do they wear glasses?' });
  await bob.until((state) => state.game?.stage === 'answering');
  // Indexes shift as passes land in the log, so the assertions look the entry up by kind.
  const lastQuestion = (client: RoomClientLike) =>
    [...(client.latest()?.game?.log ?? [])].reverse().find((entry) => entry.kind === 'question');
  const logLength = (client: RoomClientLike) => client.latest()?.game?.log.length ?? 0;

  checkEqual('the question reaches the other team', lastQuestion(bob)?.text, 'Do they wear glasses?');
  checkEqual('the whole log is public to spectators', logLength(dave), 3);

  alice.send({ type: 'answerQuestion', answer: 'yes' });
  checkEqual('you cannot answer your own question', (await alice.nextError())?.code, 'not_your_question');
  carol.send({ type: 'answerQuestion', answer: 'yes' });
  checkEqual('the asking team cannot answer itself', (await carol.nextError())?.code, 'not_your_question');
  erin.send({ type: 'answerQuestion', answer: 'yes' });
  checkEqual('a non-leader cannot answer', (await erin.nextError())?.code, 'not_leader');

  bob.send({ type: 'answerQuestion', answer: 'no' });
  await alice.until((state) => state.game?.activeTeam === 'b');
  checkEqual('the answer is logged', lastQuestion(alice)?.answer, 'no');
  checkEqual('answering passes the turn', alice.latest()?.game?.stage, 'asking');

  // Flips are shared within a team and invisible outside it. Pick faces that are nobody's
  // secret, so a leak can't be mistaken for a legitimately revealed character.
  const spare = characterIds.filter((id) => id !== redSecret && id !== blueSecret);
  const [redFlip, blueFlip] = [spare[0] ?? '', spare[1] ?? ''];

  carol.send({ type: 'flipTile', characterId: redFlip, down: true });
  await alice.until((state) => (state.game?.flipped['a'] ?? []).includes(redFlip));
  check('a teammate’s flip reaches the rest of the team', true);

  bob.send({ type: 'flipTile', characterId: blueFlip, down: true });
  await dave.until((state) => (state.game?.flipped['b'] ?? []).includes(blueFlip));
  checkEqual('the opposing team is not sent that flip', alice.latest()?.game?.flipped['b'], undefined);

  bob.send({ type: 'flipTile', characterId: 'not-a-real-character', down: true });
  checkEqual('a flip of an unknown character is refused', (await bob.nextError())?.code, 'no_such_character');

  // How much each client had received before the reveal. Everything after it legitimately
  // contains both secrets and both boards, so the leak checks must stop here.
  const framesBeforeReveal = Object.fromEntries(everyone.map((client) => [client.name, client.frames.length]));

  // Blue is on turn and guesses wrong, which hands the game to Red.
  const wrongGuess = characterIds.find((id) => id !== redSecret) ?? '';
  bob.send({ type: 'submitGuess', characterId: wrongGuess });
  for (const client of everyone) await client.until((state) => state.phase === 'endgame');

  checkEqual('a wrong guess gives the game to the other team', alice.latest()?.game?.outcome?.winner, 'a');
  checkEqual('the outcome says why', alice.latest()?.game?.outcome?.reason, 'wrong_guess');
  checkEqual('the guess is recorded for everyone to see', alice.latest()?.game?.outcome?.guesses.length, 1);
  check('the team that never guessed can be sent back in', alice.latest()?.game?.canPlayOn === true);
  for (const client of everyone) {
    checkEqual(`${client.name} sees both characters revealed`, client.latest()?.game?.reveal, {
      a: redSecret,
      b: blueSecret,
    });
  }

  // The check this whole design exists for. Ids are matched quoted, so "sam" can't be reported
  // as leaked because the frame happened to contain "sam-2".
  const leaked = (client: RoomClientLike, id: string | null | undefined) =>
    client.frames
      .slice(0, framesBeforeReveal[client.name] ?? 0)
      .some((frame) => frame.includes(`"${id ?? '(none)'}"`));

  check('Red’s secret never reached the opposing leader before the reveal', !leaked(bob, redSecret));
  check('Red’s secret never reached Red’s own non-leader', !leaked(carol, redSecret));
  check('Blue’s secret never reached Blue’s own non-leader', !leaked(erin, blueSecret));
  check(
    'neither secret ever reached a spectator before the reveal',
    !leaked(dave, redSecret) && !leaked(dave, blueSecret),
  );
  check('Red’s ruled-out tiles never reached the opposing team', !leaked(bob, redFlip) && !leaked(erin, redFlip));
  check('Blue’s ruled-out tiles never reached Red', !leaked(alice, blueFlip) && !leaked(carol, blueFlip));

  alice.send({ type: 'askQuestion', text: 'One more?' });
  checkEqual('a finished game accepts no more moves', (await alice.nextError())?.code, 'game_over');

  // Red never had its guess, so the host can send everyone back in for it.
  bob.send({ type: 'playOn' });
  checkEqual('only the host can reopen the game', (await bob.nextError())?.code, 'not_host');

  alice.send({ type: 'playOn' });
  for (const client of everyone) await client.until((state) => state.phase === 'in_progress');
  checkEqual('the finishing team is put on turn', alice.latest()?.game?.activeTeam, 'a');
  checkEqual('the provisional result is cleared', alice.latest()?.game?.outcome, null);
  checkEqual('the question log survives the reopen', logLength(alice), 3);
  checkEqual('Red’s board survives the reopen', alice.latest()?.game?.flipped['a'], [redFlip]);
  checkEqual('the leader still holds their character', alice.latest()?.game?.yourSecret, redSecret);

  bob.send({ type: 'askQuestion', text: 'Can I keep playing?' });
  checkEqual('a team that already guessed cannot ask', (await bob.nextError())?.code, 'not_your_turn');
  bob.send({ type: 'submitGuess', characterId: blueSecret ?? '' });
  checkEqual('a team that already guessed cannot guess again', (await bob.nextError())?.code, 'not_your_turn');

  // Blue still answers, because Blue holds the character Red is hunting.
  alice.send({ type: 'askQuestion', text: 'Do they have a hat?' });
  await bob.until((state) => state.game?.stage === 'answering');
  bob.send({ type: 'answerQuestion', answer: 'yes' });
  await alice.until((state) => state.game?.stage === 'asking');
  checkEqual('the turn does not pass back to the finished team', alice.latest()?.game?.activeTeam, 'a');

  alice.send({ type: 'submitGuess', characterId: blueSecret ?? '' });
  for (const client of everyone) await client.until((state) => state.phase === 'endgame');
  checkEqual('finishing correctly takes the win', alice.latest()?.game?.outcome?.winner, 'a');
  checkEqual('both guesses are on the record', alice.latest()?.game?.outcome?.guesses.length, 2);
  checkEqual('the game cannot be reopened twice', alice.latest()?.game?.canPlayOn, false);

  alice.send({ type: 'playOn' });
  checkEqual('reopening is refused once both teams have guessed', (await alice.nextError())?.code, 'nothing_to_finish');

  // Straight into another game: same teams, same board, nobody has to ready up again.
  bob.send({ type: 'playAgain' });
  checkEqual('only the host can start another game', (await bob.nextError())?.code, 'not_host');

  alice.send({ type: 'playAgain' });
  for (const client of everyone) await client.until((state) => state.phase === 'in_progress');
  checkEqual('play again deals a fresh game', alice.latest()?.game?.log.length, 0);
  checkEqual('play again clears the guesses', alice.latest()?.game?.guesses.length, 0);
  checkEqual('play again clears the boards', alice.latest()?.game?.flipped['a'], []);
  // The board itself is never sent to clients, so the pack is what there is to check.
  checkEqual('play again keeps the same pack', alice.latest()?.packId, packId);
  checkEqual('play again keeps the leaders', alice.latest()?.leaders.a, alice.userId);
  check('play again deals a character again', typeof alice.latest()?.game?.yourSecret === 'string');

  // Finish the second game so the rematch path can be exercised from a real endgame.
  alice.send({ type: 'submitGuess', characterId: alice.latest()?.game?.yourSecret ?? '' });
  await alice.until((state) => state.phase === 'endgame');

  bob.send({ type: 'rematch' });
  checkEqual('only the host can call a rematch', (await bob.nextError())?.code, 'not_host');

  alice.send({ type: 'rematch' });
  await carol.until((state) => state.phase === 'lobby');
  checkEqual('a rematch keeps the teams', carol.latest()?.members.find((m) => m.userId === carol.userId)?.team, 'a');
  checkEqual('a rematch keeps the leaders', carol.latest()?.leaders.b, bob.userId);
  checkEqual('a rematch clears the game', carol.latest()?.game, null);
  check(
    'a rematch clears readiness',
    (carol.latest()?.members ?? []).every((member) => !member.ready),
  );

  for (const client of everyone) client.close();
}

interface LobbyReport {
  aliceSeesMembers: number;
  bobSeesMembers: number;
  bobSeesAliceOnRed: boolean;
  aliceLeadsRed: boolean;
  aliceSeesBobOnBlue: boolean;
  bobSeesPack: boolean;
  startDisabledBeforeReady: boolean;
  bobHasNoStart: boolean;
  startEnabledAfterReady: boolean;
  bobLeftLobby: boolean;
}

/** Helpers injected into each page: find controls by their visible text. */
const PAGE_HELPERS = `
  const wait = async (test, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = test(); if (v) return v; await new Promise(r => setTimeout(r, 50)); }
    throw new Error('timed out: ' + test.toString().slice(0, 120));
  };
  const byText = (selector, text, root = document) =>
    [...root.querySelectorAll(selector)].find(el => el.textContent.trim() === text);
  const teamPanel = (team) => document.querySelector('.team-' + team);
  const namesIn = (team) => [...(teamPanel(team)?.querySelectorAll('.person-name') ?? [])].map(el => el.textContent);
  const memberCount = () => document.querySelectorAll('.person').length;
`;

interface OpenRoomReport {
  sawLanding: boolean;
  code: string;
  url: string;
  headerCode: string;
}

/**
 * The front door, driven the way a first-time visitor meets it: land on the site, give a name,
 * open a room. What comes back is the code the second player will be sent.
 */
async function runOpenRoomFlow(page: Awaited<ReturnType<typeof openPage>>): Promise<OpenRoomReport> {
  const evalOn = <T,>(body: string) => page.evaluate<T>(`(async () => { ${PAGE_HELPERS} ${body} })()`);

  const sawLanding = await evalOn<boolean>(
    `await wait(() => byText('button', 'Start a new room'));
     // ?name= prefills, so the form is ready to submit without typing.
     return document.querySelector('.field input').value === 'alice';`,
  );

  await evalOn<boolean>(`byText('button', 'Start a new room').click(); return true;`);

  const opened = await evalOn<{ code: string; url: string; headerCode: string }>(
    `await wait(() => document.querySelector('.teams'), 20000);
     const chip = await wait(() => document.querySelector('.chip.is-code .room-code'));
     return {
       code: chip.textContent.trim(),
       url: location.pathname,
       headerCode: chip.textContent.trim(),
     };`,
  );

  return { sawLanding, ...opened };
}

async function runLobbyFlow(
  alice: Awaited<ReturnType<typeof openPage>>,
  bob: Awaited<ReturnType<typeof openPage>>,
): Promise<LobbyReport> {
  const evalOn = <T,>(page: typeof alice, body: string) =>
    page.evaluate<T>(`(async () => { ${PAGE_HELPERS} ${body} })()`);

  // Both must reach the lobby before anything is clicked.
  await evalOn<boolean>(alice, `await wait(() => document.querySelector('.teams')); return true;`);
  await evalOn<boolean>(bob, `await wait(() => document.querySelector('.teams')); return true;`);

  const report = {} as LobbyReport;
  report.aliceSeesMembers = await evalOn<number>(alice, `await wait(() => memberCount() === 2); return memberCount();`);
  report.bobSeesMembers = await evalOn<number>(bob, `await wait(() => memberCount() === 2); return memberCount();`);

  // alice joins Red...
  await evalOn<boolean>(alice, `byText('button', 'Join', teamPanel('a')).click(); return true;`);
  // ...and bob's screen must show it without a reload.
  report.bobSeesAliceOnRed = await evalOn<boolean>(
    bob,
    `await wait(() => namesIn('a').some(n => n.includes('alice'))); return true;`,
  );
  report.aliceLeadsRed = await evalOn<boolean>(
    alice,
    `await wait(() => teamPanel('a').querySelector('.tag.is-leader')); return true;`,
  );

  await evalOn<boolean>(bob, `byText('button', 'Join', teamPanel('b')).click(); return true;`);
  report.aliceSeesBobOnBlue = await evalOn<boolean>(
    alice,
    `await wait(() => namesIn('b').some(n => n.includes('bob'))); return true;`,
  );

  // Only the host sees pack chips; bob should just be told which pack was picked.
  await evalOn<boolean>(alice, `await wait(() => document.querySelector('.pack-switcher .chip')).then(c => c.click()); return true;`);
  report.bobSeesPack = await evalOn<boolean>(
    bob,
    `await wait(() => /chosen by the host/.test(document.body.textContent)); return true;`,
  );

  report.bobHasNoStart = await evalOn<boolean>(bob, `return !byText('button', 'Start game');`);
  report.startDisabledBeforeReady = await evalOn<boolean>(
    alice,
    `await wait(() => byText('button', 'Start game')); return byText('button', 'Start game').disabled;`,
  );

  await evalOn<boolean>(alice, `byText('button', "I'm ready").click(); return true;`);
  await evalOn<boolean>(bob, `await wait(() => byText('button', "I'm ready")).then(b => b.click()); return true;`);

  report.startEnabledAfterReady = await evalOn<boolean>(
    alice,
    `await wait(() => !byText('button', 'Start game').disabled); return true;`,
  );

  await evalOn<boolean>(alice, `byText('button', 'Start game').click(); return true;`);
  report.bobLeftLobby = await evalOn<boolean>(
    bob,
    `await wait(() => !document.querySelector('.teams')); return true;`,
  );

  // The board only exists once the game is running.
  await evalOn<boolean>(alice, `await wait(() => document.querySelectorAll('.tile').length > 0); return true;`);
  return report;
}

/**
 * Opens a socket and reports whether the room turned it away.
 *
 * The Worker answers a refusal with an ordinary HTTP response instead of completing the upgrade,
 * which a WebSocket client can only observe as "it did not open".
 */
async function socketRefused(roomKey: string, session: string): Promise<boolean> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${SERVER_PORT}/api/ws?room=${encodeURIComponent(roomKey)}&session=${encodeURIComponent(session)}`,
  );

  return new Promise<boolean>((resolve) => {
    const settle = (refused: boolean) => {
      socket.onopen = socket.onerror = socket.onclose = null;
      if (!refused) socket.close();
      resolve(refused);
    };
    socket.onopen = () => settle(false);
    socket.onerror = () => settle(true);
    socket.onclose = () => settle(true);
    setTimeout(() => settle(false), 4000);
  });
}

/**
 * Rooms reached by a code rather than by a Discord activity.
 *
 * The addressing is the whole feature here: a code has to open the room it names, a code nobody
 * opened has to be refused rather than quietly conjured into existence, and the two namespaces
 * must not overlap.
 */
async function checkBrowserRooms(): Promise<void> {
  const host = await guestSession('alice');

  checkEqual(
    'a nameless guest is refused',
    (
      await get(`${BASE_URL}/api/guest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      })
    ).status,
    400,
  );
  checkEqual(
    'creating a room needs a session',
    (await get(`${BASE_URL}/api/rooms`, { method: 'POST' })).status,
    401,
  );

  const created = await get(`${BASE_URL}/api/rooms?session=${encodeURIComponent(host.session)}`, {
    method: 'POST',
  });
  checkEqual('a room is created', created.status, 200);
  const { code } = (await created.json()) as { code: string };
  check('the code is six unambiguous characters', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code), code);

  // An unopened code must not become a room just because somebody typed it. Probed with a real
  // socket: Node's fetch refuses to send the upgrade headers, so an HTTP probe cannot get here.
  check('an unopened code is not a room', await socketRefused('c:ZZZZZZ', host.session));

  for (const bad of ['c:abc', 'c:ABCDE0', 'nonsense', '']) {
    const response = await get(
      `${BASE_URL}/api/ws?room=${encodeURIComponent(bad)}&session=${encodeURIComponent(host.session)}`,
    );
    checkEqual(`a malformed room key is refused (${bad || 'empty'})`, response.status, 400);
  }

  const roomKey = `c:${code}`;
  const alice = await openSocket(roomKey, host, 'alice');
  const bob = await connectClient(roomKey, 'bob');
  await alice.until((state) => state.members.length === 2);
  check('two browsers reach the same room by code', true);
  checkEqual('the room creator is the host', alice.latest()?.hostId, alice.userId);
  checkEqual('guests are marked as guests', alice.latest()?.members[0]?.kind, 'guest');

  // A Discord instance that happens to spell a code must not share its room.
  const namesake = await connectClient(`d:${code}`, 'stranger');
  await namesake.until((state) => state.members.length === 1);
  checkEqual('the two addressing spaces do not overlap', namesake.latest()?.members.length, 1);
  namesake.close();

  // Once a game is running, a code in the wrong hands must not put someone in the middle of it.
  alice.send({ type: 'setTeam', team: 'a' });
  bob.send({ type: 'setTeam', team: 'b' });
  alice.send({ type: 'selectPack', packId: 'demo' });
  alice.send({ type: 'setReady', ready: true });
  bob.send({ type: 'setReady', ready: true });
  await alice.until((state) => state.startBlockers.length === 0);
  alice.send({ type: 'startGame' });
  await alice.until((state) => state.phase === 'in_progress');

  const latecomer = await guestSession('gatecrasher');
  check('a stranger cannot walk into a running game', await socketRefused(roomKey, latecomer.session));

  // ...but the people already playing can always come back.
  bob.close();
  await alice.until((state) => state.members.some((m) => m.userId === bob.userId && !m.connected));
  const bobAgain = await reconnectClient(roomKey, bob);
  const restored = await bobAgain.until((state) => state.you.userId === bob.userId);
  checkEqual('a player who was already in can rejoin mid-game', restored.you.team, 'b');

  alice.close();
  bobAgain.close();
}

/**
 * A game that loses a whole team.
 *
 * Its own room, because it ends with players gone and would poison any assertion made after it.
 * Without this the room would sit in `in_progress` forever, waiting for a turn nobody connected
 * can take.
 */
async function checkAbandonedGame(packId: string): Promise<void> {
  const roomKey = `d:e2e-abandon-${Date.now()}`;
  const alice = await connectClient(roomKey, 'alice'); // host, Red
  const bob = await connectClient(roomKey, 'bob'); // Blue, on their own

  await alice.until((state) => state.members.length === 2);
  alice.send({ type: 'setTeam', team: 'a' });
  bob.send({ type: 'setTeam', team: 'b' });
  alice.send({ type: 'selectPack', packId });
  alice.send({ type: 'setReady', ready: true });
  bob.send({ type: 'setReady', ready: true });
  await alice.until((state) => state.startBlockers.length === 0);

  alice.send({ type: 'startGame' });
  await alice.until((state) => state.phase === 'in_progress');

  bob.close();
  await alice.until((state) => state.phase === 'endgame');
  checkEqual('losing a whole team ends the game', alice.latest()?.game?.outcome?.reason, 'abandoned');
  checkEqual('the team still standing takes it', alice.latest()?.game?.outcome?.winner, 'a');
  checkEqual('there is nobody to hand a turn back to', alice.latest()?.game?.canPlayOn, false);

  alice.send({ type: 'playOn' });
  checkEqual('an abandoned game has no turn to finish', (await alice.nextError())?.code, 'nothing_to_finish');
  alice.send({ type: 'playAgain' });
  checkEqual('another game is refused with a team missing', (await alice.nextError())?.code, 'team_empty');

  // The room is still usable: back to the lobby and the survivors can regroup.
  alice.send({ type: 'rematch' });
  await alice.until((state) => state.phase === 'lobby');
  check('the room survives a walkout', alice.latest()?.game === null);

  alice.close();
}

/**
 * Uploads a board of generated photos the way the browser does, then plays with it.
 *
 * Custom packs are the one path where the room stores bytes rather than reading them off the
 * asset layer, so this covers what unit tests can't reach: that the Worker routes the upload to
 * the right room, that the photos come back over HTTP, and that a game can actually be dealt
 * from a board that exists only in Durable Object storage.
 */
async function checkCustomPack(): Promise<void> {
  const sharp = (await import('sharp')).default;
  const roomKey = `d:e2e-custom-${Date.now()}`;
  const alice = await connectClient(roomKey, 'alice'); // host
  const bob = await connectClient(roomKey, 'bob');
  await alice.until((state) => state.members.length === 2);

  const [aliceSession, bobSession] = [alice.session, bob.session];
  const base = `${BASE_URL}/api/pack/${encodeURIComponent(roomKey)}`;
  const post = (url: string, init: RequestInit = {}) => get(url, { method: 'POST', ...init });

  const refused = await post(`${base}/begin?session=${bobSession}`, { body: '{}' });
  checkEqual('a non-host cannot start an upload', refused.status, 403);

  const begun = await post(`${base}/begin?session=${aliceSession}`, { body: JSON.stringify({ name: 'Party' }) });
  checkEqual('the host can start an upload', begun.status, 200);
  const { token } = (await begun.json()) as { token: string };
  check('the upload gets an unguessable token', /^[0-9a-f]{32}$/.test(token), token);

  // Ten distinct 8x8 WebPs — enough to be a legal board, small enough to be instant.
  const names = ['Ada', 'Bram', 'Cleo', 'Dev', 'Elif', 'Fionn', 'Greta', 'Hugo', 'Ines', 'Jonas'];
  const photos = await Promise.all(
    names.map((_, index) =>
      sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: index * 20, g: 80, b: 200 - index * 15 } },
      })
        .webp()
        .toBuffer(),
    ),
  );

  const characters = names.map((name) => ({ id: name.toLowerCase(), name }));

  const tooBig = await post(`${base}/${token}/add?file=huge.webp&session=${aliceSession}`, {
    body: Buffer.alloc(200 * 1024),
    headers: { 'content-type': 'image/webp' },
  });
  checkEqual('an oversized photo is refused', tooBig.status, 413);

  const traversal = await post(`${base}/${token}/add?file=../room&session=${aliceSession}`, {
    body: photos[0] as Buffer,
    headers: { 'content-type': 'image/webp' },
  });
  checkEqual('a photo cannot be written outside its pack', traversal.status, 400);

  let uploaded = 0;
  for (const [index, character] of characters.entries()) {
    for (const file of [`${character.id}.webp`, `${character.id}%40full.webp`]) {
      const response = await post(`${base}/${token}/add?file=${file}&session=${aliceSession}`, {
        body: photos[index] as Buffer,
        headers: { 'content-type': 'image/webp' },
      });
      if (response.ok) uploaded++;
    }
  }
  checkEqual('every photo uploads', uploaded, characters.length * 2);

  const short = await post(`${base}/${token}/commit?session=${aliceSession}`, {
    body: JSON.stringify({ characters: characters.slice(0, 3) }),
  });
  checkEqual('a board below the minimum is refused', short.status, 400);

  const committed = await post(`${base}/${token}/commit?session=${aliceSession}`, {
    body: JSON.stringify({ characters }),
  });
  checkEqual('the board commits', committed.status, 200);

  // Committing publishes the board itself — no selectPack needed.
  const published = await bob.until((state) => state.packId === 'custom');
  checkEqual('the uploaded board reaches everyone', published.customPack?.characters.length, characters.length);
  checkEqual('the board keeps its name', published.customPack?.name, 'Party');
  checkEqual('filenames become character names', published.customPack?.characters[0]?.name, 'Ada');

  const photo = await get(`${base}/${token}/ada.webp`);
  checkEqual('a photo is served back', photo.status, 200);
  checkEqual('a photo is served as webp', photo.headers.get('content-type'), 'image/webp');
  check('a photo is cached hard', (photo.headers.get('cache-control') ?? '').includes('immutable'));

  const wrongToken = await get(`${base}/${'0'.repeat(32)}/ada.webp`);
  checkEqual('photos are not reachable without the token', wrongToken.status, 404);
  checkEqual('an unknown photo 404s', (await get(`${base}/${token}/nobody.webp`)).status, 404);

  // A board that exists only in room storage still deals a game.
  alice.send({ type: 'setTeam', team: 'a' });
  bob.send({ type: 'setTeam', team: 'b' });
  alice.send({ type: 'setReady', ready: true });
  bob.send({ type: 'setReady', ready: true });
  await alice.until((state) => state.startBlockers.length === 0);

  alice.send({ type: 'startGame' });
  await alice.until((state) => state.phase === 'in_progress');
  const secret = alice.latest()?.game?.yourSecret ?? '';
  check(
    'the game is dealt from the uploaded board',
    characters.some((character) => character.id === secret),
    secret,
  );

  alice.close();
  bob.close();
}

interface GameUiReport {
  aliceSeesSecret: boolean;
  bobSeesSecret: boolean;
  aliceSecretIsHers: boolean;
  bobWaitsForRed: boolean;
  passHandsOver: boolean;
  bobGetsTheQuestion: boolean;
  aliceSeesAnswer: string;
  turnPassedToBlue: boolean;
  aliceHasNoAskBox: boolean;
  confirmAppears: boolean;
  aliceSeesResult: string;
  bobSeesResult: string;
  bothRevealed: boolean;
  playOnOffered: boolean;
  redGetsTheTurnBack: boolean;
  blueIsAnsweringOnly: boolean;
  finalResult: string;
  playOnGoneAfterBoth: boolean;
  playAgainRestarts: boolean;
  rematchReturnsToLobby: boolean;
}

/**
 * A whole game through the UI: Red asks, Blue answers, the turn passes, Blue names a character
 * and the room lands on a result both players can see.
 *
 * The rules already have unit and over-the-wire coverage; what this adds is that the screens are
 * actually wired to them — a leader who can't find the Ask box has the same effect as a broken
 * state machine.
 */
async function runGameFlow(
  alice: Awaited<ReturnType<typeof openPage>>,
  bob: Awaited<ReturnType<typeof openPage>>,
): Promise<GameUiReport> {
  const evalOn = <T,>(page: typeof alice, body: string) =>
    page.evaluate<T>(`(async () => { ${PAGE_HELPERS} ${GAME_HELPERS} ${body} })()`);

  const report = {} as GameUiReport;

  // Each leader is shown one character, and it is not the other's.
  const aliceSecret = await evalOn<string>(alice, `await wait(() => secretName()); return secretName();`);
  const bobSecret = await evalOn<string>(bob, `await wait(() => secretName()); return secretName();`);
  report.aliceSeesSecret = Boolean(aliceSecret);
  // Not "and a different one": the deal is independent per team, so both leaders holding the
  // same character is a legal hand rather than a bug.
  report.bobSeesSecret = Boolean(bobSecret);
  // The badge on the board must agree with the card, or a leader is hunting the wrong face.
  report.aliceSecretIsHers = await evalOn<boolean>(
    alice,
    `const marked = [...document.querySelectorAll('.tile.is-marked .tile-name')].map(n => n.textContent);
     return marked.length === 1 && marked[0] === secretName();`,
  );

  report.bobWaitsForRed = await evalOn<boolean>(bob, `return !document.querySelector('.ask input');`);

  // Passing: the question was asked out loud, so the turn goes over untyped and comes back.
  await evalOn<boolean>(alice, `byText('.actions button', 'Pass').click(); return true;`);
  report.passHandsOver = await evalOn<boolean>(
    bob,
    `await wait(() => document.querySelector('.ask input'));
     return /passed/.test(document.body.textContent);`,
  );
  await evalOn<boolean>(bob, `byText('.actions button', 'Pass').click(); return true;`);
  await evalOn<boolean>(alice, `await wait(() => document.querySelector('.ask input')); return true;`);

  await evalOn<boolean>(
    alice,
    `const box = await wait(() => document.querySelector('.ask input'));
     setValue(box, 'Do they wear glasses?');
     byText('button', 'Ask').click();
     return true;`,
  );

  report.bobGetsTheQuestion = await evalOn<boolean>(
    bob,
    `await wait(() => document.querySelector('.answer-buttons'));
     return /Do they wear glasses\\?/.test(document.body.textContent);`,
  );

  await evalOn<boolean>(bob, `byText('.answer-buttons button', 'Yes').click(); return true;`);

  report.aliceSeesAnswer = await evalOn<string>(
    alice,
    `const el = await wait(() => document.querySelector('.log-answer.is-yes')); return el.textContent.trim();`,
  );
  report.turnPassedToBlue = await evalOn<boolean>(
    bob,
    `await wait(() => document.querySelector('.ask input')); return true;`,
  );
  report.aliceHasNoAskBox = await evalOn<boolean>(alice, `return !document.querySelector('.ask input');`);

  // Blue names a character. Whether it happens to be right doesn't matter — either way the
  // game ends and both screens must land on the same result.
  await evalOn<boolean>(bob, `byText('.actions button', 'Guess their character').click(); return true;`);
  report.confirmAppears = await evalOn<boolean>(
    bob,
    `await wait(() => document.querySelector('.board.is-guessing'));
     document.querySelectorAll('.tile')[3].click();
     await wait(() => document.querySelector('.confirm'));
     return true;`,
  );
  await evalOn<boolean>(bob, `byText('.confirm button', "Yes, that's them").click(); return true;`);

  report.bobSeesResult = await evalOn<string>(
    bob,
    `const el = await wait(() => document.querySelector('.result h2')); return el.textContent.trim();`,
  );
  report.aliceSeesResult = await evalOn<string>(
    alice,
    `const el = await wait(() => document.querySelector('.result h2')); return el.textContent.trim();`,
  );
  // Both characters are named on the board once there is nothing left to protect. Checked by
  // label rather than by counting tiles: both teams can be dealt the same face, which marks one
  // tile for two teams.
  report.bothRevealed = await evalOn<boolean>(
    bob,
    `await wait(() => {
       const labels = [...document.querySelectorAll('.tile.is-marked .tile-mark')].map(el => el.textContent).join(' ');
       return labels.includes('Red') && labels.includes('Blue');
     });
     return true;`,
  );

  // Blue guessed, so Red never had its attempt. The host can send everyone back in for it.
  report.playOnOffered = await evalOn<boolean>(alice, `return !!byText('.play-on button', 'Let Red finish');`);
  await evalOn<boolean>(alice, `byText('.play-on button', 'Let Red finish').click(); return true;`);

  report.redGetsTheTurnBack = await evalOn<boolean>(
    alice,
    `await wait(() => document.querySelector('.ask input')); return !document.querySelector('.result');`,
  );
  // Blue is out of the running but still holds the character Red is hunting, so it answers.
  report.blueIsAnsweringOnly = await evalOn<boolean>(
    bob,
    `await wait(() => /answering only/.test(document.body.textContent));
     return !document.querySelector('.ask input');`,
  );

  await evalOn<boolean>(
    alice,
    `byText('.actions button', 'Guess their character').click();
     await wait(() => document.querySelector('.board.is-guessing'));
     document.querySelectorAll('.tile')[7].click();
     await wait(() => document.querySelector('.confirm'));
     byText('.confirm button', "Yes, that's them").click();
     return true;`,
  );

  report.finalResult = await evalOn<string>(
    bob,
    `const el = await wait(() => document.querySelector('.result h2')); return el.textContent.trim();`,
  );
  report.playOnGoneAfterBoth = await evalOn<boolean>(
    alice,
    `await wait(() => document.querySelector('.result'));
     return document.querySelectorAll('.guess').length === 2 && !document.querySelector('.play-on');`,
  );

  // Play again skips the lobby entirely: same teams, fresh characters.
  await evalOn<boolean>(alice, `byText('button', 'Play again').click(); return true;`);
  report.playAgainRestarts = await evalOn<boolean>(
    bob,
    `await wait(() => !document.querySelector('.result') && document.querySelectorAll('.tile').length > 0);
     return !document.querySelector('.teams') && document.querySelectorAll('.log-entry').length === 0;`,
  );

  // End this one too, so the room is back in the lobby for the sections that follow.
  await evalOn<boolean>(
    alice,
    `byText('.actions button', 'Guess their character').click();
     await wait(() => document.querySelector('.board.is-guessing'));
     document.querySelectorAll('.tile')[1].click();
     await wait(() => document.querySelector('.confirm'));
     byText('.confirm button', "Yes, that's them").click();
     await wait(() => byText('button', 'Back to the lobby')).then(b => b.click());
     return true;`,
  );
  report.rematchReturnsToLobby = await evalOn<boolean>(
    bob,
    `await wait(() => document.querySelector('.teams')); return true;`,
  );

  return report;
}

interface LeaveReport {
  exitScreen: boolean;
  gameEndedForTheOthers: boolean;
}

/**
 * The header's Leave button, and what it does to a game in progress.
 *
 * Runs last because it takes a player out for good. Outside Discord there is no frame to close,
 * so the app has to show its own exit screen rather than assuming it has gone; inside Discord
 * the same click closes the activity.
 */
async function runLeaveFlow(
  leaver: Awaited<ReturnType<typeof openPage>>,
  staying: Awaited<ReturnType<typeof openPage>>,
): Promise<LeaveReport> {
  const evalOn = <T,>(target: typeof leaver, body: string) =>
    target.evaluate<T>(`(async () => { ${PAGE_HELPERS} ${body} })()`);

  const exitScreen = await evalOn<boolean>(
    leaver,
    `byText('header button', 'Leave').click();
     await wait(() => /You left the game/.test(document.body.textContent));
     return !!byText('button', 'Rejoin');`,
  );

  // The leaver was the last player on their side, so the game cannot go on.
  const gameEndedForTheOthers = await evalOn<boolean>(
    staying,
    `const result = await wait(() => document.querySelector('.result h2'), 15000);
     return /wins|draw/i.test(result.textContent);`,
  );

  return { exitScreen, gameEndedForTheOthers };
}

/**
 * Writes photos for the picker to pick.
 *
 * JPEGs at an awkward non-square size, so the client's centre-crop and re-encode have real work
 * to do. Half of them are gaussian noise: that is the worst case any lossy encoder can be handed,
 * and it is what forces the quality-and-downscale ladder in customPack.ts to actually run. A flat
 * colour would compress to nothing and prove only that the happy path works.
 */
async function writeTestPhotos(directory: string, names: string[]): Promise<string[]> {
  const sharp = (await import('sharp')).default;

  return Promise.all(
    names.map(async (name, index) => {
      const file = path.join(directory, `${name}.jpg`);
      const noise = { type: 'gaussian' as const, mean: 128, sigma: 90 };
      const black = { r: 0, g: 0, b: 0 };

      // The first photo is noise at the tile's own resolution, so the crop is roughly 1:1 and
      // none of the grain averages away on the way down — the case that actually needs the
      // quality-and-downscale ladder. Larger noise sources soften as they shrink.
      const create =
        index === 0
          ? { width: 520, height: 512, channels: 3 as const, background: black, noise }
          : index % 2 === 0
            ? { width: 900, height: 600, channels: 3 as const, background: black, noise }
            : {
                width: 900,
                height: 600,
                channels: 3 as const,
                background: { r: 30 + index * 20, g: 120, b: 220 - index * 18 },
              };

      await sharp({ create }).jpeg({ quality: 100 }).toFile(file);
      return file;
    }),
  );
}

interface CustomUiReport {
  chipCount: number;
  packName: string;
  tileNames: string[];
  brokenImages: number;
  largestPhotoBytes: number;
}

/**
 * Drives the host's file picker with real photos on disk.
 *
 * This is the only coverage of client/src/customPack.ts — the resize-and-encode path that turns
 * a picked JPEG into the WebP the room stores. The HTTP-level test uploads bytes that sharp
 * produced, which proves the room but not the browser half; here Chrome does the encoding, so a
 * broken canvas step or a wrong file name shows up as a board that never appears.
 */
async function runCustomPackUpload(
  page: Awaited<ReturnType<typeof openPage>>,
  other: Awaited<ReturnType<typeof openPage>>,
  files: string[],
): Promise<CustomUiReport> {
  const evalOn = <T,>(body: string) => page.evaluate<T>(`(async () => { ${PAGE_HELPERS} ${body} })()`);

  await page.call('DOM.enable', {});
  const document = (await page.call('DOM.getDocument', { depth: 0 })).result as { root: { nodeId: number } };
  const input = (await page.call('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: 'input[type="file"]',
  })).result as { nodeId: number };
  if (!input?.nodeId) throw new Error('no file input on the page — is the host seeing the pack picker?');

  await page.call('DOM.setFileInputFiles', { nodeId: input.nodeId, files });

  await evalOn<boolean>(`${AWAIT_UPLOAD} return true;`);

  // Publishing a new board clears everyone's readiness, so both players confirm again.
  await other.evaluate<boolean>(
    `(async () => { ${PAGE_HELPERS} await wait(() => byText('button', "I'm ready")).then(b => b.click()); return true; })()`,
  );

  return evalOn<CustomUiReport>(
    `const active = document.querySelector('.chip.is-active');
     // The board only renders once the game starts, so read the picker and then start one.
     const report = {
       chipCount: document.querySelectorAll('.pack-switcher .chip').length,
       packName: active.textContent.trim(),
     };
     byText('button', "I'm ready").click();
     await wait(() => !byText('button', 'Start game').disabled);
     byText('button', 'Start game').click();
     await wait(() => document.querySelectorAll('.tile').length > 0, 20000);
     report.tileNames = [...document.querySelectorAll('.tile-name')].map(el => el.textContent);
     for (const img of document.querySelectorAll('.tile img')) img.loading = 'eager';
     await wait(() => [...document.querySelectorAll('.tile img')].every(i => i.complete), 20000);
     report.brokenImages = [...document.querySelectorAll('.tile img')].filter(i => i.naturalWidth === 0).length;
     // Includes the leader's secret card, which is the 512px encode — the one most likely to
     // have needed the quality-and-downscale ladder.
     const urls = [...new Set([
       ...document.querySelectorAll('.tile img'),
       ...document.querySelectorAll('.secret img'),
     ].map(img => img.src))];
     const sizes = await Promise.all(urls.map(async url => (await (await fetch(url)).blob()).size));
     report.largestPhotoBytes = Math.max(...sizes);
     return report;`,
  );
}

interface JpegFallbackReport {
  detectedExtension: string;
  contentType: string | null;
  tileCount: number;
  brokenImages: number;
  largestPhotoBytes: number;
}

/**
 * Repeats the upload in a browser that cannot encode WebP.
 *
 * `canvas.toBlob` is patched to answer a WebP request with PNG, which is exactly what a browser
 * without WebP output does — silently, ignoring `quality` too. That is the failure a real user
 * hit, and it is invisible to a Chrome-only test, so it is simulated rather than hoped about.
 * The board must still arrive, as JPEG, and be served as JPEG.
 */
async function runJpegFallbackUpload(
  page: Awaited<ReturnType<typeof openPage>>,
  other: Awaited<ReturnType<typeof openPage>>,
  files: string[],
): Promise<JpegFallbackReport> {
  const evalOn = <T,>(target: typeof page, body: string) =>
    target.evaluate<T>(`(async () => { ${PAGE_HELPERS} ${body} })()`);

  // End the game that the previous upload started, so the lobby is reachable again.
  await evalOn<boolean>(
    page,
    `byText('.actions button', 'Guess their character').click();
     await wait(() => document.querySelector('.board.is-guessing'));
     document.querySelectorAll('.tile')[2].click();
     await wait(() => document.querySelector('.confirm'));
     byText('.confirm button', "Yes, that's them").click();
     await wait(() => document.querySelector('.result'));
     await wait(() => byText('button', 'Back to the lobby')).then(b => b.click());
     await wait(() => document.querySelector('.teams'));
     return true;`,
  );

  await evalOn<boolean>(
    page,
    `const original = HTMLCanvasElement.prototype.toBlob;
     HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
       return original.call(this, callback, type === 'image/webp' ? 'image/png' : type, quality);
     };
     return true;`,
  );

  const document_ = (await page.call('DOM.getDocument', { depth: 0 })).result as { root: { nodeId: number } };
  const input = (await page.call('DOM.querySelector', {
    nodeId: document_.root.nodeId,
    selector: 'input[type="file"]',
  })).result as { nodeId: number };
  await page.call('DOM.setFileInputFiles', { nodeId: input.nodeId, files });

  await evalOn<boolean>(page, `${AWAIT_UPLOAD} return true;`);

  await evalOn<boolean>(other, `await wait(() => byText('button', "I'm ready")).then(b => b.click()); return true;`);

  return evalOn<JpegFallbackReport>(
    page,
    `byText('button', "I'm ready").click();
     await wait(() => !byText('button', 'Start game').disabled);
     byText('button', 'Start game').click();
     await wait(() => document.querySelectorAll('.tile').length > 0, 20000);

     const images = [...document.querySelectorAll('.tile img')];
     for (const img of images) img.loading = 'eager';
     await wait(() => images.every(i => i.complete), 20000);

     const first = new URL(images[0].src);
     const response = await fetch(first);
     const sizes = await Promise.all(
       [...new Set(images.map(i => i.src))].map(async url => (await (await fetch(url)).blob()).size),
     );

     return {
       detectedExtension: first.pathname.split('.').pop(),
       contentType: response.headers.get('content-type'),
       tileCount: images.length,
       brokenImages: images.filter(i => i.naturalWidth === 0).length,
       largestPhotoBytes: Math.max(...sizes),
     };`,
  );
}

/**
 * Waits for an upload to start and then finish.
 *
 * Keyed on the progress bar rather than on the pack chip: a second upload replaces a board that
 * already has the same photo count, so "a chip says 10" is true before the new one has begun and
 * would silently measure the previous board.
 */
const AWAIT_UPLOAD = `
  await wait(() => document.querySelector('.upload-progress'), 15000);
  await wait(() => !document.querySelector('.upload-progress'), 120000);
`;

const GAME_HELPERS = `
  const secretName = () => {
    const heading = document.querySelector('.secret h2');
    const match = heading && heading.textContent.match(/^Your team is (.+)$/);
    return match ? match[1].trim() : null;
  };
  // React tracks the input's value internally, so a plain assignment is ignored on submit.
  const setValue = (input, value) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
`;

async function main(): Promise<void> {
  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chrome found. Install Chrome/Chromium or set CHROME_PATH.');
    process.exit(1);
  }

  if (shouldBuild) {
    console.log('Building…');
    await run('npm', ['run', 'build']);
  } else if (!existsSync('dist/index.html')) {
    console.error('--no-build given but dist/ is empty. Run npm run build first.');
    process.exit(1);
  }

  const profileDir = await mkdtemp(path.join(tmpdir(), 'guessfi-e2e-'));
  const photosDir = await mkdtemp(path.join(tmpdir(), 'guessfi-photos-'));
  let server: ChildProcess | undefined;
  let browser: ChildProcess | undefined;

  const cleanup = async () => {
    // Chrome rewrites its profile as it shuts down, so wait for it to actually be gone before
    // deleting the directory.
    await Promise.all([stopGracefully(browser), stopGracefully(server)]);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    await rm(photosDir, { recursive: true, force: true }).catch(() => {});

    // The port being free is the real proof nothing was orphaned.
    const released = await waitFor(
      'the port to be released',
      async () => !(await get(`${BASE_URL}/api/health`).then(() => true).catch(() => false)),
      10_000,
    ).then(() => true, () => false);
    if (!released) console.warn(`Warning: something is still listening on ${BASE_URL}`);
  };

  // Safety net for Ctrl-C and unexpected exits, so a detached group is never left behind.
  const onSignal = () => {
    killGroup(browser);
    killGroup(server);
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    if (!(await isPortFree(SERVER_PORT))) {
      throw new Error(
        `Port ${SERVER_PORT} is already in use — probably an orphaned wrangler from an earlier run.\n` +
          `Find it with:  ss -ltnp | grep ${SERVER_PORT}`,
      );
    }

    console.log(`\nStarting Worker on :${SERVER_PORT}…`);
    // Invoked directly rather than through npx: npx's shell wrapper ends up in its own process
    // group, so signalling the group we spawned would miss wrangler and orphan workerd.
    server = spawnGroup(
      path.resolve('node_modules/.bin/wrangler'),
      [
        'dev',
        '--port',
        String(SERVER_PORT),
        // Supplied on the command line rather than via .dev.vars so CI, which has no such file,
        // can still exercise the room. Both are throwaway values scoped to this run.
        '--var',
        `SESSION_SECRET:${randomUUID()}`,
      ],
      ['ignore', 'ignore', 'pipe'],
    );
    let serverStderr = '';
    server.stderr?.on('data', (chunk: Buffer) => (serverStderr += chunk.toString()));
    server.on('exit', (code, signal) => {
      // 130/SIGINT is our own graceful shutdown, not a failure.
      const expected = code === 0 || code === 130 || signal === 'SIGINT' || signal === 'SIGKILL';
      if (!expected) console.error(`wrangler exited ${code ?? signal}:\n${serverStderr}`);
    });

    await waitFor('the Worker', async () => (await get(`${BASE_URL}/api/health`)).ok);

    console.log('\nRoutes');
    const health = await get(`${BASE_URL}/api/health`);
    checkEqual('GET /api/health status', health.status, 200);
    checkEqual('GET /api/health body', await health.json(), { ok: true });

    checkEqual('GET /api/token (wrong method)', (await get(`${BASE_URL}/api/token`)).status, 405);
    checkEqual('GET /api/does-not-exist', (await get(`${BASE_URL}/api/does-not-exist`)).status, 404);

    // With a root URL mapping Discord forwards bare paths, but the Worker must tolerate the
    // prefix in case that ever changes.
    checkEqual('GET /.proxy/api/health (prefix stripped)', (await get(`${BASE_URL}/.proxy/api/health`)).status, 200);

    const spa = await get(`${BASE_URL}/some/deep/route`, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
    checkEqual('GET /some/deep/route falls back to the SPA', spa.status, 200);
    check('SPA fallback returns html', (spa.headers.get('content-type') ?? '').includes('text/html'));

    console.log('\nPacks');
    const indexResponse = await get(`${BASE_URL}/packs/index.json`);
    checkEqual('GET /packs/index.json status', indexResponse.status, 200);
    const packs = (await indexResponse.json()) as { id: string; name: string; tileCount: number; cover: string }[];
    check('at least one pack is built', packs.length > 0, packs.length);

    const firstPack = packs[0];
    let characterIds: string[] = [];
    if (firstPack) {
      const manifest = await get(`${BASE_URL}/packs/${firstPack.id}/manifest.json`);
      checkEqual(`GET /packs/${firstPack.id}/manifest.json`, manifest.status, 200);
      const parsed = (await manifest.json()) as { characters: { id: string }[]; tileCount: number };
      checkEqual('manifest tileCount matches character count', parsed.characters.length, parsed.tileCount);
      characterIds = parsed.characters.map((character) => character.id);

      const tile = await get(`${BASE_URL}/packs/${firstPack.id}/${firstPack.cover}`);
      checkEqual('cover tile status', tile.status, 200);
      checkEqual('cover tile is webp', tile.headers.get('content-type'), 'image/webp');

      const proxied = await get(`${BASE_URL}/.proxy/packs/${firstPack.id}/${firstPack.cover}`);
      checkEqual('cover tile via /.proxy', proxied.status, 200);
    }

    console.log('\nRoom (over the wire)');
    await checkRoomProtocol();

    if (firstPack) {
      console.log('\nGame (over the wire)');
      await checkGameProtocol(firstPack.id, characterIds);

      console.log('\nA team walking out');
      await checkAbandonedGame(firstPack.id);
    }

    console.log('\nRooms reached by code');
    await checkBrowserRooms();

    console.log('\nCustom photo pack');
    await checkCustomPack();

    console.log('\nLobby (two browsers)');
    browser = spawnGroup(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      'ignore',
    );

    await waitFor('Chrome', async () => (await get(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok);

    // The real journey: one person opens a room from the landing screen, the other follows the
    // link. No Discord anywhere in it.
    console.log('\nOpening a room from the landing screen');
    const alice = await openPage(`${BASE_URL}/?name=alice`);
    const opened = await runOpenRoomFlow(alice);
    check('the landing screen offers a way in', opened.sawLanding);
    check('opening a room puts the code in the address bar', /\/r\/[A-Z0-9]{6}$/.test(opened.url), opened.url);
    check('the code is shown in the header', opened.headerCode === opened.code, opened);

    const bob = await openPage(`${BASE_URL}/r/${opened.code}?name=bob`);

    console.log('\nLobby (two browsers)');
    const lobby = await runLobbyFlow(alice, bob);
    checkEqual('both players listed for alice', lobby.aliceSeesMembers, 2);
    checkEqual('both players listed for bob', lobby.bobSeesMembers, 2);
    check('alice joining Red shows up on bob’s screen', lobby.bobSeesAliceOnRed, lobby);
    check('alice is marked leader of Red', lobby.aliceLeadsRed, lobby);
    check('bob joining Blue shows up on alice’s screen', lobby.aliceSeesBobOnBlue, lobby);
    check('host pack choice reaches bob', lobby.bobSeesPack, lobby);
    check('start is disabled until everyone is ready', lobby.startDisabledBeforeReady, lobby);
    check('bob has no start button (not host)', lobby.bobHasNoStart, lobby);
    check('start enables once both are ready', lobby.startEnabledAfterReady, lobby);
    check('starting the game moves bob out of the lobby too', lobby.bobLeftLobby, lobby);

    console.log('\nBoard (in the started game)');
    const report = await alice.evaluate<BoardReport>(BOARD_SCRIPT);
    if (!report) throw new Error('Board script returned nothing — the page may have failed to load');

    const expectedTiles = firstPack?.tileCount ?? 0;
    checkEqual('tiles rendered', report.tileCount, expectedTiles);
    check('every tile has a distinct name', report.distinctNames === report.tileCount, report);
    check(
      'heading starts at full count',
      report.initialHeading.includes(`${expectedTiles} of ${expectedTiles} standing`),
      report.initialHeading,
    );
    check('reset starts disabled', report.resetDisabledInitially);

    check(
      'three flips decrement the count by three',
      report.afterThreeFlips.includes(`${expectedTiles - 3} of ${expectedTiles} standing`),
      report.afterThreeFlips,
    );
    checkEqual('three tiles marked flipped', report.flippedCount, 3);
    checkEqual('flipped tile reports aria-pressed', report.ariaPressed, 'true');
    check('flipped tile announces it is ruled out', report.ariaLabel?.includes('ruled out') ?? false, report.ariaLabel);

    check(
      'clicking again unflips',
      report.afterUnflip.includes(`${expectedTiles - 2} of ${expectedTiles} standing`),
      report.afterUnflip,
    );
    checkEqual('two tiles remain flipped', report.flippedAfterUnflip, 2);

    check(
      'reset restores every tile',
      report.afterReset.includes(`${expectedTiles} of ${expectedTiles} standing`),
      report.afterReset,
    );
    checkEqual('no tiles flipped after reset', report.flippedAfterReset, 0);
    check('reset disables itself again', report.resetDisabledAfterReset);

    checkEqual('no broken tile images', report.brokenImages, 0);

    console.log('\nGame (two browsers)');
    const played = await runGameFlow(alice, bob);

    check('the leader is shown a character', played.aliceSeesSecret);
    check('the opposing leader is shown one too', played.bobSeesSecret);
    check('the marked tile matches the secret card', played.aliceSecretIsHers);
    check('the waiting leader has nothing to submit', played.bobWaitsForRed);
    check('the question reaches the other leader', played.bobGetsTheQuestion);
    checkEqual('the answer shows in the asker’s log', played.aliceSeesAnswer, 'yes');
    check('answering passes the turn to Blue', played.turnPassedToBlue);
    check('Red can no longer ask once the turn passed', played.aliceHasNoAskBox);
    check('naming a character asks for confirmation first', played.confirmAppears);
    check('the guesser sees a result', played.bobSeesResult.length > 0, played.bobSeesResult);
    check(
      'both players see the same winner',
      played.aliceSeesResult.split(' ')[0] === played.bobSeesResult.split(' ')[0],
      played,
    );
    check('both characters are revealed on the board', played.bothRevealed);
    check('the team that never guessed is offered its turn', played.playOnOffered);
    check('reopening puts them back on the board', played.redGetsTheTurnBack);
    check('the team that already guessed is told it can only answer', played.blueIsAnsweringOnly);
    check('finishing decides it for good', played.finalResult.length > 0, played.finalResult);
    check('both guesses are shown and the offer is gone', played.playOnGoneAfterBoth);
    check('passing hands the turn over without a question', played.passHandsOver);
    check('play again starts a fresh game without the lobby', played.playAgainRestarts);
    check('a rematch puts everyone back in the lobby', played.rematchReturnsToLobby);

    console.log('\nCustom photos (picked in the browser)');
    const photoNames = ['Ada', 'Bram', 'Cleo', 'Dev', 'Elif', 'Fionn', 'Greta', 'Hugo', 'Ines', 'Jonas'];
    const photos = await writeTestPhotos(photosDir, photoNames);
    const uploaded = await runCustomPackUpload(alice, bob, photos);

    checkEqual('the uploaded board has one tile per photo', uploaded.tileNames.length, photoNames.length);
    checkEqual('filenames become the names on the board', uploaded.tileNames, photoNames);
    check('the uploaded board is the one selected', uploaded.packName.includes(String(photoNames.length)), uploaded);
    check('the built-in packs are still offered', uploaded.chipCount >= 3, uploaded.chipCount);
    // Proves the whole round trip: encoded by Chrome, stored by the room, served back as WebP.
    checkEqual('every uploaded photo renders', uploaded.brokenImages, 0);
    check(
      `photos fit the room’s cap (largest ${Math.round(uploaded.largestPhotoBytes / 1024)} KB of 128 KB)`,
      uploaded.largestPhotoBytes > 0 && uploaded.largestPhotoBytes <= 128 * 1024,
    );

    console.log('\nCustom photos (browser without WebP encoding)');
    const fallback = await runJpegFallbackUpload(alice, bob, photos);

    checkEqual('the board falls back to JPEG', fallback.detectedExtension, 'jpg');
    checkEqual('and is served as JPEG, not mislabelled', fallback.contentType, 'image/jpeg');
    checkEqual('the whole board still uploads', fallback.tileCount, photoNames.length);
    checkEqual('every fallback photo renders', fallback.brokenImages, 0);
    check(
      `fallback photos fit the cap (largest ${Math.round(fallback.largestPhotoBytes / 1024)} KB of 128 KB)`,
      fallback.largestPhotoBytes > 0 && fallback.largestPhotoBytes <= 128 * 1024,
    );

    console.log('\nLeaving');
    const departure = await runLeaveFlow(bob, alice);
    alice.close();
    bob.close();

    check('leaving shows the exit screen', departure.exitScreen);
    check('the last player leaving a team ends the game', departure.gameEndedForTheOthers);
  } finally {
    if (!(keepOpen && failures > 0)) await cleanup();
    else console.log(`\nLeaving the server up at ${BASE_URL} (--keep-open).`);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (error: unknown) => {
  console.error(`\n${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
