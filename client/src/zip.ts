/**
 * Reading a zip archive in the browser, so a host can hand over a whole photoset at once.
 *
 * Picking forty files out of a file dialog is the worst part of setting a board up, and a zip is
 * what people already have when someone shares an album. Unpacking happens here rather than on
 * the Worker for the same reason the photos are encoded here: the room should never see a
 * full-resolution photo, and it certainly should not be handed a compressed blob to open.
 *
 * Deliberately free of DOM globals — `Blob`, `TextDecoder` and `DecompressionStream` exist in
 * Node too — so the parser can be unit tested without a browser, like avatar.ts and errors.ts.
 *
 * Only stored and deflated entries are supported, which between them cover every zip a normal
 * archiver produces. `DecompressionStream` does the inflating, so there is no dependency and no
 * bundled inflater.
 */

/** Signatures, all little-endian, from the zip appnote. */
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/** The archive comment sits between the end-of-directory record and the end of the file. */
const MAX_COMMENT = 0xffff;

const STORED = 0;
const DEFLATED = 8;

export class ZipError extends Error {}

export interface ZipEntry {
  /** The path as stored in the archive, e.g. "party/01_ada.jpg". */
  path: string;
  /** The file's own name, with any folders it sat in dropped. */
  name: string;
  /**
   * Uncompressed size, read out of the directory — so a caller can judge an archive, and refuse
   * one, before a single byte of it is decompressed.
   */
  size: number;
  /** Decompresses this one entry. Nothing is decompressed until this is called. */
  read: () => Promise<Uint8Array<ArrayBuffer>>;
}

/** "party/01_ada.jpg" -> "01_ada.jpg". */
export function leafName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Metadata a zipper wrapped around the files you actually put in.
 *
 * Compressing a folder on macOS silently adds a `__MACOSX/` tree holding a `._name` resource fork
 * for every file. They carry the same names as the photos, so left in they would double the size
 * of every board and put a broken tile beside every face. `.DS_Store` and `Thumbs.db` are the
 * same story from the two desktops that write them.
 */
export function isJunkPath(path: string): boolean {
  if (path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) return true;
  const leaf = leafName(path);
  // A leading dot covers AppleDouble forks and .DS_Store both; nothing a host meant to include
  // is named that way.
  return leaf.startsWith('.') || leaf.toLowerCase() === 'thumbs.db';
}

/**
 * Whether these bytes are a zip.
 *
 * Sniffed rather than taken from the file's name or type: browsers report at least three
 * different MIME types for a zip depending on the platform, and sometimes none at all.
 */
export async function isZip(file: Blob): Promise<boolean> {
  if (file.size < 4) return false;
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (header[0] !== 0x50 || header[1] !== 0x4b) return false; // "PK"
  // A local file header, or the end-of-directory record that an empty archive begins with.
  return (header[2] === 0x03 && header[3] === 0x04) || (header[2] === 0x05 && header[3] === 0x06);
}

/**
 * Lists what is inside an archive, without unpacking any of it.
 *
 * Everything comes from the central directory at the end of the file, which is the only part of
 * a zip that can be trusted to be complete — the per-file headers may leave sizes blank and fill
 * them in afterwards. Reading it first is also what makes an oversized or absurd archive cheap to
 * refuse: names and sizes are known before anything is decompressed.
 *
 * Entries come back sorted by path. A zip directory is in whatever order the archiver happened to
 * walk the folder, which is not the order the host numbered their photos in.
 */
