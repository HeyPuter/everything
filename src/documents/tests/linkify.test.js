import { describe, it, expect, beforeEach } from 'vitest';
import { hrefForToken, trimTrailing, linkCandidateBefore, linkExistsInRange, linkifyBefore, autolinkEnabled, setAutolinkEnabled } from '../src/lib/linkify.js';

describe('hrefForToken', () => {
  it('links schemes, www, emails, and hosts on known TLDs', () => {
    expect(hrefForToken('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(hrefForToken('http://localhost')).toBe('http://localhost');
    expect(hrefForToken('www.example.com')).toBe('https://www.example.com');
    expect(hrefForToken('www.foo')).toBeNull();
    expect(hrefForToken('www.localhost')).toBeNull();
    expect(hrefForToken('example.com')).toBe('https://example.com');
    expect(hrefForToken('docs.example.co.uk/path')).toBe('https://docs.example.co.uk/path');
    expect(hrefForToken('name@example.com')).toBe('mailto:name@example.com');
    // A written scheme is kept as it is, never wrapped in a second mailto:.
    expect(hrefForToken('mailto:name@example.com')).toBe('mailto:name@example.com');
    expect(hrefForToken('https://x.com/unsubscribe?u=joe@mail.com')).toBe('https://x.com/unsubscribe?u=joe@mail.com');
    expect(hrefForToken('mailto:not-an-address')).toBeNull();
    // A path makes an unusual TLD linkable.
    expect(hrefForToken('service.internal/status')).toBe('https://service.internal/status');
  });

  it('leaves ordinary writing and unsafe schemes alone', () => {
    expect(hrefForToken('e.g.')).toBeNull();
    expect(hrefForToken('i.e')).toBeNull();
    expect(hrefForToken('Fig.2')).toBeNull();
    expect(hrefForToken('report.pdf')).toBeNull();
    expect(hrefForToken('photo.jpg')).toBeNull();
    // File names, as in setup instructions: "run install.sh".
    for (const token of ['install.sh', 'libcrypto.so', 'notes.md', 'main.py']) expect(hrefForToken(token)).toBeNull();
    expect(hrefForToken('https://get.example.sh')).toBe('https://get.example.sh');
    expect(hrefForToken('www.example.sh')).toBe('https://www.example.sh');
    expect(hrefForToken('plain')).toBeNull();
    expect(hrefForToken('javascript:alert(1)')).toBeNull();
    expect(hrefForToken('data:text/html,x')).toBeNull();
    expect(hrefForToken('two words')).toBeNull();
    expect(hrefForToken('')).toBeNull();
  });

  it('does not take a missing space after a full stop for a site', () => {
    for (const token of ['works.It', 'done.In', 'here.To', 'yes.No', 'e.g.It']) expect(hrefForToken(token)).toBeNull();
    // A capitalized name on a lowercase ending is still a site; so is any host with a path.
    expect(hrefForToken('Example.com')).toBe('https://Example.com');
    expect(hrefForToken('works.It/page')).toBe('https://works.It/page');
  });
});

describe('trimTrailing and linkCandidateBefore', () => {
  it.each([
    ['https://example.com/Dog_(animal)).', 'https://example.com/Dog_(animal)'],
    ['https://example.com/(a(b)))', 'https://example.com/(a(b))'],
    ['https://example.com/?filter=[a]]', 'https://example.com/?filter=[a]'],
    ['https://example.com/{a}}!?', 'https://example.com/{a}'],
  ])('drops unmatched closing brackets from %s', (input, expected) => {
    expect(trimTrailing(input)).toBe(expected);
    const text = `Read ${input}`;
    expect(linkCandidateBefore(text, text.length)).toEqual({ start: 5, end: 5 + expected.length, text: expected, href: expected });
  });

  it('drops sentence punctuation but keeps balanced brackets', () => {
    expect(trimTrailing('site.com.')).toBe('site.com');
    expect(trimTrailing('site.com),')).toBe('site.com');
    expect(trimTrailing('en.wikipedia.org/wiki/Dog_(animal)')).toBe('en.wikipedia.org/wiki/Dog_(animal)');
    expect(trimTrailing('site.com!?')).toBe('site.com');
    expect(trimTrailing('"quote"')).toBe('"quote'); // opening quote is part of the word
  });

  it('finds the linkable word ending at the boundary', () => {
    const text = 'see https://example.com. now';
    // Boundary just after the URL and its trailing period (the space at 24 -> end 23 covers the period).
    expect(linkCandidateBefore('go example.com', 14)).toEqual({ start: 3, end: 14, text: 'example.com', href: 'https://example.com' });
    const t2 = 'read example.com.';
    expect(linkCandidateBefore(t2, t2.length)).toEqual({ start: 5, end: 16, text: 'example.com', href: 'https://example.com' });
    expect(linkCandidateBefore('just some words', 15)).toBeNull();
    expect(linkCandidateBefore('example.com', 0)).toBeNull();
    expect(linkCandidateBefore('example.com', 99)).toBeNull();
    expect(linkCandidateBefore('a example.com', 2)).toBeNull(); // boundary right after "a"
    expect(text).toContain('example');
  });
});

describe('bracketed and quoted addresses', () => {
  it('links the address inside brackets or quotes, leaving them out of the link', () => {
    const text = 'see (https://example.com) now';
    expect(linkCandidateBefore(text, 25)).toEqual({ start: 5, end: 24, text: 'https://example.com', href: 'https://example.com' });
    expect(linkCandidateBefore('"example.com" ', 13)).toMatchObject({ start: 1, end: 12, text: 'example.com' });
    expect(linkCandidateBefore('<https://example.com> ', 21)).toMatchObject({ start: 1, end: 20, text: 'https://example.com' });
    expect(linkCandidateBefore('[name@example.com] ', 18)).toMatchObject({ start: 1, end: 17, href: 'mailto:name@example.com' });
    // Brackets that belong to the address stay with it.
    const wiki = '(https://en.wikipedia.org/wiki/Foo_(bar)) ';
    expect(linkCandidateBefore(wiki, wiki.length - 1)).toMatchObject({ start: 1, text: 'https://en.wikipedia.org/wiki/Foo_(bar)' });
    expect(linkCandidateBefore('(( ', 2)).toBeNull();
  });
});

describe('linkExistsInRange', () => {
  const links = [{ address: { anchor: { start: { blockId: 'p1', offset: 4 }, end: { blockId: 'p1', offset: 20 } } } }];
  it('detects an overlapping link in the same block', () => {
    expect(linkExistsInRange(links, 'p1', 4, 20)).toBe(true);
    expect(linkExistsInRange(links, 'p1', 10, 12)).toBe(true);
    expect(linkExistsInRange(links, 'p1', 20, 30)).toBe(false);
    expect(linkExistsInRange(links, 'p2', 4, 20)).toBe(false);
    expect(linkExistsInRange([], 'p1', 4, 20)).toBe(false);
  });
});

describe('linkifyBefore', () => {
  const node = (text) => ({ node: { paragraph: { inlines: [{ run: { text } }] } } });
  const api = (text, links = []) => ({ getNodeById: async () => node(text), hyperlinks: { list: async () => ({ items: links }) } });

  it('wraps the URL before the boundary with a hyperlink', async () => {
    const calls = [];
    const wrap = async (input) => { calls.push(input); return { success: true }; };
    const t = 'read example.com';
    const cand = await linkifyBefore(api(t), wrap, 'p1', t.length);
    expect(cand).toMatchObject({ href: 'https://example.com', start: 5, end: 16 });
    expect(calls[0].target).toEqual({ kind: 'text', blockId: 'p1', range: { start: 5, end: 16 }, story: { kind: 'story', storyType: 'body' } });
    expect(calls[0].link).toEqual({ destination: { href: 'https://example.com' } });
  });

  it('does nothing without a URL, on an existing link, or when wrap fails', async () => {
    const wrap = async () => ({ success: true });
    expect(await linkifyBefore(api('just words here'), wrap, 'p1', 15)).toBeNull();
    const linked = [{ address: { anchor: { start: { blockId: 'p1', offset: 5 }, end: { blockId: 'p1', offset: 16 } } } }];
    expect(await linkifyBefore(api('read example.com', linked), wrap, 'p1', 16)).toBeNull();
    expect(await linkifyBefore(api('read example.com'), async () => ({ success: false }), 'p1', 16)).toBeNull();
    expect(await linkifyBefore({ getNodeById: async () => { throw new Error('gone'); } }, wrap, 'p1', 16)).toBeNull();
  });
});

describe('autolink preference', () => {
  beforeEach(() => { globalThis.localStorage = new Map(); Object.assign(globalThis.localStorage, { getItem(k) { return this.has(k) ? this.get(k) : null; }, setItem(k, v) { this.set(k, v); }, removeItem(k) { this.delete(k); } }); });

  it('is on by default and remembers being turned off', () => {
    expect(autolinkEnabled()).toBe(true);
    setAutolinkEnabled(false);
    expect(autolinkEnabled()).toBe(false);
    setAutolinkEnabled(true);
    expect(autolinkEnabled()).toBe(true);
  });
});

it('links a host with a port, which is not an address with a scheme', () => {
  expect(hrefForToken('example.com:8080/admin')).toBe('https://example.com:8080/admin');
  expect(hrefForToken('www.example.com:3000')).toBe('https://www.example.com:3000');
  expect(hrefForToken('example.com:8080')).toBe('https://example.com:8080');
  expect(hrefForToken('mailto:joe@example.com')).toBe('mailto:joe@example.com');
  expect(hrefForToken('ftp:example.com')).toBeNull();
  expect(hrefForToken('note:8080')).toBeNull();
});

describe('link anchors and note references', () => {
  it('puts a link anchor that does not count a note reference into the text\'s coordinates', async () => {
    const { anchorToText, textAnchor } = await import('../src/lib/hyperlink-target.js');
    // "See" + a note reference + " visit example.com ": the engine's anchor for the address is one short.
    const text = 'See\uFFFC visit example.com ';
    expect(anchorToText(text, 2)).toBe(2);
    expect(anchorToText(text, 3)).toBe(3);
    expect(anchorToText(text, 4)).toBe(5);
    expect(anchorToText(text, 10)).toBe(11);
    const link = { address: { anchor: { start: { blockId: 'p1', offset: 10 }, end: { blockId: 'p1', offset: 21 } } } };
    expect(textAnchor(link, text).start.offset).toBe(11);
    expect(textAnchor(link, text).end.offset).toBe(22);
    expect(text.slice(11, 22)).toBe('example.com');
    // The address in the text is already linked; the check sees that once the anchor is shifted.
    expect(linkExistsInRange([link], 'p1', 11, 22, text)).toBe(true);
    expect(linkExistsInRange([link], 'p1', 22, 23, text)).toBe(false);
  });
});
