import { expect, it } from 'vitest';
import { SpellingSkips } from '../src/features/type/spelling-skips';
import { fromPlainText, plainText } from '../src/imaging/text/model';
import { replaceAll } from '../src/imaging/text/find';

it('ignores only the chosen occurrence in its layer and document', () => {
  const skips = new SpellingSkips(), owner = {}, other = {};
  const hits = [{ start: 0, end: 3, word: 'teh' }, { start: 4, end: 7, word: 'teh' }];
  skips.ignore(owner, 'same-id', 'teh teh', hits[0]);
  expect(skips.filter(owner, 'same-id', 'teh teh', hits)).toEqual([hits[1]]);
  expect(skips.filter(other, 'same-id', 'teh teh', hits)).toEqual(hits);
  expect(skips.filter(owner, 'another-layer', 'teh teh', hits)).toEqual(hits);
});

it('rechecks occurrences after unrelated edits instead of reusing old offsets', () => {
  const skips = new SpellingSkips(), owner = {};
  const hit = { start: 0, end: 3, word: 'teh' };
  skips.ignore(owner, 'a', 'teh', hit);
  expect(skips.filter(owner, 'a', 'teh new', [hit])).toEqual([hit]);
  expect(skips.filter(owner, 'a', 'teh', [hit])).toEqual([hit]);
});

for (const replacement of ['a', 'words', '😀 word']) it(`keeps an ignored occurrence aligned after correction to ${replacement}`, () => {
  const skips = new SpellingSkips(), owner = {};
  const before = 'wrod teh';
  skips.ignore(owner, 'a', before, { start: 5, end: 8, word: 'teh' });
  const result = replaceAll(fromPlainText(before), 'wrod', replacement);
  const after = plainText(result.content);
  skips.remap(owner, 'a', before, after, result.mapIndex);
  const hit = { start: after.indexOf('teh'), end: after.length, word: 'teh' };
  expect(skips.filter(owner, 'a', after, [hit])).toEqual([]);
});

it('does not keep an ignored range when that word was replaced', () => {
  const skips = new SpellingSkips(), owner = {};
  const before = 'teh';
  skips.ignore(owner, 'a', before, { start: 0, end: 3, word: 'teh' });
  const result = replaceAll(fromPlainText(before), 'teh', 'wrod');
  skips.remap(owner, 'a', before, 'wrod', result.mapIndex);
  const hit = { start: 0, end: 4, word: 'wrod' };
  expect(skips.filter(owner, 'a', 'wrod', [hit])).toEqual([hit]);
});

it('does not remap a newer Ignore choice using an older text snapshot', () => {
  const skips = new SpellingSkips(), owner = {};
  const hit = { start: 4, end: 7, word: 'teh' };
  skips.ignore(owner, 'a', 'new teh', hit);
  skips.remap(owner, 'a', 'teh', 'the', (at) => at);
  expect(skips.filter(owner, 'a', 'new teh', [hit])).toEqual([]);
});
