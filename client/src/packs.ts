import type { CustomPack } from '../../server/protocol';
import { CUSTOM_PACK_ID, PACK_IMAGE_EXTENSION } from '../../server/protocol';
import { apiPath } from './discord';

export interface PackCharacter {
  id: string;
  name: string;
  /** 256px square, for board tiles. */
  tile: string;
  /** 512px square, for reveals and the leader's secret card. */
  full: string;
}

export interface PackManifest {
  id: string;
  name: string;
  tileCount: number;
  characters: PackCharacter[];
  /**
   * Where this pack's images live. Built-in packs are static assets under /packs; an uploaded
   * pack is served by the room, so the two differ in path but not in kind — both are
   * same-origin, which is what keeps the Discord iframe's CSP out of the picture.
   */
  baseUrl: string;
}

export interface PackSummary {
  id: string;
  name: string;
  tileCount: number;
  cover: string;
}

export function packAsset(pack: PackManifest, file: string): string {
  return `${pack.baseUrl}/${file}`;
}

/**
 * The board the host uploaded, as a manifest indistinguishable from a built-in one.
 *
 * Derived from room state rather than fetched: the character list already arrives with every
 * state frame, so there is nothing left to ask the server for.
 */
export function manifestFromCustomPack(pack: CustomPack, instanceId: string): PackManifest {
  // A pack committed before the format was recorded holds WebP.
  const extension = PACK_IMAGE_EXTENSION[pack.format] ?? PACK_IMAGE_EXTENSION.webp;

  return {
    id: CUSTOM_PACK_ID,
    name: pack.name,
    tileCount: pack.characters.length,
    characters: pack.characters.map((character) => ({
      id: character.id,
      name: character.name,
      tile: `${character.id}.${extension}`,
      full: `${character.id}@full.${extension}`,
    })),
    // Photos are addressed by room and by the pack's random token; see handlePack in index.ts.
    baseUrl: apiPath(`/api/pack/${encodeURIComponent(instanceId)}/${pack.token}`),
  };
}

/**
 * The asset layer is configured to fall back to index.html for unknown paths, so a missing
 * pack file can come back as 200 text/html rather than 404. Anything that isn't parseable
 * JSON is therefore treated as "not built yet" rather than a hard failure.
 */
async function fetchJson<T>(path: string): Promise<T | null> {
  const response = await fetch(apiPath(path));
  if (!response.ok) return null;
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Returns [] when no packs have been built — the caller shows setup instructions. */
export async function loadPackIndex(): Promise<PackSummary[]> {
  return (await fetchJson<PackSummary[]>('/packs/index.json')) ?? [];
}

export async function loadPack(packId: string): Promise<PackManifest> {
  const manifest = await fetchJson<Omit<PackManifest, 'baseUrl'>>(`/packs/${packId}/manifest.json`);
  if (!manifest) throw new Error(`Pack "${packId}" is missing or invalid. Run: npm run packs`);
  return { ...manifest, baseUrl: apiPath(`/packs/${packId}`) };
}
