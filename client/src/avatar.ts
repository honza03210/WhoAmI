/**
 * Avatar URL construction.
 *
 * Kept apart from discord.ts, which touches `window` at module scope and so can't be loaded
 * outside a browser. This is a pure function and is unit-tested.
 */

/** cdn.discordapp.com is one of the few origins allowed through the activity CSP. */
export function avatarUrl(id: string, avatar: string | null | undefined): string {
  if (avatar) return `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=128`;

  // Default avatars for migrated (pomelo) usernames are indexed by (snowflake >> 22) % 6.
  // Ids that aren't snowflakes — dev sessions use "dev-<name>" — would make BigInt throw, and
  // an exception here would take down the whole render for the sake of a placeholder image.
  let index = 0;
  try {
    index = Number((BigInt(id) >> 22n) % 6n);
  } catch {
    index = [...id].reduce((total, character) => (total + character.charCodeAt(0)) % 6, 0);
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
