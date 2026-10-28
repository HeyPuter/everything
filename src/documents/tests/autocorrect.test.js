import { describe, it, expect, beforeEach } from 'vitest';
import { correction, insideAddress, smartQuote, opensQuote, replaceTarget, paragraphText, autocorrectAt, autocorrectEnabled, setAutocorrectEnabled, autocorrectHinted, sentenceCapital, endsWithAbbreviation, capitalizeSentencesEnabled, setCapitalizeSentencesEnabled } from '../src/lib/autocorrect.js';

describe('autocorrect rules', () => {
  it('turns straight quotes into typographic ones by what comes before', () => {
    expect(correction('"', '"')).toEqual({ back: 1, text: '“' });
    expect(correction('He said "', '"')).toEqual({ back: 1, text: '“' });
    expect(correction('He said “hi"', '"')).toEqual({ back: 1, text: '”' });
    expect(correction('("', '"')).toEqual({ back: 1, text: '“' });
    expect(correction("it'", "'")).toEqual({ back: 1, text: '’' });
    expect(correction(" '", "'")).toEqual({ back: 1, text: '‘' });
    expect(smartQuote('a', 'b')).toBe('a');
    expect(opensQuote('—')).toBe(true);
    expect(opensQuote('a')).toBe(false);
  });

  it('makes an em dash from two hyphens once the next character is typed', () => {
    expect(correction('word--n', 'n')).toEqual({ back: 3, text: '—n' });
    expect(correction('word--"', '"')).toEqual({ back: 3, text: '—“' });
    expect(correction('word--', '-')).toBeNull();
    expect(correction('word---', '-')).toBeNull();
    expect(correction('word---x', 'x')).toBeNull();
    expect(correction('word-- ', ' ')).toBeNull();
    expect(correction('word -- n', 'n')).toEqual({ back: 5, text: ' — n' });
    expect(correction('word -- ', ' ')).toBeNull();
    expect(correction(' -- n', 'n')).toBeNull();
  });

  it('makes an ellipsis, symbols, and fractions', () => {
    expect(correction('Wait...', '.')).toEqual({ back: 3, text: '…' });
    expect(correction('Wait....', '.')).toBeNull();
    expect(correction('Copyright (c)', ')')).toEqual({ back: 3, text: '©' });
    expect(correction('Brand (R)', ')')).toEqual({ back: 3, text: '®' });
    expect(correction('Name (tm)', ')')).toEqual({ back: 4, text: '™' });
    expect(correction('f(x)', ')')).toBeNull();
    expect(correction('Add 1/2 ', ' ')).toEqual({ back: 4, text: '½ ' });
    expect(correction('3/4 ', ' ')).toEqual({ back: 4, text: '¾ ' });
    expect(correction('11/2 ', ' ')).toBeNull();
    expect(correction('1/3 ', ' ')).toBeNull();
  });

  it('capitalizes the pronoun i once its word ends', () => {
    expect(correction('and i ', ' ')).toEqual({ back: 2, text: 'I ' });
    expect(correction('i,', ',')).toEqual({ back: 2, text: 'I,' });
    expect(correction('so i?', '?')).toEqual({ back: 2, text: 'I?' });
    expect(correction('then i’m ', ' ')).toEqual({ back: 4, text: 'I’m ' });
    expect(correction("then i'll ", ' ')).toEqual({ back: 5, text: "I'll " });
    expect(correction('she said “i ', ' ')).toEqual({ back: 2, text: 'I ' });
    // Not inside another word, an abbreviation, a list numeral or an address.
    expect(correction('hi ', ' ')).toBeNull();
    expect(correction('ski ', ' ')).toBeNull();
    expect(correction('so do i. ', ' ')).toEqual({ back: 3, text: 'I. ' });
    expect(correction('i.', '.')).toBeNull();
    expect(correction('i. ', ' ')).toBeNull();
    expect(correction('so i.e. ', ' ')).toBeNull();
    expect(correction('(i)', ')')).toBeNull();
    expect(correction('(i ', ' ')).toBeNull();
    expect(correction('a/i ', ' ')).toBeNull();
    expect(correction('www.x.com/i ', ' ')).toBeNull();
    expect(correction('i’mx ', ' ')).toBeNull();
  });

  it('leaves ordinary typing alone', () => {
    expect(correction('hello', 'o')).toBeNull();
    expect(correction('hello ', ' ')).toBeNull();
    expect(correction('', 'a')).toBeNull();
    expect(correction('abc', 'x')).toBeNull();
    expect(correction(null, 'a')).toBeNull();
    expect(correction('ab', 'ab')).toBeNull();
  });

  it('leaves quotes, hyphens, and periods inside web and email addresses as typed', () => {
    expect(correction('see https://example.com/foo--b', 'b')).toBeNull();
    expect(correction('https://x.com/?q="', '"')).toBeNull();
    expect(correction('https://x.com/a...', '.')).toBeNull();
    expect(correction('www.example.com/a--b', 'b')).toBeNull();
    expect(correction('mailto:joe--x', 'x')).toBeNull();
    expect(correction("joe@x.com's", "'")).toBeNull();
    expect(insideAddress('plain text a--b')).toBe(false);
    // An address typed after an opening bracket or quote is still an address.
    expect(correction('(https://example.com/foo--b', 'b')).toBeNull();
    expect(correction('“www.example.com/a--b', 'b')).toBeNull();
    expect(correction('<http://example.com/a...', '.')).toBeNull();
    expect(insideAddress('(mailto:joe--x')).toBe(true);
    // Once the address is finished, ordinary corrections resume.
    expect(sentenceCapital('Wait… n', 'n')).toEqual({ back: 1, text: 'N' });
    expect(correction('https://example.com "', '"')).toEqual({ back: 1, text: '“' });
  });

  it('targets the characters before the caret', () => {
    expect(replaceTarget('p1', 5, 3)).toEqual({
      kind: 'selection',
      start: { kind: 'text', blockId: 'p1', offset: 2, story: { kind: 'story', storyType: 'body' } },
      end: { kind: 'text', blockId: 'p1', offset: 5, story: { kind: 'story', storyType: 'body' } },
      story: { kind: 'story', storyType: 'body' },
    });
    expect(replaceTarget('p1', 1, 3).start.offset).toBe(0);
    expect(paragraphText({ node: { paragraph: { inlines: [{ run: { text: 'a' } }, {}, { run: { text: 'b' } }] } } })).toBe('ab');
  });
});

