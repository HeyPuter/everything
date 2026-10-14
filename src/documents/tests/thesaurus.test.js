import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { lookupWord, matchCase, baseForms, prepareThesaurus } from '../src/lib/thesaurus.js';

/** A tiny thesaurus in the generated format: big/large/small, run, mouse, happy/unhappy. */
const fixture = () => ({
  v: 1,
  w: ['big', 'happy', 'large', 'mouse', 'rodent', 'run', 'small', 'sprint', 'unhappy', 'glad'],
  g: ['above average in size', 'enjoying well-being', 'move fast on foot', 'a small rodent'],
  s: [[2, 0, [0, 2], [6]], [2, 1, [1, 9], [8]], [1, 2, [5, 7], []], [0, 3, [3, 4], []]],
  x: [[0], [1], [0], [3], 0, [2], 0, 0, 0, 0],
  e: [['mice', 3, 0], ['ran', 5, 1]],
});

describe('thesaurus lookups', () => {
  it('finds a lemma with synonyms and antonyms, leaving out the word itself', () => {
    const result = lookupWord(fixture(), 'big');
    expect(result).toEqual({ word: 'big', lemma: 'big', senses: [{ pos: 'adjective', gloss: 'above average in size', synonyms: ['large'], antonyms: ['small'] }] });
    expect(lookupWord(fixture(), 'Happy').senses[0]).toMatchObject({ synonyms: ['glad'], antonyms: ['unhappy'] });
  });

  it('resolves irregular forms', () => {
    expect(lookupWord(fixture(), 'mice').lemma).toBe('mouse');
    expect(lookupWord(fixture(), 'ran').lemma).toBe('run');
  });

  it('resolves regular inflections', () => {
    for (const form of ['runs', 'running', 'sprinted']) expect(lookupWord({ ...fixture(), x: [[0], [1], [0], [3], 0, [2], 0, [2], 0, 0] }, form)?.lemma).toMatch(/^(run|sprint)$/);
    expect(lookupWord(fixture(), 'bigger').lemma).toBe('big');
    expect(lookupWord(fixture(), 'happiest').lemma).toBe('happy');
    const lemmas = word => baseForms(word).map(f => f.lemma);
    expect(lemmas('studied')).toContain('study');
    expect(lemmas('boxes')).toContain('box');
    expect(lemmas('making')).toContain('make');
    expect(baseForms('running')[0]).toEqual({ lemma: 'run', pos: 'verb' });
  });

  it('returns null for unknown words and empty input', () => {
    expect(lookupWord(fixture(), 'zzzz')).toBeNull();
    expect(lookupWord(fixture(), '  ')).toBeNull();
    expect(lookupWord(null, 'big')).toBeNull();
  });

  it('copies capitalization onto replacements', () => {
    expect(matchCase('Big', 'large')).toBe('Large');
    expect(matchCase('BIG', 'large')).toBe('LARGE');
    expect(matchCase('big', 'large')).toBe('large');
    expect(matchCase('big', 'Large')).toBe('Large');
  });
});

describe('bundled thesaurus data', () => {
  const data = prepareThesaurus(JSON.parse(readFileSync('public/thesaurus/en.json', 'utf8')));
  it('answers common lookups', () => {
    const happy = lookupWord(data, 'happy');
    expect(happy.senses.flatMap(s => s.antonyms).some(w => ['unhappy', 'sad'].includes(w))).toBe(true);
    expect(lookupWord(data, 'big').senses.flatMap(s => s.synonyms)).toContain('large');
    const ran = lookupWord(data, 'ran');
    expect(ran.lemma).toBe('run');
    expect(ran.senses[0].pos).toBe('verb');
    expect(lookupWord(data, 'quickly').senses[0].synonyms.length).toBeGreaterThan(0);
  });
});
