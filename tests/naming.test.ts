import { describe, expect, it } from 'vitest';
import { displayNameFromFile, slugify, uniqueId } from '../scripts/lib/naming';

describe('displayNameFromFile', () => {
  it('uses the filename as the character name', () => {
    expect(displayNameFromFile('Ada.jpg')).toBe('Ada');
  });

  it('drops an ordering prefix so photos can be sequenced by filename', () => {
    expect(displayNameFromFile('01_Ada.jpg')).toBe('Ada');
    expect(displayNameFromFile('01-Ada.jpg')).toBe('Ada');
    expect(displayNameFromFile('01.Ada.jpg')).toBe('Ada');
    expect(displayNameFromFile('01 Ada.jpg')).toBe('Ada');
    expect(displayNameFromFile('999_Ada.jpg')).toBe('Ada');
  });

  it('turns underscores into spaces but keeps hyphens', () => {
    expect(displayNameFromFile('Bram_Smith.png')).toBe('Bram Smith');
    expect(displayNameFromFile('Anne-Marie.jpg')).toBe('Anne-Marie');
    expect(displayNameFromFile('02_Anne-Marie_Jones.jpg')).toBe('Anne-Marie Jones');
  });

  it('keeps digits that are part of the name rather than an ordering prefix', () => {
    // No separator after the digits, so "3PO" is the name, not item 3.
    expect(displayNameFromFile('C3PO.jpg')).toBe('C3PO');
  });

  it('falls back to the bare filename when stripping would empty it', () => {
    expect(displayNameFromFile('01.jpg')).toBe('01');
    expect(displayNameFromFile('7.png')).toBe('7');
  });

  it('collapses runs of whitespace', () => {
    expect(displayNameFromFile('Bram___Smith.png')).toBe('Bram Smith');
    expect(displayNameFromFile('Bram   Smith.png')).toBe('Bram Smith');
  });

  it('ignores directory components', () => {
    expect(displayNameFromFile('packs/demo/01_Ada.jpg')).toBe('Ada');
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Bram Smith')).toBe('bram-smith');
  });

  it('strips diacritics rather than dropping the letter', () => {
    expect(slugify('Tomáš')).toBe('tomas');
    expect(slugify('Zoë O’Brien')).toBe('zoe-o-brien');
    expect(slugify('Jürgen')).toBe('jurgen');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  Ada  ')).toBe('ada');
    expect(slugify('!!Ada!!')).toBe('ada');
  });

  it('never returns an empty id', () => {
    // A name of only non-Latin characters would otherwise produce "", which would collide
    // across every such character and overwrite tiles.
    expect(slugify('***')).toBe('character');
    expect(slugify('日本語')).toBe('character');
    expect(slugify('')).toBe('character');
  });
});

describe('uniqueId', () => {
  it('returns the plain slug when free', () => {
    expect(uniqueId('Ada', new Set())).toBe('ada');
  });

  it('suffixes duplicates so two people called Sam do not overwrite each other', () => {
    const taken = new Set<string>();
    expect(uniqueId('Sam', taken)).toBe('sam');
    expect(uniqueId('Sam', taken)).toBe('sam-2');
    expect(uniqueId('Sam', taken)).toBe('sam-3');
  });

  it('treats names that slug identically as duplicates', () => {
    const taken = new Set<string>();
    expect(uniqueId('Bram Smith', taken)).toBe('bram-smith');
    expect(uniqueId('bram  smith', taken)).toBe('bram-smith-2');
  });

  it('does not reuse an id that a later name would have claimed', () => {
    const taken = new Set<string>();
    expect(uniqueId('Sam', taken)).toBe('sam');
    // Someone literally named "Sam 2" takes sam-2 first...
    expect(uniqueId('Sam 2', taken)).toBe('sam-2');
    // ...so the second "Sam" must skip past it.
    expect(uniqueId('Sam', taken)).toBe('sam-3');
  });

  it('records every id it hands out', () => {
    const taken = new Set<string>();
    uniqueId('Ada', taken);
    uniqueId('Ada', taken);
    expect([...taken].sort()).toEqual(['ada', 'ada-2']);
  });
});
