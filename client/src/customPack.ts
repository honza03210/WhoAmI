/**
 * Turning photos a host picked into a board, entirely in their browser.
 *
 * The same job as scripts/build-packs.ts, minus sharp: each photo becomes a square 256px tile
 * and a 512px version for the leader's secret card and the reveal. Encoding client-side keeps
 * the Worker out of the image business — it never sees a full-resolution photo, only the small
 * WebPs it will hand back to the room.
 */

import {
  CUSTOM_PACK_MAX,
  CUSTOM_PACK_MIN,
  CUSTOM_PHOTO_MAX_BYTES,
  PACK_IMAGE_EXTENSION,
  PACK_IMAGE_MIME,
  type CustomPack,
  type PackImageFormat,
} from '../../server/protocol';
import { displayNameFromFile, uniqueId } from '../../shared/naming';
import { apiPath } from './discord';

const TILE_SIZE = 256;
const FULL_SIZE = 512;

/** Encoder starts here and steps down until the photo fits; matches the build script's 82. */
const QUALITY_STEPS = [0.82, 0.7, 0.58, 0.45, 0.34, 0.25];

/**
 * When even the lowest quality is too big — dense photos, film grain, crowds — shrink the square
 * and try again. Losing pixels beats losing the photo, and a tile is displayed small anyway.
 */
const SHRINK_FACTOR = 0.75;

/** Below this a face stops being recognisable, so failing is more honest than shrinking on. */
const MIN_DIMENSION = 96;

/** Leaves room under the room's per-photo cap for anything the encoder gets wrong. */
const TARGET_BYTES = Math.floor(CUSTOM_PHOTO_MAX_BYTES * 0.75);

export const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp,image/avif,image/gif';

export interface UploadProgress {
  /** Photos fully uploaded so far. */
  done: number;
  total: number;
  /** What the host should be told is happening right now. */
  label: string;
}

export class PackError extends Error {}

/**
 * Rejects a selection before any work is done on it, so the host gets one clear sentence rather
 * than a failure forty photos in.
 */
export function checkSelection(files: File[]): string | null {
  if (files.length < CUSTOM_PACK_MIN) {
    return `Pick at least ${CUSTOM_PACK_MIN} photos — you chose ${files.length}.`;
  }
  if (files.length > CUSTOM_PACK_MAX) {
    return `Pick at most ${CUSTOM_PACK_MAX} photos — you chose ${files.length}.`;
  }
  const notImages = files.filter((file) => !file.type.startsWith('image/'));
  if (notImages.length > 0) return `${notImages[0]?.name ?? 'One file'} is not an image.`;
  return null;
}

/**
 * Encodes and uploads a whole board, then asks the room to publish it.
 *
 * Photos go up one at a time. It is slower than one big request but it is the only way to give
 * a host with forty photos any sense of progress, and it keeps every request small enough that
 * a flaky connection loses one photo rather than the lot.
 */
export async function uploadCustomPack(
  files: File[],
  session: string,
  roomKey: string,
  onProgress: (progress: UploadProgress) => void,
): Promise<CustomPack> {
  const problem = checkSelection(files);
  if (problem) throw new PackError(problem);

  const base = apiPath(`/api/pack/${encodeURIComponent(roomKey)}`);
  const auth = `session=${encodeURIComponent(session)}`;

  // Settled before any photo is touched: it decides both the encoding and the file names.
  const format = await detectFormat();
  const extension = PACK_IMAGE_EXTENSION[format];

  const { token } = await postJson<{ token: string }>(`${base}/begin?${auth}`, {
    name: packNameFrom(files),
  });

  const taken = new Set<string>();
  const characters: { id: string; name: string }[] = [];

  for (const [index, file] of files.entries()) {
    const name = displayNameFromFile(file.name);
    const id = uniqueId(name, taken);
    onProgress({ done: index, total: files.length, label: `Preparing ${name}…` });

    const bitmap = await loadImage(file);
    try {
      const tile = await encodeSquare(bitmap, TILE_SIZE, name, format);
      const full = await encodeSquare(bitmap, FULL_SIZE, name, format);
      await putPhoto(`${base}/${token}/add?file=${id}.${extension}&${auth}`, tile);
      await putPhoto(`${base}/${token}/add?file=${id}%40full.${extension}&${auth}`, full);
    } finally {
      bitmap.close();
    }

    characters.push({ id, name });
    onProgress({ done: index + 1, total: files.length, label: `Uploaded ${name}` });
  }

  onProgress({ done: files.length, total: files.length, label: 'Publishing the board…' });
  const { pack } = await postJson<{ pack: CustomPack }>(`${base}/${token}/commit?${auth}`, {
    characters,
    format,
  });
  return pack;
}

