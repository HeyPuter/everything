import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { findText } from '../src/engine/search.js';
import { advancedFind } from '../src/engine/advanced-search.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; });

// Autocorrect turns typed quotes into typographic ones, while the Find box takes them as typed.
const typed = 'I don’t know. It’s “fine”, isn\'t it? ‘Quoted’ and "plain".';
const find = (query, options) => findText([paragraph(typed)], query, options).map(m => m.text);
const advanced = (query, options = {}) => advancedFind([paragraph(typed)], query, { advanced: true, ...options }, {}).map(m => m.text);

it('finds typographic quotes with a straight quote typed in Find', () => {
  expect(find("don't")).toEqual(['don’t']);
  expect(find("It's", { matchCase: true, wholeWord: true })).toEqual(['It’s']);
  expect(find('"fine"')).toEqual(['“fine”']);
  expect(find("'")).toEqual(['’', '’', "'", '‘', '’']);
  expect(find('"')).toEqual(['“', '”', '"', '"']);
  // A query with curly quotes only still finds exactly those.
  expect(find('don’t')).toEqual(['don’t']);
  expect(find('’')).toEqual(['’', '’', '’']);
  // The matches are where the document's own text is.
  const [match] = findText([paragraph(typed)], "isn't");
  expect(typed.slice(match.start, match.end)).toBe("isn't");
});

it('finds them with the advanced options too, but not with wildcards', () => {
  expect(advanced("don't", { matchPrefix: true })).toEqual(['don’t']);
  expect(advanced('"fine"^?')).toEqual(['“fine”,']);
  expect(advanced("don't", { wildcards: true })).toEqual([]);
  expect(advanced('[[]')).toEqual([]);
});

it('replaces typographic quotes found by a straight one', () => {
  const doc = new TextDocument([paragraph(typed)]);
  expect(doc.replaceMatches("don't", 'do not', {}, true)).toBe(1);
  expect(doc.text).toBe(typed.replace('don’t', 'do not'));
});
