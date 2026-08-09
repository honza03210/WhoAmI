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
}

export interface PackSummary {
  id: string;
  name: string;
  tileCount: number;
  cover: string;
}

/** Packs are same-origin static assets, so no CSP handling is needed for these. */
export function packAsset(packId: string, file: string): string {
  return apiPath(`/packs/${packId}/${file}`);
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
  const manifest = await fetchJson<PackManifest>(`/packs/${packId}/manifest.json`);
  if (!manifest) throw new Error(`Pack "${packId}" is missing or invalid. Run: npm run packs`);
  return manifest;
}
