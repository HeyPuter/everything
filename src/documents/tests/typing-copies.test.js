import { expect, it } from 'vitest';
import { ParagraphOwners, copyAfterTyping, sameAsCopy } from '../src/engine/typing-copies.js';

it('takes a copy for the value only when structuredClone would give the same now', () => {
  const value = { a: 1, list: [{ x: NaN }, { y: -0 }], nested: { s: 'text', u: undefined } };
  expect(sameAsCopy(value, structuredClone(value))).toBe(true);
  const changed = structuredClone(value); changed.list[0].x = 2;
  expect(sameAsCopy(value, changed)).toBe(false);
  // A key holding undefined is not a missing key, -0 is not 0, and the order of keys counts.
  const missing = structuredClone(value); delete missing.nested.u;
  expect(sameAsCopy(value, missing)).toBe(false);
  const zero = structuredClone(value); zero.list[1].y = 0;
  expect(sameAsCopy(value, zero)).toBe(false);
  expect(sameAsCopy({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
  // Arrays of another length (holes too) and objects other than plain ones count as changed.
  expect(sameAsCopy([1, , 3], [1, undefined, 3])).toBe(false);
  expect(sameAsCopy({ when: new Date(0) }, structuredClone({ when: new Date(0) }))).toBe(false);
  // What the value shares, the copy shares.
  const part = { k: 1 }, sharing = { a: part, b: part };
  expect(sameAsCopy(sharing, structuredClone(sharing))).toBe(true);
  expect(sameAsCopy(sharing, { a: { k: 1 }, b: { k: 1 } })).toBe(false);
  expect(sameAsCopy({ a: { k: 1 }, b: { k: 1 } }, structuredClone(sharing))).toBe(false);
});

const p = (id, text) => ({ id, runs: [{ text }] });
it('copies only the paragraphs a keystroke replaced, and the paragraphs beside it that changed in place', () => {
  const live = [p('a', 'One'), p('b', 'Two'), p('c', 'Three'), p('d', 'Four'), p('e', 'Five')];
  const copy = { comments: [], tables: [], styles: {}, stylesEnabled: false, numbering: {}, pageSettings: {}, paragraphs: structuredClone(live) };
  const owners = new ParagraphOwners(live);
  const now = [...live]; now[2] = p('c', 'Three!');
  const next = copyAfterTyping({ live, copy, reach: [1, 3] }, now, 2, owners);
  expect(next.paragraphs).toEqual(structuredClone(now));
  expect(next.paragraphs.filter((q, i) => q !== copy.paragraphs[i]).map(q => q.id)).toEqual(['c']);
  expect(next.paragraphs[2]).not.toBe(now[2]);
  // Changed in place beside the edit (in reach), a paragraph is copied again; far from it, it is not looked at.
  const later = [...now]; later[3].runs[0].text = 'Four!';
  const after = copyAfterTyping({ live: now, copy: next, reach: [1, 3] }, later, 2, owners);
  expect(after.paragraphs[3]).toEqual({ id: 'd', runs: [{ text: 'Four!' }] });
  expect(after.paragraphs[2]).toBe(next.paragraphs[2]);
});

it('copies the whole document when a replaced paragraph shares an object with another', () => {
  const shared = { k: 1 }, live = [p('a', 'One'), p('b', 'Two'), p('c', 'Three')];
  live[0].runs[0].extra = shared; live[2].runs[0].extra = shared;
  const copy = { paragraphs: structuredClone(live) }, owners = new ParagraphOwners(live);
  const now = [{ ...live[0], runs: [{ ...live[0].runs[0], text: 'One!' }] }, live[1], live[2]];
  expect(copyAfterTyping({ live, copy, reach: [-1, 1] }, now, 0, owners)).toBe(null);
  // Not shared any more, the next keystroke copies its paragraph alone again.
  const later = [{ ...now[0], runs: [{ text: 'One!!' }] }, live[1], live[2]];
  const next = copyAfterTyping({ live: now, copy: { paragraphs: structuredClone(now) }, reach: [-1, 1] }, later, 0, owners);
  expect(next.paragraphs.map(q => q.runs[0].text)).toEqual(['One!!', 'Two', 'Three']);
  expect(next.paragraphs[2].runs[0].extra).toEqual(shared);
});
