/**
 * Avatar URL construction.
 *
 * Kept apart from discord.ts, which touches `window` at module scope and so can't be loaded
 * outside a browser. These are pure functions and are unit-tested.
 */

export type IdentityKind = 'discord' | 'guest';

/** cdn.discordapp.com is one of the few origins allowed through the activity CSP. */
export function avatarUrl(id: string, avatar: string | null | undefined, kind: IdentityKind = 'discord'): string {
  if (kind === 'guest') return generatedAvatar(id, '');
  if (avatar) return `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=128`;

  // Default avatars for migrated (pomelo) usernames are indexed by (snowflake >> 22) % 6.
  // Ids that aren't snowflakes would make BigInt throw, and an exception here would take down
  // the whole render for the sake of a placeholder image.
  let index = 0;
  try {
    index = Number((BigInt(id) >> 22n) % 6n);
  } catch {
    index = hash(id) % 6;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** Convenience for callers that have a name to draw initials from. */
export function avatarFor(
  id: string,
  avatar: string | null | undefined,
  kind: IdentityKind,
  name: string,
): string {
  return kind === 'guest' ? generatedAvatar(id, name) : avatarUrl(id, avatar, kind);
}

/**
 * A drawn avatar for someone with no Discord account behind them.
 *
 * An inline SVG data URI rather than a remote image: there is no third-party origin to allow
 * through the activity's CSP, nothing to fetch, and nothing that can 404 mid-game. Deterministic
 * from the id, so the same player keeps the same face across a reconnect.
 */
export function generatedAvatar(id: string, name: string): string {
  const hue = hash(id) % 360;
  const initials = initialsOf(name);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="32" fill="hsl(${hue} 52% 42%)"/>` +
    `<text x="32" y="33" fill="#fff" font-family="system-ui,sans-serif" font-size="26"` +
    ` font-weight="600" text-anchor="middle" dominant-baseline="central">${initials}</text>` +
    `</svg>`;

  // encodeURIComponent rather than base64: the payload is tiny, and this keeps it readable in
  // devtools, which matters when an avatar is the thing that looks wrong.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Up to two letters, from the first two words. Falls back to a shape rather than nothing. */
function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toUpperCase();

  // Escaped because it lands inside SVG markup, and a display name is user input.
  return escapeXml(letters || '?');
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => {
    switch (character) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Small deterministic string hash — used for hue and for the non-snowflake fallback. */
function hash(value: string): number {
  let total = 0;
  for (const character of value) total = (total * 31 + character.charCodeAt(0)) >>> 0;
  return total;
}
