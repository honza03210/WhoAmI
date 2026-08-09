/**
 * Runs the whole local stack against Discord: Worker, Vite, and a cloudflared tunnel.
 *
 *   npm run dev:discord
 *
 * Discord does not expose URL mappings through its public API — PATCH /applications/@me has no
 * field for them — so pointing the activity at the tunnel is the one step that has to be done by
 * hand. This script does everything either side of it: starts the three processes, waits for
 * them, extracts the tunnel hostname, and prints exactly what to paste where.
 *
 * Quick tunnels get a new hostname every run. To stop re-pasting, deploy once
 * (`npm run deploy`) and point the root mapping at the stable workers.dev host instead.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const WORKER_PORT = 8787;
const CLIENT_PORT = 5173;

const children: ChildProcess[] = [];
let shuttingDown = false;

function start(name: string, command: string, args: string[], onLine?: (line: string) => void): ChildProcess {
  // Own process group per child: wrangler manages a workerd subprocess and cloudflared spawns
  // helpers, and signalling only the direct child would orphan them.
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.push(child);

  const handle = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      onLine?.(line);
      console.log(`[${name}] ${line}`);
    }
  };
  child.stdout?.on('data', handle);
  child.stderr?.on('data', handle);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[${name}] exited (${code ?? signal}). Shutting everything down.`);
    void shutdown(1);
  });

  return child;
}

async function shutdown(code: number): Promise<never> {
  shuttingDown = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      // SIGINT so wrangler can stop workerd itself rather than orphaning it.
      process.kill(-child.pid, 'SIGINT');
    } catch {
      child.kill('SIGINT');
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  process.exit(code);
}

async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const settled = await Promise.race([
      probe().catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    if (settled) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function banner(hostname: string, clientId: string): void {
  const line = '─'.repeat(74);
  console.log(`\n┌${line}┐`);
  console.log('│ Tunnel is up. One manual step — Discord has no API for URL mappings.');
  console.log('│');
  console.log('│   https://discord.com/developers/applications');
  console.log(`│   -> your app -> Activities -> URL Mappings -> ROOT MAPPING "/"`);
  console.log('│');
  console.log(`│   Paste:  ${hostname}`);
  console.log('│           (hostname only — no https://, no trailing slash)');
  console.log('│');
  if (clientId) {
    console.log(`│ Then launch the activity from a voice channel. It serves from:`);
    console.log(`│   https://${clientId}.discordsays.com`);
  }
  console.log('│');
  console.log('│ Quick-tunnel hostnames change every run. To set the mapping once and forget it,');
  console.log('│ run `npm run deploy` and map to the stable workers.dev host instead.');
  console.log(`└${line}┘\n`);
}

async function main(): Promise<void> {
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  const clientId = process.env['VITE_DISCORD_CLIENT_ID'] ?? '';

  console.log('Starting Worker…');
  start('worker', path.resolve('node_modules/.bin/wrangler'), ['dev', '--port', String(WORKER_PORT)]);
  await waitFor('the Worker', async () =>
    (await fetch(`http://127.0.0.1:${WORKER_PORT}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok,
  );
  console.log(`Worker ready on :${WORKER_PORT}`);

  console.log('Starting Vite…');
  start('client', path.resolve('node_modules/.bin/vite'), ['--port', String(CLIENT_PORT), '--strictPort']);
  await waitFor('Vite', async () =>
    (await fetch(`http://127.0.0.1:${CLIENT_PORT}/`, { signal: AbortSignal.timeout(2_000) })).ok,
  );
  console.log(`Client ready on :${CLIENT_PORT}`);

  console.log('Opening tunnel…');
  let hostname = '';
  const tunnelReady = new Promise<void>((resolve) => {
    start('tunnel', 'cloudflared', ['tunnel', '--url', `http://localhost:${CLIENT_PORT}`], (line) => {
      // cloudflared announces the assigned hostname once, in a banner on stderr.
      const match = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(line);
      if (match?.[1] && !hostname) {
        hostname = match[1];
        resolve();
      }
    });
  });

  await Promise.race([
    tunnelReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cloudflared did not report a hostname')), 60_000)),
  ]);

  banner(hostname, clientId);
  console.log('Ctrl-C to stop all three.\n');
}

main().catch(async (error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
});