export async function readZip(archive: Blob): Promise<ZipEntry[]> {
  if (archive.size < EOCD_SIZE) throw new ZipError('That file is not a zip archive.');

  const tailStart = Math.max(0, archive.size - (EOCD_SIZE + MAX_COMMENT));
  const tail = new DataView(await archive.slice(tailStart).arrayBuffer());

  // Scanning backwards: the record is at the very end unless the archive carries a comment, and
  // the last match is the real one even if the comment happens to contain the signature.
  let eocd = -1;
  for (let offset = tail.byteLength - EOCD_SIZE; offset >= 0; offset--) {
    if (tail.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('That file is not a zip archive, or it is damaged.');

  const total = tail.getUint16(eocd + 10, true);
  const directorySize = tail.getUint32(eocd + 12, true);
  const directoryOffset = tail.getUint32(eocd + 16, true);

  // ZIP64 parks these sentinels in the 32-bit fields and puts the real values in a second
  // directory. Saying so is better than reading nonsense, and no folder of photos needs it.
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ZipError('That archive is too large to open here — try zipping just the photos.');
  }
  if (total === 0) throw new ZipError('That archive is empty.');
  if (directoryOffset + directorySize > archive.size) throw new ZipError('That archive is damaged.');

  const directory = new DataView(
    await archive.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer(),
  );
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  let cursor = 0;
  for (let index = 0; index < total; index++) {
    if (cursor + CENTRAL_HEADER_SIZE > directory.byteLength || directory.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError('That archive is damaged.');
    }

    const flags = directory.getUint16(cursor + 8, true);
    const method = directory.getUint16(cursor + 10, true);
    const compressedSize = directory.getUint32(cursor + 20, true);
    const size = directory.getUint32(cursor + 24, true);
    const nameLength = directory.getUint16(cursor + 28, true);
    const extraLength = directory.getUint16(cursor + 30, true);
    const commentLength = directory.getUint16(cursor + 32, true);
    const localOffset = directory.getUint32(cursor + 42, true);
    // Names are UTF-8 whenever bit 11 is set, and in practice whenever it is not: the alternative
    // is CP437, which only differs above ASCII and only in archives from the last century.
    const path = decoder.decode(
      new Uint8Array(directory.buffer, directory.byteOffset + cursor + CENTRAL_HEADER_SIZE, nameLength),
    );
    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

    if (path.endsWith('/')) continue; // a folder, not a file
    if (isJunkPath(path)) continue;

    if ((flags & 0x1) !== 0) throw new ZipError(`${leafName(path)} is password-protected.`);
    if (method !== STORED && method !== DEFLATED) {
      throw new ZipError(`${leafName(path)} uses a kind of compression this browser cannot open.`);
    }

    entries.push({
      path,
      name: leafName(path),
      size,
      read: () => readEntry(archive, { path, localOffset, method, compressedSize, size }),
    });
  }

  return entries.sort((one, two) => one.path.localeCompare(two.path, undefined, { numeric: true }));
}

interface EntryLocation {
  path: string;
  localOffset: number;
  method: number;
  compressedSize: number;
  size: number;
}

async function readEntry(archive: Blob, entry: EntryLocation): Promise<Uint8Array<ArrayBuffer>> {
  const header = new DataView(
    await archive.slice(entry.localOffset, entry.localOffset + LOCAL_HEADER_SIZE).arrayBuffer(),
  );
  if (header.byteLength < LOCAL_HEADER_SIZE || header.getUint32(0, true) !== LOCAL_SIGNATURE) {
    throw new ZipError(`${leafName(entry.path)} could not be found inside the archive.`);
  }

  // The local header carries its own copy of the extra field, routinely a different length from
  // the directory's — alignment padding goes in one and not the other — so where the data starts
  // has to be read here rather than worked out from the directory.
  const start =
    entry.localOffset + LOCAL_HEADER_SIZE + header.getUint16(26, true) + header.getUint16(28, true);
  const data = archive.slice(start, start + entry.compressedSize);

  const raw = entry.method === STORED ? new Uint8Array(await data.arrayBuffer()) : await inflate(data);

  // The directory said how big this comes out. A mismatch means a truncated or doctored archive,
  // and half a photo is not worth handing to the encoder. This stands in for verifying the CRC:
  // deflate already rejects corrupted streams, and truncation is what actually happens.
  if (raw.byteLength !== entry.size) {
    throw new ZipError(`${leafName(entry.path)} is damaged inside the archive.`);
  }
  return raw;
}

async function inflate(data: Blob): Promise<Uint8Array<ArrayBuffer>> {
  // Raw deflate: a zip stores the deflate stream without the zlib wrapper around it.
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    const reader = data.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } catch {
    throw new ZipError('The archive could not be unpacked — it may be damaged.');
  }

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