/** "Ada.jpg", "Bram.jpg" in a folder called "party" -> "party". Otherwise just "Custom". */
function packNameFrom(files: File[]): string {
  const relative = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
  const folder = relative.split('/')[0] ?? '';
  return folder && folder !== files[0]?.name ? folder : 'Custom';
}

async function loadImage(file: File): Promise<ImageBitmap> {
  try {
    // from-image so portrait photos off a phone are not delivered on their side.
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new PackError(`${file.name} could not be read as an image.`);
  }
}

/**
 * Centre-crops to a square and encodes to WebP small enough for the room to store.
 *
 * Quality comes down first, and only when the lowest setting still doesn't fit does the square
 * itself shrink — a slightly soft tile is better than a smaller one. Cropping rather than
 * letterboxing keeps faces filling the tile, which is the whole point of the board.
 */
async function encodeSquare(
  bitmap: ImageBitmap,
  size: number,
  label: string,
  format: PackImageFormat,
): Promise<Blob> {
  let best: Blob | null = null;

  for (let dimension = size; dimension >= MIN_DIMENSION; dimension = Math.round(dimension * SHRINK_FACTOR)) {
    for (const quality of QUALITY_STEPS) {
      const blob = await drawAndEncode(bitmap, dimension, quality, format);
      if (blob.size <= TARGET_BYTES) return blob;
      if (!best || blob.size < best.size) best = blob;
    }
  }

  // Every attempt overshot the comfortable target; anything under the hard cap still works.
  if (best && best.size <= CUSTOM_PHOTO_MAX_BYTES) return best;
  throw new PackError(
    `${label} could not be compressed small enough (best was ${Math.round((best?.size ?? 0) / 1024)} KB).`,
  );
}

async function drawAndEncode(
  bitmap: ImageBitmap,
  size: number,
  quality: number,
  format: PackImageFormat,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (!context) throw new PackError('This browser cannot process images.');

  // JPEG has no alpha, and an unpainted canvas composites as black; fill first so a transparent
  // PNG source arrives on a white card rather than a black one.
  if (format === 'jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size, size);
  }

  const side = Math.min(bitmap.width, bitmap.height);
  const left = (bitmap.width - side) / 2;
  const top = (bitmap.height - side) / 2;
  context.drawImage(bitmap, left, top, side, side, 0, 0, size, size);

  return toBlob(canvas, PACK_IMAGE_MIME[format], quality);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new PackError('This browser could not encode the image.'))),
      type,
      quality,
    );
  });
}

/**
 * Works out what this browser can actually produce, once per upload.
 *
 * `canvas.toBlob` does not report failure: asked for a type it cannot encode it quietly returns
 * PNG, ignoring `quality` too — which shows up as photos that refuse to compress rather than as
 * a missing feature. So the result is checked against the file's magic bytes rather than its
 * `type` field, which some browsers leave empty.
 */
async function detectFormat(): Promise<PackImageFormat> {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const context = canvas.getContext('2d');
  if (!context) throw new PackError('This browser cannot process images.');
  context.fillRect(0, 0, 8, 8);

  for (const format of ['webp', 'jpeg'] as const) {
    const blob = await toBlob(canvas, PACK_IMAGE_MIME[format], 0.8);
    if ((await sniff(blob)) === format) return format;
  }
  throw new PackError('This browser cannot encode images for upload.');
}

async function sniff(blob: Blob): Promise<PackImageFormat | 'other'> {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = String.fromCharCode(...header);

  // "RIFF....WEBP" and the JPEG SOI marker.
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpeg';
  return 'other';
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new PackError(explain(await errorCode(response), response.status));
  return (await response.json()) as T;
}

async function putPhoto(url: string, blob: Blob): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'image/webp' },
    body: blob,
  });
  if (!response.ok) throw new PackError(explain(await errorCode(response), response.status));
}

async function errorCode(response: Response): Promise<string> {
  try {
    return ((await response.json()) as { error?: string }).error ?? '';
  } catch {
    return '';
  }
}

/** Server codes are terse by design; the host gets the sentence version. */
function explain(code: string, status: number): string {
  switch (code) {
    case 'not_host':
      return 'Only the host can choose the photos.';
    case 'not_in_lobby':
      return 'The game has already started.';
    case 'bad_photo_count':
      return `A board needs between ${CUSTOM_PACK_MIN} and ${CUSTOM_PACK_MAX} photos.`;
    case 'photo_too_large':
      return 'One of the photos was too large even after compression.';
    case 'upload_expired':
      return 'That upload took too long — start it again.';
    case 'no_such_upload':
      return 'The upload was interrupted. Try again.';
    case 'bad_session':
      return 'Your session expired. Reload the activity.';
    default:
      return `Upload failed (${code || status}).`;
  }
}
