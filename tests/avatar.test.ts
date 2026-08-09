import { describe, expect, it } from 'vitest';
import { avatarUrl } from '../client/src/avatar';

describe('avatarUrl', () => {
  it('uses the uploaded avatar when there is one', () => {
    expect(avatarUrl('123456789012345678', 'abc123')).toBe(
      'https://cdn.discordapp.com/avatars/123456789012345678/abc123.png?size=128',
    );
  });

  it('derives a default avatar from the snowflake', () => {
    expect(avatarUrl('123456789012345678', null)).toMatch(
      /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/,
    );
  });

  it('survives ids that are not snowflakes', () => {
    // Dev sessions use "dev-<name>". BigInt() throws on these, and an exception in a render
    // path over a placeholder image previously blanked the entire app.
    for (const id of ['dev-alice', '', 'not-a-number', '💥']) {
      expect(avatarUrl(id, null)).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
    }
  });

  it('is stable for a given id', () => {
    expect(avatarUrl('dev-alice', null)).toBe(avatarUrl('dev-alice', null));
  });
});
