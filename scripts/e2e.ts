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

/** Minimal CDP client over the WebSocket built into Node 22. */
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

  return {
    async evaluate<T>(expression: string): Promise<T> {
      const id = ++nextId;
      const reply = await new Promise<{ result?: unknown }>((resolve) => {
        pending.set(id, resolve);
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
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
    throw new Error('timed out waiting for board to render');
  };
  await wait(() => document.querySelectorAll('.tile').length > 0);
  const tiles = () => [...document.querySelectorAll('.tile')];
  const heading = () => document.querySelector('.board-header h2').textContent.trim();
  const flipped = () => document.querySelectorAll('.tile.is-flipped').length;
  const resetBtn = () => document.querySelector('.link-button');
  const settle = () => new Promise(r => setTimeout(r, 120));

  const out = {
    tileCount: tiles().length,
    initialHeading: heading(),
    resetDisabledInitially: resetBtn().disabled,
    firstTileName: tiles()[0].querySelector('.tile-name').textContent,
    distinctNames: new Set(tiles().map(t => t.querySelector('.tile-name').textContent)).size,
  };

  tiles()[0].click(); tiles()[5].click(); tiles()[11].click();
  await settle();
  out.afterThreeFlips = heading();
  out.flippedCount = flipped();
  out.ariaPressed = tiles()[0].getAttribute('aria-pressed');
  out.ariaLabel = tiles()[0].getAttribute('aria-label');

  tiles()[5].click();
  await settle();
  out.afterUnflip = heading();
  out.flippedAfterUnflip = flipped();

  resetBtn().click();
  await settle();
  out.afterReset = heading();
  out.flippedAfterReset = flipped();
  out.resetDisabledAfterReset = resetBtn().disabled;

  // Images are lazy-loaded; scroll to the bottom so they all start, then wait for them.
  window.scrollTo(0, document.body.scrollHeight);
  await wait(() => [...document.querySelectorAll('.tile img')].every(i => i.complete), 20000);
  out.brokenImages = [...document.querySelectorAll('.tile img')].filter(i => i.naturalWidth === 0).length;
  return out;
})()`;

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
  let server: ChildProcess | undefined;
  let browser: ChildProcess | undefined;

  const cleanup = async () => {
    // Chrome rewrites its profile as it shuts down, so wait for it to actually be gone before
    // deleting the directory.
    await Promise.all([stopGracefully(browser), stopGracefully(server)]);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});

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
      ['dev', '--port', String(SERVER_PORT)],
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
    if (firstPack) {
      const manifest = await get(`${BASE_URL}/packs/${firstPack.id}/manifest.json`);
      checkEqual(`GET /packs/${firstPack.id}/manifest.json`, manifest.status, 200);
      const parsed = (await manifest.json()) as { characters: unknown[]; tileCount: number };
      checkEqual('manifest tileCount matches character count', parsed.characters.length, parsed.tileCount);

      const tile = await get(`${BASE_URL}/packs/${firstPack.id}/${firstPack.cover}`);
      checkEqual('cover tile status', tile.status, 200);
      checkEqual('cover tile is webp', tile.headers.get('content-type'), 'image/webp');

      const proxied = await get(`${BASE_URL}/.proxy/packs/${firstPack.id}/${firstPack.cover}`);
      checkEqual('cover tile via /.proxy', proxied.status, 200);
    }

    console.log('\nBoard');
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
    const page = await connectCdp(`${BASE_URL}/`);

    // Creating the target and evaluating are racy: the execution context we first attach to can
    // be about:blank, and it is torn down when the real navigation commits. Wait for the page to
    // actually be ours and loaded before running anything against it.
    await waitFor(
      'the page to load',
      async () =>
        (await page.evaluate<boolean>(
          `location.origin === ${JSON.stringify(BASE_URL)} && document.readyState === 'complete'`,
        )) === true,
    );

    const report = await page.evaluate<BoardReport>(BOARD_SCRIPT);
    page.close();
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