describe('sentence capitalization', () => {
  it('capitalizes the first lowercase letter of a sentence', () => {
    expect(sentenceCapital('h', 'h')).toEqual({ back: 1, text: 'H' });
    expect(sentenceCapital('  h', 'h')).toEqual({ back: 1, text: 'H' });
    expect(sentenceCapital('Hi there. w', 'w')).toEqual({ back: 1, text: 'W' });
    // A sentence may open with a quote or bracket, and its first letter may be accented; "ß" has no single capital.
    expect(sentenceCapital('"h', 'h')).toEqual({ back: 1, text: 'H' });
    expect(sentenceCapital('Done. “h', 'h')).toEqual({ back: 1, text: 'H' });
    expect(sentenceCapital('Done. (h', 'h')).toEqual({ back: 1, text: 'H' });
    expect(sentenceCapital('ok. é', 'é')).toEqual({ back: 1, text: 'É' });
    expect(sentenceCapital('ok. ß', 'ß')).toBeNull();
    // An abbreviation in brackets or quotes does not end the sentence either.
    expect(sentenceCapital('(e.g. s', 's')).toBeNull();
    expect(sentenceCapital('"e.g." s', 's')).toBeNull();
    expect(sentenceCapital('see fig.) s', 's')).toBeNull();
    expect(sentenceCapital('Really? y', 'y')).toEqual({ back: 1, text: 'Y' });
    expect(sentenceCapital('Wow! s', 's')).toEqual({ back: 1, text: 'S' });
    expect(sentenceCapital('He said "hi." t', 't')).toEqual({ back: 1, text: 'T' });
  });

  it('leaves mid-sentence letters, non-letters, and abbreviations alone', () => {
    expect(sentenceCapital('Hello wor', 'r')).toBeNull();
    expect(sentenceCapital('Hi there. World i', 'i')).toBeNull();
    expect(sentenceCapital('one 5', '5')).toBeNull();
    expect(sentenceCapital('Already X', 'X')).toBeNull();
    expect(sentenceCapital('See e.g. t', 't')).toBeNull();
    expect(sentenceCapital('Ask Dr. s', 's')).toBeNull();
    expect(sentenceCapital('i.e. m', 'm')).toBeNull();
    expect(sentenceCapital('at 5 p.m. t', 't')).toBeNull();
    expect(sentenceCapital('in the U.S. c', 'c')).toBeNull();
    expect(sentenceCapital('on Jan. t', 't')).toBeNull();
    expect(sentenceCapital('see No. 5. t', 't')).toEqual({ back: 1, text: 'T' });
    expect(endsWithAbbreviation('etc. ')).toBe(true);
    expect(endsWithAbbreviation('grasp. ')).toBe(false);
  });
});

