import { describe, it, expect } from 'vitest';
import { linkify, claimedHost, linkHost, misleadingLink } from '../src/lib/linkify.js';

// Segments are asserted as a compact shape: text runs as strings, links as
// their href, so the tests read as "what did the body turn into".
const shape = (text) => linkify(text).map((segment) => {
  if (segment.text !== undefined) return segment.text;
  if (segment.email) return `mailto:${segment.email}`;
  return segment.url;
});

const links = (text) => linkify(text).filter((segment) => segment.text === undefined);

describe('linkify: plain URLs', () => {
  it('finds an http and an https URL', () => {
    expect(shape('go to https://example.com/a now')).toEqual(['go to ', 'https://example.com/a', ' now']);
    expect(shape('http://example.com')).toEqual(['http://example.com/']);
  });

  it('covers the whole input, with nothing lost or duplicated', () => {
    const text = 'a https://x.co b https://y.co c';
    expect(linkify(text).map((s) => s.text ?? s.label).join('')).toBe(text);
  });

  it('turns a bare www host into an https link, keeping the text as written', () => {
    const [link] = links('visit www.example.co.uk/path?q=1 today');
    expect(link.url).toBe('https://www.example.co.uk/path?q=1');
    expect(link.label).toBe('www.example.co.uk/path?q=1');
  });

  it('leaves trailing sentence punctuation out of the URL', () => {
    expect(shape('See https://example.com/page.')).toEqual(['See ', 'https://example.com/page', '.']);
    expect(shape('https://example.com/a, https://example.com/b!'))
      .toEqual(['https://example.com/a', ', ', 'https://example.com/b', '!']);
    expect(shape('ends with a colon https://x.co:')).toEqual(['ends with a colon ', 'https://x.co/', ':']);
  });

  it('leaves an enclosing bracket out but keeps a balanced one inside', () => {
    expect(shape('(see https://example.com)')).toEqual(['(see ', 'https://example.com/', ')']);
    expect(shape('[https://example.com/a]')).toEqual(['[', 'https://example.com/a', ']']);
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar) next')[0].url)
      .toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('does not run one link into the next', () => {
    expect(links('https://a.co https://b.co').map((l) => l.url))
      .toEqual(['https://a.co/', 'https://b.co/']);
  });

  it('finds a URL inside angle brackets, which is how flattened HTML keeps it', () => {
    expect(shape('Verify your email <https://shop.example/v?token=abc>'))
      .toEqual(['Verify your email <', 'https://shop.example/v?token=abc', '>']);
  });
});

describe('linkify: hostile input', () => {
  const elapsed = (fn) => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };

  it('stays linear on a URL followed by a long run of closers or punctuation', () => {
    // Each took seconds when every trimmed character re-ran a regex and two counts.
    expect(elapsed(() => linkify(`https://x.co/${')'.repeat(16000)}`))).toBeLessThan(1000);
    expect(elapsed(() => linkify(`https://x.co/${'.'.repeat(16000)}a`))).toBeLessThan(1000);
    expect(links(`(see https://x.co/a)).`)[0].url).toBe('https://x.co/a');
  });
});

describe('linkify: addresses', () => {
  it('turns an address into a mail link', () => {
    expect(shape('write to ana@meridianlabs.example please'))
      .toEqual(['write to ', 'mailto:ana@meridianlabs.example', ' please']);
  });

  it('reads a mailto: URL as one link, not a scheme and an address', () => {
    expect(links('mailto:leo@puter.com')).toEqual([
      { email: 'leo@puter.com', label: 'mailto:leo@puter.com' },
    ]);
  });

  it('drops the query off a mailto: while keeping the text', () => {
    const [link] = links('mailto:leo@puter.com?subject=Hi');
    expect(link.email).toBe('leo@puter.com');
    expect(link.label).toBe('mailto:leo@puter.com?subject=Hi');
  });

  it('does not mistake a URL that contains an address for an address', () => {
    expect(links('https://x.co/?to=a@b.co').map((l) => l.url)).toEqual(['https://x.co/?to=a@b.co']);
  });

  it('leaves punctuation after an address alone', () => {
    expect(shape('ask ana@x.co.')).toEqual(['ask ', 'mailto:ana@x.co', '.']);
  });

  it('holds an address to the lengths the specs give it', () => {
    // RFC 5321: 64 characters of local part, 63 of DNS label. Nothing longer
    // is an address any server would take.
    expect(links(`${'a'.repeat(64)}@x.co`)).toHaveLength(1);
    expect(links(`${'a'.repeat(64)}@${'b'.repeat(63)}.co`)).toHaveLength(1);
    expect(links(`a@${'b'.repeat(64)}.co`)).toEqual([]);
  });

  /**
   * The scanner runs at every position of a message body, so an unbounded
   * local part made each of those positions read to the end of whatever run
   * it was in, looking for an `@`. One unbroken run of 100,000 characters --
   * a base64 blob, a minified log line, a message written to do exactly this
   * -- froze the tab for twenty seconds on opening the message.
   */
  it('scans a long run of address characters in one pass', () => {
    const began = Date.now();
    expect(links('a'.repeat(100_000))).toEqual([]);
    expect(links(`${'x'.repeat(50_000)}@${'a-'.repeat(20_000)}!`)).toEqual([]);
    expect(Date.now() - began).toBeLessThan(2000);
  });
});

