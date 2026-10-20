/**
 * Finding the links in a plain text body.
 *
 * This returns *segments*, not an HTML string: the UI builds a text node or an
 * anchor per segment, so no mail-derived string is ever assigned to innerHTML.
 * The whole safety model of this app is that mail content is data, never
 * markup, and a linkifier that returned markup would be the one place that
 * stopped being true.
 *
 * Only http, https and mailto survive. A `javascript:` or `data:` URL turned
 * into a link would be a real vulnerability, and no pattern here can produce
 * one: the scanner matches those three shapes and nothing else.
 */

// A URL runs until whitespace or a delimiter that cannot appear in one.
// Brackets are allowed *inside* -- Wikipedia's Foo_(bar) is a real URL -- and
// trimmed afterwards only when they turn out to be unbalanced.
const URL_SOURCE = '(?:https?:\\/\\/|www\\.)[^\\s<>"\'`]+';
const MAILTO_SOURCE = 'mailto:[^\\s<>"\'`]+';
/**
 * An address, with the lengths the specs give it: 64 characters for the local
 * part (RFC 5321) and 63 for a DNS label.
 *
 * Those bounds are not pedantry -- they are what keeps the scan linear. This
 * pattern is applied at *every* position of a body, and an unbounded local
 * part means each of those positions reads to the end of the run it is in
 * looking for an `@` that may not be there: on one unbroken run of 100,000
 * characters -- a base64 blob, a minified log line, a message written to do
 * exactly this -- that is five billion steps and twenty seconds of frozen
 * tab, from opening a message. Bounded, the same run is read once.
 */
const LOCAL_PART = '[a-z0-9!#$%&\'*+/=?^_`{|}~.-]{1,64}';
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ADDRESS = `${LOCAL_PART}@${LABEL}(?:\\.${LABEL})+`;

// Order matters: mailto: before the bare address, so `mailto:a@b.co` is one
// link rather than a stray scheme followed by an address.
const SCANNER = new RegExp(`${MAILTO_SOURCE}|${URL_SOURCE}|${ADDRESS}`, 'gi');
const ADDRESS_ONLY = new RegExp(`^${ADDRESS}$`, 'i');

const CLOSERS = { ')': '(', ']': '[', '}': '{', '>': '<' };

/**
 * "See https://example.com/page." ends a sentence; the full stop is not part
 * of the URL. Neither is the closing bracket of "(see https://example.com)" --
 * but the one in ".../Foo_(bar)" is.
 *
 * One walk back from the end, with the bracket counts kept as it goes: a regex
 * and two counts for every character trimmed made a URL followed by a long run
 * of ")" quadratic, and sixteen thousand of them froze the reader for seconds.
 */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '\u201d', '\u2019']);

const trimTrailing = (match) => {
  const tally = {};
  for (const char of match) if ('()[]{}<>'.includes(char)) tally[char] = (tally[char] || 0) + 1;
  let end = match.length;
  while (end > 0) {
    const last = match[end - 1];
    if (TRAILING.has(last)) {
      end -= 1;
    } else if (last in CLOSERS && (tally[last] || 0) > (tally[CLOSERS[last]] || 0)) {
      tally[last] -= 1;
      end -= 1;
    } else {
      break;
    }
  }
  return match.slice(0, end);
};

// Whether the host as written differs from `url.host`, the one the browser
// connects to.
const disguised = (raw, url) => {
  const written = (/^\s*(?:https?:\/\/)?([^/?#]+)/i.exec(raw)?.[1] ?? '').toLowerCase();
  const host = url.host.toLowerCase();
  // `url.host` drops a port the scheme would have used anyway, so
  // `https://example.com:443/` came out as a disagreement with itself and
  // was reported to the reader as a link going somewhere else. Spelling out
  // the default port is not a lie about where a link goes.
  const spelledOut = `${host}:${url.protocol === 'https:' ? '443' : '80'}`;
  return written !== host && written !== spelledOut;
};

/**
 * Whether an http(s) href names its host in a form other than the one the
 * browser connects to: a homograph, or userinfo in front of the real host.
 */
export const disguisedHost = (href = '') => {
  const raw = String(href ?? '').trim();
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && disguised(raw, url);
  } catch {
    return false;
  }
};

const asLink = (raw) => {
  if (/^mailto:/i.test(raw)) {
    const address = raw.slice('mailto:'.length).split('?')[0];
    return ADDRESS_ONLY.test(address) ? { email: address, label: raw } : null;
  }
  if (ADDRESS_ONLY.test(raw)) return { email: raw, label: raw };

  const href = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // `url.host` is what the browser would connect to: a unicode homograph
    // host comes back as its punycode form. Where that differs from the host
    // as written -- a homograph, or userinfo smuggled in front of the real
    // host -- the caller is told, so it can show where the link really goes
    // rather than repeating the misleading text.
    return {
      url: url.href,
      host: url.host,
      label: raw,
      mismatch: disguised(raw, url),
    };
  } catch {
    return null;
  }
};

/**
 * linkify(text) -> segments, in order, covering the whole input:
 *   { text }                     a plain run
 *   { url, host, label }         an http(s) link
 *   { email, label }             an address, or a mailto: URL
 */
export const linkify = (text) => {
  const source = text == null ? '' : String(text);
  const segments = [];
  let at = 0;

  for (const match of source.matchAll(SCANNER)) {
    const raw = trimTrailing(match[0]);
    if (!raw) continue;
    const link = asLink(raw);
    if (!link) continue;
    if (match.index > at) segments.push({ text: source.slice(at, match.index) });
    segments.push(link);
    // Anything trimmed off the match is text again, not part of the link.
    at = match.index + raw.length;
  }

  if (at < source.length) segments.push({ text: source.slice(at) });
  return segments;
};

/**
 * Whether a link's visible text is claiming to be somewhere other than where
 * it goes -- the shape of every phishing link there has ever been. Only text
 * that looks like a hostname is judged: "Read more" claims nothing.
 */
export const claimedHost = (label = '') => {
  const match = /^\s*(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/?#:]|\s|$)/i.exec(String(label));
  return match ? match[1].toLowerCase().replace(/^www\./, '') : '';
};

export const linkHost = (href = '') => {
  try {
    return new URL(String(href)).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** True when the text of a link disagrees with where it actually goes. */
// Characters that take up no space. One at the end of "paypal.com" made the
// text claim nothing, so a link to anywhere else went unremarked.
const INVISIBLE = /[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export const misleadingLink = (label, href) => {
  const claimed = claimedHost(String(label ?? '').replace(INVISIBLE, ''));
  // Link text claims a hostname; a port does not change that hostname.
  const real = linkHost(href).replace(/:\d+$/, '');
  return Boolean(claimed && real && claimed !== real);
};
