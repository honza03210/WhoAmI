import { describe, expect, it } from 'vitest';
import { avatarFor, avatarUrl, generatedAvatar } from '../client/src/avatar';

describe('Discord avatars', () => {
  it('uses the uploaded avatar when there is one', () => {
    expect(avatarUrl('123', 'abc')).toBe('https://cdn.discordapp.com/avatars/123/abc.png?size=128');
  });

  it('falls back to the default indexed by snowflake', () => {
    const url = avatarUrl('1535978877573406841', null);
    expect(url).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  });

  it('survives an id that is not a snowflake', () => {
    // BigInt would throw here, and a thrown avatar would take the whole render down with it.
    expect(() => avatarUrl('not-a-number', null)).not.toThrow();
    expect(avatarUrl('not-a-number', null)).toMatch(/embed\/avatars\/[0-5]\.png$/);
  });
});

describe('generated avatars', () => {
  it('never reach for a third-party origin', () => {
    // No remote fetch means nothing for the activity's CSP to block and nothing to 404 mid-game.
    expect(generatedAvatar('gabc', 'Ada')).toMatch(/^data:image\/svg\+xml,/);
  });

  it('are stable for an id, so a reconnect keeps the same face', () => {
    expect(generatedAvatar('gabc', 'Ada')).toBe(generatedAvatar('gabc', 'Ada'));
    expect(generatedAvatar('gabc', 'Ada')).not.toBe(generatedAvatar('gdef', 'Ada'));
  });

  it('draw up to two initials', () => {
    expect(decodeURIComponent(generatedAvatar('g1', 'Ada'))).toContain('>A<');
    expect(decodeURIComponent(generatedAvatar('g1', 'Ada Lovelace'))).toContain('>AL<');
    expect(decodeURIComponent(generatedAvatar('g1', 'Ada Byron Lovelace'))).toContain('>AB<');
  });

  it('fall back to a mark rather than an empty face', () => {
    expect(decodeURIComponent(generatedAvatar('g1', ''))).toContain('>?<');
    expect(decodeURIComponent(generatedAvatar('g1', '   '))).toContain('>?<');
  });

  it('escape a name before it lands inside markup', () => {
    // A display name is user input and this one ends up between SVG tags.
    const svg = decodeURIComponent(generatedAvatar('g1', '<script>'));
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;');
  });

  it('handle names that start with an astral character', () => {
    expect(() => generatedAvatar('g1', '🎲 Player')).not.toThrow();
  });
});

describe('avatarFor', () => {
  it('draws guests and links Discord players', () => {
    expect(avatarFor('gabc', null, 'guest', 'Ada')).toMatch(/^data:image\/svg\+xml,/);
    expect(avatarFor('123', 'hash', 'discord', 'Ada')).toBe(
      'https://cdn.discordapp.com/avatars/123/hash.png?size=128',
    );
  });

  it('never sends a guest id to the Discord CDN', () => {
    expect(avatarFor('gabc', null, 'guest', 'Ada')).not.toContain('discordapp.com');
  });
});