describe('linkify: what must never become a link', () => {
  it('never links javascript: or data:', () => {
    expect(links('javascript:alert(1)')).toEqual([]);
    expect(links('data:text/html,<script>alert(1)</script>')).toEqual([]);
    expect(links('JAVASCRIPT:alert(1)')).toEqual([]);
    expect(links('vbscript:msgbox(1)')).toEqual([]);
    expect(links('file:///etc/passwd')).toEqual([]);
  });

  it('does not turn a scheme hidden after text into a link', () => {
    expect(links('click here javascript:alert(document.cookie)')).toEqual([]);
  });

  it('produces only http, https and mailto links, whatever the input', () => {
    const text = 'https://a.co javascript:x data:y mailto:b@c.co www.d.co ftp://e.co e@f.co';
    for (const link of links(text)) {
      const href = link.url ?? `mailto:${link.email}`;
      expect(href).toMatch(/^(https?:|mailto:)/);
    }
  });

  it('is empty for text with no links at all', () => {
    expect(links('nothing to see here')).toEqual([]);
    expect(linkify('')).toEqual([]);
    expect(linkify(null)).toEqual([]);
    expect(linkify(undefined)).toEqual([]);
  });
});

describe('linkify: where a link really goes', () => {
  it('links a homograph host to the host the browser would connect to', () => {
    const [link] = links('sign in at https://раypal.com/login');
    expect(link.url).toBe('https://xn--ypal-43d9g.com/login');
    expect(link.host).toBe('xn--ypal-43d9g.com');
    // The text stays as written, and the mismatch is reported so the UI can
    // show where it actually goes.
    expect(link.label).toBe('https://раypal.com/login');
    expect(link.mismatch).toBe(true);
  });

  it('reports userinfo smuggled in front of the real host', () => {
    const [link] = links('https://paypal.com@evil.example/login');
    expect(link.host).toBe('evil.example');
    expect(link.mismatch).toBe(true);
  });

  it('reports no mismatch for an ordinary URL', () => {
    expect(links('https://example.com/a')[0].mismatch).toBe(false);
    expect(links('www.example.com')[0].mismatch).toBe(false);
    expect(links('https://EXAMPLE.com/a')[0].mismatch).toBe(false);
  });

  it('does not call a spelled-out default port a disagreement', () => {
    expect(links('https://example.com:443/a')[0].mismatch).toBe(false);
    expect(links('http://example.com:80/a')[0].mismatch).toBe(false);
    // A port that is not the scheme's default stays part of the host either
    // way, so it agrees with itself too -- including port 80 over https,
    // which is where the browser really would connect.
    expect(links('https://example.com:8443/a')[0].mismatch).toBe(false);
    expect(links('https://example.com:80/a')[0].mismatch).toBe(false);
    // A different host is still a real difference.
    expect(links('https://example.com:443@evil.example/a')[0].mismatch).toBe(true);
  });
});

describe('misleadingLink', () => {
  it('is true when the text names a different host than the href', () => {
    expect(misleadingLink('paypal.com', 'https://evil.example/x')).toBe(true);
    expect(misleadingLink('https://paypal.com/login', 'https://evil.example')).toBe(true);
  });

  it('is false when the text claims no host at all', () => {
    expect(misleadingLink('Read more', 'https://evil.example')).toBe(false);
    expect(misleadingLink('', 'https://evil.example')).toBe(false);
  });

  it('is false when they agree, www and trailing slash aside', () => {
    expect(misleadingLink('example.com', 'https://www.example.com/')).toBe(false);
    expect(misleadingLink('www.example.com/a', 'https://example.com/a')).toBe(false);
  });

  it('does not mistake a nonstandard port for a different hostname', () => {
    expect(misleadingLink('https://example.com:8443/report', 'https://example.com:8443/report')).toBe(false);
    expect(misleadingLink('example.com', 'https://www.example.com:8080/report')).toBe(false);
    expect(misleadingLink('example.com', 'https://evil.example:8443/report')).toBe(true);
    // Keep the port available when showing the actual destination.
    expect(linkHost('https://evil.example:8443/report')).toBe('evil.example:8443');
  });

  it('is false for an href that is not a URL', () => {
    expect(misleadingLink('example.com', 'not a url')).toBe(false);
  });
});

describe('claimedHost and linkHost', () => {
  it('reads the host out of link text that looks like one', () => {
    expect(claimedHost('example.com/path')).toBe('example.com');
    expect(claimedHost('https://www.example.com')).toBe('example.com');
    expect(claimedHost('Click here')).toBe('');
    expect(claimedHost('')).toBe('');
  });

  it('reads the host a URL would connect to', () => {
    expect(linkHost('https://www.Example.com/a')).toBe('example.com');
    expect(linkHost('https://раypal.com')).toBe('xn--ypal-43d9g.com');
    expect(linkHost('nonsense')).toBe('');
  });
});
