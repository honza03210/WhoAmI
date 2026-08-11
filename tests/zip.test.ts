import { describe, expect, it } from 'vitest';
import { ZipError, isJunkPath, isZip, leafName, readZip } from '../client/src/zip';
import { makeZip, type ZipSource } from './zipFixture';

const decoder = new TextDecoder();

const zip = (sources: ZipSource[], comment?: string): Blob => new Blob([makeZip(sources, comment)]);

/** The archive most of these are about: three photos, deflated, in a folder. */
const party = (): Blob =>
  zip([
    { path: 'party/' },
    { path: 'party/02_bram.jpg', data: 'bram bram bram bram' },
    { path: 'party/01_ada.jpg', data: 'ada ada ada ada ada' },
    { path: 'party/10_cleo.jpg', data: 'cleo cleo cleo cleo' },
  ]);

describe('reading an archive', () => {
  it('lists the files inside it', async () => {
    const entries = await readZip(party());
    expect(entries.map((entry) => entry.name)).toEqual(['01_ada.jpg', '02_bram.jpg', '10_cleo.jpg']);
    expect(entries[0]?.path).toBe('party/01_ada.jpg');
  });

  it('unpacks deflated and stored entries alike', async () => {
    const entries = await readZip(
      zip([
        { path: 'squashed.jpg', data: 'x'.repeat(5000) },
        { path: 'plain.jpg', data: 'kept as it is', store: true },
      ]),
    );

    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    expect(decoder.decode(await byName['squashed.jpg']?.read())).toBe('x'.repeat(5000));
    expect(decoder.decode(await byName['plain.jpg']?.read())).toBe('kept as it is');
  });

  it('knows how big each file comes out before unpacking any of it', async () => {
    // The whole point: 5000 bytes of one letter compress to nothing, and the size still reads
    // 5000 without a byte being inflated.
    const [entry] = await readZip(zip([{ path: 'big.jpg', data: 'x'.repeat(5000) }]));
    expect(entry?.size).toBe(5000);
  });

  it('sorts by name, because a zip directory is in whatever order the archiver walked', async () => {
    const entries = await readZip(
      zip([{ path: '10_j.jpg', data: 'j' }, { path: '2_b.jpg', data: 'b' }, { path: '1_a.jpg', data: 'a' }]),
    );
    // Numeric collation, so 2 sorts before 10 rather than after it.
    expect(entries.map((entry) => entry.name)).toEqual(['1_a.jpg', '2_b.jpg', '10_j.jpg']);
  });

  it('finds the directory past a trailing archive comment', async () => {
    const entries = await readZip(zip([{ path: 'ada.jpg', data: 'ada' }], 'zipped on a Tuesday'));
    expect(entries.map((entry) => entry.name)).toEqual(['ada.jpg']);
  });

  it('skips folders and the metadata an archiver adds around the real files', async () => {
    const entries = await readZip(
      zip([
        { path: 'party/' },
        { path: 'party/ada.jpg', data: 'ada' },
        { path: '__MACOSX/party/._ada.jpg', data: 'resource fork' },
        { path: 'party/.DS_Store', data: 'finder' },
        { path: 'party/Thumbs.db', data: 'explorer' },
      ]),
    );
    expect(entries.map((entry) => entry.name)).toEqual(['ada.jpg']);
  });
});

describe('an archive that cannot be used', () => {
  const fails = async (archive: Blob): Promise<string> => {
    try {
      const entries = await readZip(archive);
      await Promise.all(entries.map((entry) => entry.read()));
    } catch (error) {
      return error instanceof ZipError ? error.message : `wrong error type: ${String(error)}`;
    }
    return 'no error';
  };

  it('is not a zip at all', async () => {
    expect(await fails(new Blob(['just some text, sitting there, not being a zip']))).toMatch(/not a zip/i);
    expect(await fails(new Blob(['PK']))).toMatch(/not a zip/i);
  });

  it('is empty', async () => {
    expect(await fails(zip([]))).toMatch(/empty/i);
  });

  it('is password-protected', async () => {
    // General purpose bit 0 is the encryption flag.
    expect(await fails(zip([{ path: 'ada.jpg', data: 'ada', flags: 0x1 }]))).toMatch(/password/i);
  });

  it('uses a compression the browser has no inflater for', async () => {
    expect(await fails(zip([{ path: 'ada.jpg', data: 'ada', method: 14 }]))).toMatch(/compression/i);
  });

  it('has been truncated, so a file comes out shorter than the directory promised', async () => {
    expect(await fails(zip([{ path: 'ada.jpg', data: 'ada', claimSize: 9999 }]))).toMatch(/damaged/i);
  });

  it('claims to be deflated but holds bytes that are not', async () => {
    expect(await fails(zip([{ path: 'ada.jpg', data: 'not deflate', store: true, method: 8 }]))).toMatch(
      /damaged/i,
    );
  });

  it('names its files but never wrote them', async () => {
    // A directory pointing at an offset with no local header behind it.
    const bytes = makeZip([{ path: 'ada.jpg', data: 'ada' }]);
    bytes.fill(0, 0, 4); // wipe the local header's signature
    expect(await fails(new Blob([bytes]))).toMatch(/could not be found/i);
  });

  it('is listable even when its contents are rotten, because listing never unpacks', async () => {
    const bytes = makeZip([{ path: 'ada.jpg', data: 'ada', claimSize: 9999 }]);
    const entries = await readZip(new Blob([bytes]));
    expect(entries.map((entry) => entry.name)).toEqual(['ada.jpg']);
    await expect(entries[0]?.read()).rejects.toThrow(ZipError);
  });
});

describe('recognising a zip by its bytes', () => {
  it('takes one whatever the browser called it', async () => {
    expect(await isZip(zip([{ path: 'ada.jpg', data: 'ada' }]))).toBe(true);
    // An archive with nothing in it starts with the end-of-directory record instead.
    expect(await isZip(zip([]))).toBe(true);
  });

  it('is not fooled by a photo, or by a name', async () => {
    expect(await isZip(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]))).toBe(false);
    expect(await isZip(new Blob(['PKZIP was here']))).toBe(false);
    expect(await isZip(new Blob([]))).toBe(false);
  });
});

describe('archive paths', () => {
  it('keeps only the file itself', () => {
    expect(leafName('party/2024/01_ada.jpg')).toBe('01_ada.jpg');
    expect(leafName('ada.jpg')).toBe('ada.jpg');
  });

  it('recognises what an archiver added and the host did not', () => {
    for (const junk of ['__MACOSX/._ada.jpg', 'party/__MACOSX/._ada.jpg', '.DS_Store', 'party/Thumbs.db']) {
      expect(isJunkPath(junk)).toBe(true);
    }
    for (const real of ['ada.jpg', 'party/ada.jpg', 'party/ada.something.jpg']) {
      expect(isJunkPath(real)).toBe(false);
    }
  });
});
