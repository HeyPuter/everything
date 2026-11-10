import { it, expect } from 'vitest';
import { nextCitation } from '../src/engine/authorities.js';

/**
 * Mark Citation's Next searched the document for a likely citation with a pattern that could start anywhere: a
 * long capitalized word, number or run of section signs (in a document anyone can send) was scanned again from
 * each of its characters, so Next took time growing with the square of its length (seconds at 40,000
 * characters, minutes at a few hundred thousand). Each kind of citation now starts only where a word, number or
 * run of section signs does.
 */
const SIZE = 300000;
const found = (text, from = 0) => { const match = nextCitation(text, from); return match && [match.index, match[0]]; };

it('finds no citation in a long word, number or run of section signs in linear time', () => {
  for (const long of ['CUd'.repeat(SIZE / 3), '1'.repeat(SIZE), '§'.repeat(SIZE), 'A.'.repeat(SIZE / 2)]) {
    const start = performance.now();
    expect(nextCitation(`${long} end`)).toBe(null);
    expect(performance.now() - start).toBeLessThan(1000);
  }
});

it('finds each kind of citation, from the selection on and then from the start again', () => {
  const text = 'See Brown v. Board of Education, 347 U.S. 483; 42 U.S.C. § 1983; §§ 12.3(a); Id. at 5; supra note 2.';
  expect(found(text)).toEqual([0, 'See Brown v. Board of Education']);
  expect(found(text, 4)).toEqual([4, 'Brown v. Board of Education']);
  expect(found(text, 32)).toEqual([47, '42 U.S.C. § 1983']);
  expect(found(text, 64)).toEqual([65, '§§ 12.3(a)']);
  expect(found(text, 76)).toEqual([77, 'Id.']);
  expect(found(text, 80)).toEqual([87, 'supra']);
  expect(found(text, 94)).toEqual([0, 'See Brown v. Board of Education']);
  expect(found('No citations here.', 3)).toBe(null);
  // A citation does not start inside a word, a number or a run of section signs.
  expect(found('X42 U.S.C. § 1 and 9§§ 2')).toEqual([1, '42 U.S.C. § 1']);
  expect(found('word 1234 U.S.C. § 5')).toEqual([5, '1234 U.S.C. § 5']);
  expect(found('§§§ 6', 1)).toEqual([0, '§§§ 6']);
});
