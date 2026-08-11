/**
 * A zip writer, so the reader can be tested against archives rather than against fixtures
 * checked into the repo.
 *
 * Small enough to read in one sitting, which is the point: a test that builds the bytes it is
 * about can also build the malformed ones, and `scripts/e2e.ts` uses it to hand Chrome a real
 * archive through a real file input. It is a test helper — nothing here ships.
 */

import { crc32, deflateRawSync } from 'node:zlib';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

export interface ZipSource {
  /** Path inside the archive; a trailing slash makes it a folder entry. */
  path: string;
  data?: string | Uint8Array;
  /** Store the bytes uncompressed (method 0) instead of deflating them. */
  store?: boolean;
  /** Claim a method or flags no honest archiver would — encryption, say, or LZMA. */
  method?: number;
  flags?: number;
  /** Claim an uncompressed size the data does not match, as a truncated archive would. */
  claimSize?: number;
}

/** Builds an archive out of `sources`, optionally with a trailing archive comment. */
export function makeZip(sources: ZipSource[], comment = ''): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const source of sources) {
    const name = encoder.encode(source.path);
    const raw = typeof source.data === 'string' ? encoder.encode(source.data) : (source.data ?? new Uint8Array());
    const stored = source.store ?? source.path.endsWith('/');
    const body = stored ? raw : new Uint8Array(deflateRawSync(raw));

    const entry = {
      name,
      flags: source.flags ?? 0,
      method: source.method ?? (stored ? 0 : 8),
      crc: crc32(Buffer.from(raw)),
      compressedSize: body.length,
      size: source.claimSize ?? raw.length,
      offset,
    };

    locals.push(local(entry, body));
    centrals.push(central(entry));
    offset += 30 + name.length + body.length;
  }

  const directory = concat(centrals);
  return concat([...locals, directory, eocd(sources.length, directory.length, offset, encoder.encode(comment))]);
}

interface Entry {
  name: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

function local(entry: Entry, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(30 + entry.name.length + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, LOCAL_SIGNATURE, true);
  view.setUint16(4, 20, true); // version needed
  view.setUint16(6, entry.flags, true);
  view.setUint16(8, entry.method, true);
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.compressedSize, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.name.length, true);
  out.set(entry.name, 30);
  out.set(body, 30 + entry.name.length);
  return out;
}

function central(entry: Entry): Uint8Array {
  const out = new Uint8Array(46 + entry.name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, CENTRAL_SIGNATURE, true);
  view.setUint16(4, 20, true); // version made by
  view.setUint16(6, 20, true); // version needed
  view.setUint16(8, entry.flags, true);
  view.setUint16(10, entry.method, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.compressedSize, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.name.length, true);
  view.setUint32(42, entry.offset, true);
  out.set(entry.name, 46);
  return out;
}

function eocd(count: number, directorySize: number, directoryOffset: number, comment: Uint8Array): Uint8Array {
  const out = new Uint8Array(22 + comment.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, directoryOffset, true);
  view.setUint16(20, comment.length, true);
  out.set(comment, 22);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
