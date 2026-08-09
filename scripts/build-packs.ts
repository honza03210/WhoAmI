/**
 * Turns folders of photos into board-ready packs.
 *
 *   packs/<pack-id>/*.jpg          ->  public/packs/<pack-id>/<slug>.webp   (tile, 256px)
 *                                      public/packs/<pack-id>/<slug>@full.webp (512px)
 *                                      public/packs/<pack-id>/manifest.json
 *                                      public/packs/index.json
 *
 * Output lands in public/, so packs ship as ordinary static assets: same-origin (no CSP
 * problem inside the Discord iframe) and unbilled by Cloudflare.
 *
 * Usage:
 *   npm run packs              build everything that changed
 *   npm run packs -- --force   re-encode regardless of timestamps
 *   npm run packs -- demo      build only the "demo" pack
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { displayNameFromFile, uniqueId } from '../shared/naming';

const SOURCE_ROOT = 'packs';
const OUTPUT_ROOT = path.join('public', 'packs');

const TILE_SIZE = 256;
const FULL_SIZE = 512;
const WEBP_QUALITY = 82;

/** Classic Guess Who is a 4x6 board. Anything is allowed; we just nudge. */
const CLASSIC_TILE_COUNT = 24;
const MINIMUM_TILE_COUNT = 2;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff']);

interface PackConfig {
  /** Display name. Defaults to the directory name. */
  name?: string;
  /** Per-file display name overrides, keyed by source filename. */
  names?: Record<string, string>;
}

interface Character {
  id: string;
  name: string;
  tile: string;
  full: string;
}

interface Manifest {
  id: string;
  name: string;
  tileCount: number;
  characters: Character[];
}

interface IndexEntry {
  id: string;
  name: string;
  tileCount: number;
  cover: string;
}

async function readPackConfig(sourceDir: string): Promise<PackConfig> {
  try {
    return JSON.parse(await readFile(path.join(sourceDir, 'pack.json'), 'utf8')) as PackConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${sourceDir}/pack.json is not valid JSON: ${(error as Error).message}`);
  }
}

async function isOutputFresh(sourcePath: string, outputPaths: string[]): Promise<boolean> {
  try {
    const source = await stat(sourcePath);
    const outputs = await Promise.all(outputPaths.map((p) => stat(p)));
    return outputs.every((output) => output.mtimeMs >= source.mtimeMs);
  } catch {
    return false;
  }
}

async function encode(input: Buffer, size: number, destination: string): Promise<void> {
  await sharp(input, { failOn: 'none' })
    // Applies EXIF orientation. Without it, portrait phone photos land sideways.
    .rotate()
    .resize(size, size, {
      fit: 'cover',
      // Biases the square crop toward the busiest region, which for a portrait is the face.
      position: sharp.strategy.attention,
    })
    .webp({ quality: WEBP_QUALITY })
    .toFile(destination);
}

async function buildPack(packId: string, force: boolean): Promise<IndexEntry | null> {
  const sourceDir = path.join(SOURCE_ROOT, packId);
  const outputDir = path.join(OUTPUT_ROOT, packId);

  const config = await readPackConfig(sourceDir);
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const imageFiles = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  if (imageFiles.length < MINIMUM_TILE_COUNT) {
    console.warn(`  ! skipping "${packId}": found ${imageFiles.length} image(s), need at least ${MINIMUM_TILE_COUNT}`);
    return null;
  }

  await mkdir(outputDir, { recursive: true });

  const characters: Character[] = [];
  const usedIds = new Set<string>();
  let encoded = 0;

  for (const fileName of imageFiles) {
    const name = config.names?.[fileName] ?? displayNameFromFile(fileName);
    const id = uniqueId(name, usedIds);

    const tile = `${id}.webp`;
    const full = `${id}@full.webp`;
    const sourcePath = path.join(sourceDir, fileName);
    const tilePath = path.join(outputDir, tile);
    const fullPath = path.join(outputDir, full);

    if (force || !(await isOutputFresh(sourcePath, [tilePath, fullPath]))) {
      const input = await readFile(sourcePath);
      await encode(input, TILE_SIZE, tilePath);
      await encode(input, FULL_SIZE, fullPath);
      encoded++;
    }

    characters.push({ id, name, tile, full });
  }

  const manifest: Manifest = {
    id: packId,
    name: config.name ?? packId,
    tileCount: characters.length,
    characters,
  };
  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Drop anything left over from a previous build so a deleted photo doesn't linger on the board.
  const expected = new Set(['manifest.json', ...characters.flatMap((c) => [c.tile, c.full])]);
  let removed = 0;
  for (const existing of await readdir(outputDir)) {
    if (!expected.has(existing)) {
      await rm(path.join(outputDir, existing), { recursive: true, force: true });
      removed++;
    }
  }

  const details = [
    `${characters.length} tiles`,
    encoded > 0 ? `${encoded} encoded` : 'all cached',
    removed > 0 ? `${removed} stale removed` : null,
  ].filter(Boolean);
  console.log(`  ${manifest.name} (${packId}) — ${details.join(', ')}`);

  if (characters.length !== CLASSIC_TILE_COUNT) {
    console.log(`    note: ${characters.length} tiles; the classic board is ${CLASSIC_TILE_COUNT} (4x6)`);
  }

  const cover = characters[0];
  if (!cover) return null;
  return { id: packId, name: manifest.name, tileCount: characters.length, cover: cover.tile };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const requested = args.filter((arg) => !arg.startsWith('--'));

  let sourceEntries;
  try {
    sourceEntries = await readdir(SOURCE_ROOT, { withFileTypes: true });
  } catch {
    console.error(`No ${SOURCE_ROOT}/ directory. Create ${SOURCE_ROOT}/<pack-id>/ and drop photos in it.`);
    process.exit(1);
  }

  const available = sourceEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const packIds = requested.length > 0 ? requested : available;

  for (const packId of requested) {
    if (!available.includes(packId)) {
      console.error(`Unknown pack "${packId}". Available: ${available.join(', ') || '(none)'}`);
      process.exit(1);
    }
  }

  if (packIds.length === 0) {
    console.error(`No packs found in ${SOURCE_ROOT}/. Create ${SOURCE_ROOT}/<pack-id>/ and drop photos in it.`);
    process.exit(1);
  }

  console.log(`Building ${packIds.length} pack(s)…`);
  await mkdir(OUTPUT_ROOT, { recursive: true });

  const built: IndexEntry[] = [];
  for (const packId of packIds) {
    const entry = await buildPack(packId, force);
    if (entry) built.push(entry);
  }

  if (built.length === 0) {
    console.error('No packs built.');
    process.exit(1);
  }

  // A partial run (`npm run packs -- demo`) must not drop other packs from the index, so merge
  // with whatever is already on disk and discard entries whose output is gone.
  const index = new Map<string, IndexEntry>();
  try {
    const existing = JSON.parse(await readFile(path.join(OUTPUT_ROOT, 'index.json'), 'utf8')) as IndexEntry[];
    for (const entry of existing) {
      if (available.includes(entry.id)) index.set(entry.id, entry);
    }
  } catch {
    // No previous index; start fresh.
  }
  for (const entry of built) index.set(entry.id, entry);

  const sorted = [...index.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  await writeFile(path.join(OUTPUT_ROOT, 'index.json'), `${JSON.stringify(sorted, null, 2)}\n`);

  console.log(`Done. ${sorted.length} pack(s) in ${OUTPUT_ROOT}/.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
