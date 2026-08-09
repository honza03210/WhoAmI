/**
 * Turning photo filenames into character names and ids.
 *
 * Shared rather than living under scripts/, because photos now arrive two ways — from `packs/`
 * at build time and from a file picker in the browser — and both have to produce the same ids.
 * Deliberately free of `node:path` so it can be bundled into the client.
 */

/** Turns a display name into a filesystem- and URL-safe character id. */
export function slugify(value: string): string {
  // Strip combining diacritics so "Tomáš" slugs to "tomas" rather than losing the letter.
  const ascii = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return ascii.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'character';
}

/**
 * "01_bob smith.jpg" -> "bob smith". Underscores become spaces and a leading ordering prefix
 * is dropped, so photos can be sequenced by filename. Hyphens are left alone so names like
 * "Anne-Marie" survive; use `names` in pack.json for anything this gets wrong.
 */
export function displayNameFromFile(fileName: string): string {
  // Directory components are dropped: a browser directory pick reports "folder/name.jpg".
  const leaf = fileName.slice(fileName.lastIndexOf('/') + 1);
  // A leading dot is part of the name, not an extension — ".jpg" is a file called ".jpg".
  const base = leaf.replace(/(?!^)\.[^.]*$/, '');
  const withoutOrderPrefix = base.replace(/^\d+\s*[-_.]?\s*/, '');
  return (withoutOrderPrefix || base).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Two people called "Sam" would otherwise overwrite each other's tiles, so the second one
 * becomes "sam-2". Mutates `taken` with the id it hands back.
 */
export function uniqueId(name: string, taken: Set<string>): string {
  const base = slugify(name);
  let id = base;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${base}-${suffix}`;
    suffix++;
  }
  taken.add(id);
  return id;
}