describe('autocorrectAt', () => {
  const api = (text) => ({ getNodeById: async () => ({ node: { paragraph: { inlines: [{ run: { text } }] } } }) });

  it('applies capitalization only when asked, and punctuation only when asked', async () => {
    const replace = async () => ({ ok: true, receipt: { success: true } });
    expect(await autocorrectAt(api('h'), replace, { blockId: 'p1', offset: 1 }, 'h')).toEqual({ status: 'none' });
    expect(await autocorrectAt(api('h'), replace, { blockId: 'p1', offset: 1 }, 'h', { capitalize: true })).toEqual({ status: 'applied', fix: { back: 1, text: 'H' } });
    expect(await autocorrectAt(api('a "'), replace, { blockId: 'p1', offset: 3 }, '"', { punctuation: false, capitalize: true })).toEqual({ status: 'none' });
  });

  it('replaces the text before the caret and reports the correction', async () => {
    const calls = [];
    const replace = async (input) => { calls.push(input); return { ok: true, receipt: { success: true } }; };
    const r = await autocorrectAt(api('He said "'), replace, { blockId: 'p1', offset: 9 }, '"');
    expect(r).toEqual({ status: 'applied', fix: { back: 1, text: '“' } });
    expect(calls[0].target.start.offset).toBe(8);
    expect(calls[0].target.end.offset).toBe(9);
    expect(calls[0].replacement).toBe('“');
    // A character earlier in a burst: its end sits before the caret.
    expect(await autocorrectAt(api('He said "ab'), replace, { blockId: 'p1', offset: 9 }, '"')).toMatchObject({ status: 'applied' });
  });

  it('tells a mismatch from nothing to do, and swallows engine refusals', async () => {
    const replace = async () => ({ ok: true, receipt: { success: true } });
    expect(await autocorrectAt(api('He said "'), replace, { blockId: 'p1', offset: 5 }, '"')).toEqual({ status: 'mismatch' });
    expect(await autocorrectAt(api('He said '), replace, { blockId: 'p1', offset: 9 }, '"')).toEqual({ status: 'mismatch' });
    expect(await autocorrectAt(api('plain'), replace, { blockId: 'p1', offset: 5 }, 'n')).toEqual({ status: 'none' });
    expect(await autocorrectAt(api('x'), replace, null, 'x')).toEqual({ status: 'mismatch' });
    expect(await autocorrectAt(api('x'), replace, { blockId: 'p1', offset: 0 }, 'x')).toEqual({ status: 'mismatch' });
    expect(await autocorrectAt({ getNodeById: async () => { throw new Error('gone'); } }, replace, { blockId: 'p1', offset: 1 }, '"')).toEqual({ status: 'none' });
    expect(await autocorrectAt(api('"'), async () => ({ ok: false }), { blockId: 'p1', offset: 1 }, '"')).toEqual({ status: 'none' });
  });
});

describe('autocorrect preference', () => {
  beforeEach(() => { globalThis.localStorage = new Map(); Object.assign(globalThis.localStorage, { getItem(k) { return this.has(k) ? this.get(k) : null; }, setItem(k, v) { this.set(k, v); }, removeItem(k) { this.delete(k); } }); });

  it('is on by default, remembers being turned off, and hints once', () => {
    expect(autocorrectEnabled()).toBe(true);
    setAutocorrectEnabled(false);
    expect(autocorrectEnabled()).toBe(false);
    setAutocorrectEnabled(true);
    expect(autocorrectEnabled()).toBe(true);
    expect(autocorrectHinted()).toBe(false);
    expect(autocorrectHinted()).toBe(true);
  });

  it('capitalization is on by default and remembers being turned off, apart from autocorrect', () => {
    expect(capitalizeSentencesEnabled()).toBe(true);
    setCapitalizeSentencesEnabled(false);
    expect(capitalizeSentencesEnabled()).toBe(false);
    expect(autocorrectEnabled()).toBe(true);
    setCapitalizeSentencesEnabled(true);
    expect(capitalizeSentencesEnabled()).toBe(true);
  });
});
