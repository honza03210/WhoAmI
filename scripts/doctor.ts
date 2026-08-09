/**
 * Checks everything that has to be true before the activity will run, and says exactly what to
 * do about anything that isn't.
 *
 *   npm run doctor
 *
 * Exits non-zero if something is actually broken. Warnings alone don't fail it.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);

type Level = 'ok' | 'warn' | 'fail';

let failures = 0;
let warnings = 0;

function report(level: Level, label: string, detail?: string, fix?: string): void {
  const marker = level === 'ok' ? '  ok  ' : level === 'warn' ? '  warn' : '  FAIL';
  console.log(`${marker}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (fix && level !== 'ok') console.log(`        ${fix}`);
  if (level === 'fail') failures++;
  if (level === 'warn') warnings++;
}

async function readEnvFile(file: string): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  if (!existsSync(file)) return values;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }
  return values;
}

async function onPath(command: string): Promise<boolean> {
  try {
    await exec('command', ['-v', command], { shell: '/bin/sh' } as never);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('Toolchain');

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) report('ok', `Node ${process.versions.node}`);
  else {
    report('fail', `Node ${process.versions.node}`, 'wrangler 4 needs Node 22+', 'nvm use  (or install Node 22)');
  }

  report(
    (await onPath('cloudflared')) ? 'ok' : 'warn',
    'cloudflared',
    (await onPath('cloudflared')) ? undefined : 'not installed',
    'Needed only for `npm run dev:discord`: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  );

  console.log('\nConfiguration');

  const env = await readEnvFile('.env');
  const devVars = await readEnvFile('.dev.vars');
  const clientId = env.get('VITE_DISCORD_CLIENT_ID') ?? '';
  const clientSecret = devVars.get('DISCORD_CLIENT_SECRET') ?? '';
  const sessionSecret = devVars.get('SESSION_SECRET') ?? '';

  if (!existsSync('.env')) report('fail', '.env', 'missing', 'npm run setup');
  else if (!clientId) report('fail', 'VITE_DISCORD_CLIENT_ID', 'empty', 'npm run setup');
  else if (!/^\d{17,20}$/.test(clientId)) report('fail', 'VITE_DISCORD_CLIENT_ID', `"${clientId}" is not an app id`, 'npm run setup');
  else report('ok', 'VITE_DISCORD_CLIENT_ID', clientId);

  if (!existsSync('.dev.vars')) report('fail', '.dev.vars', 'missing', 'npm run setup');
  else {
    report(clientSecret ? 'ok' : 'fail', 'DISCORD_CLIENT_SECRET', clientSecret ? 'set' : 'empty', 'npm run setup');
    report(sessionSecret ? 'ok' : 'fail', 'SESSION_SECRET', sessionSecret ? 'set' : 'empty', 'npm run setup');
  }

  // The Worker reads the client id from wrangler.jsonc, not .env, so these must agree.
  const wrangler = existsSync('wrangler.jsonc') ? await readFile('wrangler.jsonc', 'utf8') : '';
  const wranglerClientId = /"DISCORD_CLIENT_ID"\s*:\s*"([^"]*)"/.exec(wrangler)?.[1] ?? '';
  if (clientId && wranglerClientId !== clientId) {
    report(
      'fail',
      'wrangler.jsonc DISCORD_CLIENT_ID',
      wranglerClientId ? `"${wranglerClientId}" does not match .env` : 'empty',
      'npm run setup',
    );
  } else if (clientId) {
    report('ok', 'wrangler.jsonc DISCORD_CLIENT_ID', 'matches .env');
  }

  if (clientId && clientSecret) {
    process.stdout.write('  ....  verifying credentials with Discord… ');
    try {
      const response = await fetch('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'identify' }),
        signal: AbortSignal.timeout(15_000),
      });
      console.log('');
      if (response.ok) report('ok', 'Discord credentials', 'accepted');
      else if (response.status === 401) report('fail', 'Discord credentials', 'rejected (401)', 'Re-copy the secret from the OAuth2 page, then: npm run setup');
      else report('warn', 'Discord credentials', `unexpected ${response.status}`);
    } catch (error) {
      console.log('');
      report('warn', 'Discord credentials', `could not reach Discord (${error instanceof Error ? error.message : 'error'})`);
    }
  }

  console.log('\nPhoto packs');

  const sourcePacks = existsSync('packs')
    ? (await readdir('packs', { withFileTypes: true })).filter((entry) => entry.isDirectory())
    : [];
  if (sourcePacks.length === 0) {
    report('warn', 'pack sources', 'none in packs/', 'npm run demo-pack   # or add packs/<name>/*.jpg');
  } else {
    report('ok', 'pack sources', sourcePacks.map((entry) => entry.name).join(', '));
  }

  if (!existsSync('public/packs/index.json')) {
    report('warn', 'built packs', 'not built', 'npm run packs');
  } else {
    const index = JSON.parse(await readFile('public/packs/index.json', 'utf8')) as { id: string; tileCount: number }[];
    report('ok', 'built packs', index.map((entry) => `${entry.id} (${entry.tileCount})`).join(', '));

    // A source pack that was never built silently won't appear in the game.
    const builtIds = new Set(index.map((entry) => entry.id));
    const unbuilt = sourcePacks.map((entry) => entry.name).filter((name) => !builtIds.has(name));
    if (unbuilt.length > 0) report('warn', 'unbuilt packs', unbuilt.join(', '), 'npm run packs');
  }

  console.log('\nDeploy');
  if (existsSync('node_modules/.bin/wrangler')) {
    try {
      const { stdout } = await exec('node_modules/.bin/wrangler', ['whoami'], { timeout: 30_000 });
      const account = /│\s+(.+?)\s+│\s+([0-9a-f]{32})\s+│/.exec(stdout);
      if (/You are not authenticated/i.test(stdout)) {
        report('warn', 'Cloudflare login', 'not logged in', 'npx wrangler login   (only needed to deploy)');
      } else {
        report('ok', 'Cloudflare login', account?.[1] ?? 'authenticated');
      }
    } catch {
      report('warn', 'Cloudflare login', 'could not determine', 'npx wrangler login   (only needed to deploy)');
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(`${failures} problem(s), ${warnings} warning(s).`);
    process.exit(1);
  }
  console.log(warnings > 0 ? `Ready, with ${warnings} warning(s).` : 'Everything checks out.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
