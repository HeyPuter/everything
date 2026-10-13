// Spell checking in more than one dictionary: US and UK English, each
// stretch of text checked in its own language.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createText } from '../src/model/nodes.js';
import { createSpeller, setSpeller, dictionaryKey, loadedSpeller, DICTIONARIES } from '../src/features/type/spell-dict.js';
import { spellIssues, dictionarySegments } from '../src/features/type/spelling.js';

const dir = path.resolve(import.meta.dirname, '../public/dictionaries');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
let us;
let gb;

beforeAll(() => {
  us = createSpeller({ aff: read(DICTIONARIES['en-US'].aff), dic: read(DICTIONARIES['en-US'].dic) });
  gb = createSpeller({ aff: read(DICTIONARIES['en-GB'].aff), dic: read(DICTIONARIES['en-GB'].dic) });
  setSpeller(us, 'en-US');
  setSpeller(gb, 'en-GB');
});

describe('spelling dictionaries', () => {
  it('maps languages to dictionaries', () => {
    expect(dictionaryKey('en-US')).toBe('en-US');
    expect(dictionaryKey('en-CA')).toBe('en-US');
    expect(dictionaryKey('en-GB')).toBe('en-GB');
    expect(dictionaryKey('en-AU')).toBe('en-GB');
    expect(dictionaryKey('de-DE')).toBe(null);
    expect(dictionaryKey('none')).toBe(null);
    expect(loadedSpeller('en-GB')).toBe(gb);
  });

  it('spells British English with the UK word list', () => {
    expect(gb.correct('colour')).toBe(true);
    expect(gb.correct('organise')).toBe(true);
    expect(us.correct('colour')).toBe(false);
    expect(us.correct('color')).toBe(true);
    expect(gb.suggest('colur')).toContain('colour');
  });

  it('checks each stretch of a text in its own language', () => {
    const t = { ...createText('color colour Farbe teh', 0, 0), runs: [{ len: 6 }, { len: 7, language: 'en-GB' }, { len: 6, language: 'de-DE' }, { len: 3 }] };
    expect(dictionarySegments(t).map((s) => s.dict)).toEqual(['en-US', 'en-GB', null, 'en-US']);
    const issues = spellIssues(t, loadedSpeller);
    expect(issues.map((i) => [i.word, i.dict])).toEqual([['teh', 'en-US']]);
    // The same words in UK English: "color" is the misspelling.
    const uk = { ...createText('color colour', 0, 0), char: { ...createText('', 0, 0).char, language: 'en-GB' } };
    expect(spellIssues(uk, loadedSpeller).map((i) => i.word)).toEqual(['color']);
    // A dictionary still loading leaves its text unchecked for now.
    expect(spellIssues(uk, () => null)).toEqual([]);
  });

  it('ships the UK word list with its notices, unmodified', () => {
    const lic = read('en-GB-LICENSE.txt');
    expect(lic).toContain('Copyright 2000-2018 by Kevin Atkinson');
    expect(createHash('sha256').update(fs.readFileSync(path.join(dir, 'en-GB.dic'))).digest('hex')).toBe('869fe17ba4ee4b5401c60a666ee2d6a3dcc237f460b7294435df1cc6a799aa57');
  });
});
