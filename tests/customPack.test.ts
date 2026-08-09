import { describe, expect, it } from 'vitest';
import {
  checkPhoto,
  commitDraft,
  draftHasExpired,
  fullFile,
  isValidFile,
  isValidToken,
  newDraft,
  packStorage,
  tileFile,
  type PackDraft,
} from '../server/customPack';
import { CUSTOM_PACK_MAX, CUSTOM_PACK_MIN, CUSTOM_PHOTO_MAX_BYTES } from '../server/protocol';

const characters = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `p${index}`, name: `Person ${index}` }));

/** A draft with every photo for `count` characters already stored. */
function draftWith(count: number, ownerId = 'host'): PackDraft {
  const draft = newDraft(ownerId, 'Party');
  for (const character of characters(count)) {
    draft.stored.push(tileFile(character.id), fullFile(character.id));
  }
  return draft;
}

describe('upload tokens', () => {
  it('are unguessable and unique', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newDraft('host', 'x').token));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(isValidToken(token)).toBe(true);
  });

  it('reject anything that is not one', () => {
    for (const bad of ['', 'nope', '../secrets', 'ABCDEF0123456789abcdef0123456789', 'a'.repeat(31)]) {
      expect(isValidToken(bad)).toBe(false);
    }
  });

  it('namespace stored images so one pack can be deleted without touching another', () => {
    const one = packStorage.imageKey('a'.repeat(32), 'ada.webp');
    const two = packStorage.imageKey('b'.repeat(32), 'ada.webp');
    expect(one).not.toBe(two);
    expect(one.startsWith(packStorage.prefixFor('a'.repeat(32)))).toBe(true);
    expect(two.startsWith(packStorage.prefixFor('a'.repeat(32)))).toBe(false);
  });
});

describe('file names', () => {
  it('accepts the two shapes the encoder produces', () => {
    expect(isValidFile('ada.webp')).toBe(true);
    expect(isValidFile('ada@full.webp')).toBe(true);
    expect(isValidFile(tileFile('anne-marie'))).toBe(true);
    expect(isValidFile(fullFile('sam-2'))).toBe(true);
  });

  it('rejects traversal and anything that is not a webp', () => {
    for (const bad of ['../room', 'ada.png', 'ada.webp.exe', 'a/b.webp', 'Ada.webp', '.webp', '@full.webp']) {
      expect(isValidFile(bad)).toBe(false);
    }
  });
});

describe('accepting a photo', () => {
  it('takes a well-formed one', () => {
    expect(checkPhoto(newDraft('host', 'x'), 'host', 'ada.webp', 20_000).ok).toBe(true);
  });

  it('is refused for anyone but the uploader', () => {
    const outcome = checkPhoto(newDraft('host', 'x'), 'gatecrasher', 'ada.webp', 20_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok || outcome.status).toBe(403);
  });

  it('refuses an empty or oversized photo', () => {
    const draft = newDraft('host', 'x');
    expect(checkPhoto(draft, 'host', 'ada.webp', 0).ok).toBe(false);

    const tooBig = checkPhoto(draft, 'host', 'ada.webp', CUSTOM_PHOTO_MAX_BYTES + 1);
    expect(tooBig.ok).toBe(false);
    expect(tooBig.ok || tooBig.status).toBe(413);
    // The cap itself is fine; only past it is refused.
    expect(checkPhoto(draft, 'host', 'ada.webp', CUSTOM_PHOTO_MAX_BYTES).ok).toBe(true);
  });

  it('refuses a name that could escape the pack', () => {
    expect(checkPhoto(newDraft('host', 'x'), 'host', '../../room', 10).ok).toBe(false);
  });

  it('stops a client spending the room’s storage', () => {
    const draft = draftWith(CUSTOM_PACK_MAX);
    const outcome = checkPhoto(draft, 'host', 'extra.webp', 10);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok || outcome.error).toBe('too_many_photos');
  });
});

describe('committing a board', () => {
  it('publishes a pack once every photo arrived', () => {
    const outcome = commitDraft(draftWith(CUSTOM_PACK_MIN), 'host', characters(CUSTOM_PACK_MIN));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.characters).toHaveLength(CUSTOM_PACK_MIN);
    expect(outcome.value.name).toBe('Party');
    expect(isValidToken(outcome.value.token)).toBe(true);
  });

  it('refuses a board with a photo missing', () => {
    // Claims one more character than was actually uploaded.
    const outcome = commitDraft(draftWith(CUSTOM_PACK_MIN), 'host', characters(CUSTOM_PACK_MIN + 1));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok || outcome.error).toBe('missing_photo');
  });

  it('holds the size limits the picker advertises', () => {
    const tooFew = commitDraft(draftWith(CUSTOM_PACK_MIN - 1), 'host', characters(CUSTOM_PACK_MIN - 1));
    expect(tooFew.ok || tooFew.error).toBe('bad_photo_count');

    const tooMany = commitDraft(draftWith(CUSTOM_PACK_MAX + 1), 'host', characters(CUSTOM_PACK_MAX + 1));
    expect(tooMany.ok || tooMany.error).toBe('bad_photo_count');
  });

  it('refuses duplicate ids, which would collide on the board', () => {
    const draft = draftWith(CUSTOM_PACK_MIN);
    const duplicated = characters(CUSTOM_PACK_MIN).map((character) => ({ ...character, id: 'p0' }));
    const outcome = commitDraft(draft, 'host', duplicated);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok || outcome.error).toBe('duplicate_character');
  });

  it('refuses an id that is not a slug', () => {
    const draft = draftWith(CUSTOM_PACK_MIN);
    const bad = characters(CUSTOM_PACK_MIN);
    bad[0] = { id: '../escape', name: 'Nope' };
    const outcome = commitDraft(draft, 'host', bad);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok || outcome.error).toBe('bad_character_id');
  });

  it('is refused for anyone but the uploader', () => {
    const outcome = commitDraft(draftWith(CUSTOM_PACK_MIN), 'someone-else', characters(CUSTOM_PACK_MIN));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok || outcome.status).toBe(403);
  });

  it('bounds the names it publishes and falls back to the id', () => {
    const draft = draftWith(CUSTOM_PACK_MIN);
    const named = characters(CUSTOM_PACK_MIN);
    named[0] = { id: 'p0', name: 'x'.repeat(200) };
    named[1] = { id: 'p1', name: '   ' };

    const outcome = commitDraft(draft, 'host', named);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.characters[0]?.name).toHaveLength(40);
    expect(outcome.value.characters[1]?.name).toBe('p1');
  });

  it('falls back to a usable pack name', () => {
    const draft = newDraft('host', '   ');
    for (const character of characters(CUSTOM_PACK_MIN)) {
      draft.stored.push(tileFile(character.id), fullFile(character.id));
    }
    const outcome = commitDraft(draft, 'host', characters(CUSTOM_PACK_MIN));
    expect(outcome.ok && outcome.value.name).toBe('Custom');
  });
});

describe('abandoned uploads', () => {
  it('expire so they cannot be resumed hours later', () => {
    const draft = newDraft('host', 'x');
    expect(draftHasExpired(draft)).toBe(false);
    expect(draftHasExpired(draft, Date.now() + 31 * 60 * 1000)).toBe(true);
  });
});
