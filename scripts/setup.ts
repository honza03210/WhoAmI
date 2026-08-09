/**
 * One-shot project configuration.
 *
 *   npm run setup                                    prompts for what it needs
 *   npm run setup -- --client-id X --client-secret Y  non-interactive (CI, re-runs)
 *
 * Writes .env and .dev.vars, generates a SESSION_SECRET, puts the client id into
 * wrangler.jsonc, and then actually calls Discord to prove the credentials work — a typo'd
 * secret otherwise surfaces much later as an opaque 502 from /api/token.
 *
 * Safe to re-run: existing values are kept unless you pass new ones.
 */

import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const ENV_FILE = '.env';
const DEV_VARS_FILE = '.dev.vars';
const WRANGLER_FILE = 'wrangler.jsonc';

function parseArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const [flag, inline] = arg.slice(2).split('=', 2);
    if (!flag) continue;
    if (inline !== undefined) {
      parsed.set(flag, inline);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        parsed.set(flag, next);
        i++;
      } else {
        parsed.set(flag, 'true');
      }
    }
  }
  return parsed;
}

/** Reads KEY=value files (.env / .dev.vars), ignoring comments and blanks. */
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

function serialiseEnvFile(header: string, values: Map<string, string>): string {
  const body = [...values].map(([key, value]) => `${key}=${value}`).join('\n');
  return `${header}\n${body}\n`;
}

/**
 * Sets `vars.DISCORD_CLIENT_ID` in wrangler.jsonc without reformatting the file. The config is
 * JSONC (comments, trailing commas), so it is edited textually rather than parsed and rewritten.
 */
async function setClientIdInWrangler(clientId: string): Promise<boolean> {
  const original = await readFile(WRANGLER_FILE, 'utf8');
  const pattern = /("DISCORD_CLIENT_ID"\s*:\s*)"[^"]*"/;
  if (!pattern.test(original)) {
    console.warn(`  ! could not find "DISCORD_CLIENT_ID" in ${WRANGLER_FILE}; set it by hand`);
    return false;
  }
  const updated = original.replace(pattern, `$1"${clientId}"`);
  if (updated === original) return false;
  await writeFile(WRANGLER_FILE, updated);
  return true;
}

/**
 * Verifies the app credentials with a client_credentials grant. This proves the id and secret
 * belong together without needing a user to authorise anything.
 */
async function verifyCredentials(clientId: string, clientSecret: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'identify' }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // No network is not the same as bad credentials; don't fail setup over it.
    return `could not reach Discord (${error instanceof Error ? error.message : String(error)})`;
  }

  if (response.ok) return null;
  const body = await response.text().catch(() => '');
  if (response.status === 401) return 'Discord rejected the client id/secret pair (401)';
  return `Discord returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const interactive = stdin.isTTY && !flags.has('client-id') && !flags.has('client-secret');

  const env = await readEnvFile(ENV_FILE);
  const devVars = await readEnvFile(DEV_VARS_FILE);

  let clientId = flags.get('client-id') ?? env.get('VITE_DISCORD_CLIENT_ID') ?? '';
  let clientSecret = flags.get('client-secret') ?? devVars.get('DISCORD_CLIENT_SECRET') ?? '';

  if (interactive) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      console.log('Discord application credentials');
      console.log('  https://discord.com/developers/applications -> your app -> OAuth2\n');
      clientId = (await rl.question(`  Client ID${clientId ? ` [${clientId}]` : ''}: `)).trim() || clientId;
      const secretHint = clientSecret ? ' [keep existing]' : '';
      clientSecret = (await rl.question(`  Client Secret${secretHint}: `)).trim() || clientSecret;
    } finally {
      rl.close();
    }
    console.log('');
  }

  if (!clientId) {
    console.error('No client id. Pass --client-id, or run without flags to be prompted.');
    process.exit(1);
  }
  if (!/^\d{17,20}$/.test(clientId)) {
    console.error(`"${clientId}" is not a Discord application id (expected 17-20 digits).`);
    process.exit(1);
  }

  env.set('VITE_DISCORD_CLIENT_ID', clientId);
  await writeFile(
    ENV_FILE,
    serialiseEnvFile('# Public. Baked into the client bundle by Vite — no secrets here.', env),
  );
  console.log(`  wrote ${ENV_FILE}`);

  if (clientSecret) devVars.set('DISCORD_CLIENT_SECRET', clientSecret);
  else if (!devVars.has('DISCORD_CLIENT_SECRET')) devVars.set('DISCORD_CLIENT_SECRET', '');

  // Generated once and kept: rotating it would invalidate every live session token.
  if (!devVars.get('SESSION_SECRET')) {
    devVars.set('SESSION_SECRET', randomBytes(32).toString('base64'));
    console.log('  generated SESSION_SECRET');
  }

  await writeFile(
    DEV_VARS_FILE,
    serialiseEnvFile('# Local secrets for `wrangler dev`. Gitignored — never commit this.', devVars),
  );
  console.log(`  wrote ${DEV_VARS_FILE}`);

  if (await setClientIdInWrangler(clientId)) console.log(`  set DISCORD_CLIENT_ID in ${WRANGLER_FILE}`);

  if (clientSecret) {
    process.stdout.write('  verifying credentials with Discord… ');
    const problem = await verifyCredentials(clientId, clientSecret);
    console.log(problem ? `\n  ! ${problem}` : 'ok');
    if (problem?.startsWith('Discord rejected')) process.exit(1);
  } else {
    console.log('  ! no client secret set — /api/token will fail until you add one');
  }

  console.log('\nNext:');
  console.log('  npm run demo-pack && npm run packs   # if you have no photo packs yet');
  console.log('  npm run dev:discord                  # worker + client + tunnel');
  console.log('  npm run doctor                       # check anything that looks off');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
