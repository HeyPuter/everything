/**
 * Turn a web address or email into a link as you type, the way editors do:
 * when a space or a new line ends a word that looks like a URL or an email,
 * the word is wrapped in a hyperlink. The typed text is left as it is; only
 * the link is added, in a step of its own so a single undo removes it.
 *
 * The match is deliberately conservative — a scheme (http/https), a `www.`
 * prefix, an email address, or a bare host on a well-known top-level domain
 * — so ordinary writing ("e.g.", "Fig. 2", "file.pdf") is not linked.
 */

import { paragraphText } from './autocorrect.js';
import { textAnchor } from './hyperlink-target.js';

const KEY = 'documents:autolink';
const storage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

/** Whether linking as you type is on (it is, until turned off). */
export function autolinkEnabled() {
  try { return storage()?.getItem(KEY) !== '0'; } catch { return true; }
}

export function setAutolinkEnabled(on) {
  try { on ? storage()?.removeItem(KEY) : storage()?.setItem(KEY, '0'); } catch { /* private mode */ }
}

// Hosts whose last label is one of these are linked without a scheme. Endings that in writing are
// almost always a file type ("install.sh", "libfoo.so") are left out: those link with a scheme or www.
export const COMMON_TLDS = new Set(
  ('com org net edu gov mil int io co dev app ai me info biz name pro us uk ca de fr jp cn au nl ru ch it es se no fi dk pl br in za ie nz kr mx be at cz gr pt ro tv fm gg xyz online site tech store blog news email cloud page link to gl')
    .split(' '));

const EMAIL = /^[^\s@]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/i;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24})(?::\d{1,5})?(?:[/?#]\S*)?$/i;
/** "example.com:8080/admin": a host with a port, not an address with a scheme called "example.com". */
const HOST_PORT = /^[^/?#:@\s]+:\d{1,5}(?:[/?#]|$)/;

/** The href to link a token to, or null when it does not look like one. Display text is never changed. */
export function hrefForToken(token) {
  const t = String(token || '').trim();
  if (!t || /\s/.test(t)) return null;
  // An address with a scheme is taken as written: "mailto:joe@x.com" is not
  // an email whose local part is "mailto:joe", and an @ in a web address's
  // query ("…/unsubscribe?u=joe@x.com") does not make it one either.
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  if (/^mailto:[^\s@]+@/i.test(t)) return EMAIL.test(t.slice(7)) ? t : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !HOST_PORT.test(t)) return null;
  if (EMAIL.test(t)) return `mailto:${t}`;
  // "www." introduces a host, so there has to be one after it: "www.foo" is not a site.
  if (/^www\.[a-z0-9-]+\./i.test(t) && HOST.test(t)) return `https://${t}`;
  if (/^www\./i.test(t)) return null;
  const m = HOST.exec(t);
  const hasPath = /[/?#]/.test(t);
  // A bare host is linked only with its ending in lowercase: "works.It" is a
  // missing space after a full stop, not a site in Italy.
  if (m && (hasPath || COMMON_TLDS.has(m[1]))) return `https://${t}`;
  return null;
}

const LEAD = new Set(['(', '[', '{', '"', "'", '“', '‘', '<', '«']);
const TRAIL = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '”', '’', '>', '»']);
const CLOSERS = { ')': '(', ']': '[', '}': '{' };
const OPENERS = { '(': ')', '[': ']', '{': '}' };

/**
 * Trailing sentence punctuation dropped from a token ("site.com." ->
 * "site.com"), balancing brackets: a closer that pairs with an opener inside
 * the token stays ("wiki/Foo_(bar)"), one that does not goes.
 */
export function trimTrailing(token) {
  const s = String(token || '');
  // Count pairs once. Merely finding an opening bracket retains surplus
  // closers, and repeatedly scanning the prefix is quadratic on long tokens.
  const balance = { ')': 0, ']': 0, '}': 0 };
  for (const c of s) {
    if (OPENERS[c]) balance[OPENERS[c]] += 1;
    else if (CLOSERS[c]) balance[c] -= 1;
  }
  let end = s.length;
  while (end) {
    const c = s[end - 1];
    if (TRAIL.has(c)) { end -= 1; continue; }
    if (CLOSERS[c] && balance[c] < 0) { balance[c] += 1; end -= 1; continue; }
    break;
  }
  return s.slice(0, end);
}

/**
 * The link to make for the word ending at `end` in `text`, or null:
 * `{ start, end, text, href }`. The word is the run of non-space characters
 * before `end` (the boundary — the space or line break just typed).
 */
export function linkCandidateBefore(text, end) {
  if (typeof text !== 'string' || !Number.isFinite(end) || end <= 0 || end > text.length) return null;
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  // An address written in brackets or quotes is linked without them.
  while (start < end && LEAD.has(text[start])) start++;
  if (start === end) return null;
  const trimmed = trimTrailing(text.slice(start, end));
  if (!trimmed) return null;
  const href = hrefForToken(trimmed);
  if (!href) return null;
  return { start, end: start + trimmed.length, text: trimmed, href };
}

/** Whether an existing hyperlink already covers any of [start, end) in the block; `text` puts the anchors into the text's coordinates. */
export function linkExistsInRange(links, blockId, start, end, text = null) {
  return (links || []).some((l) => {
    const a = textAnchor(l, text);
    return a && a.start?.blockId === blockId && a.start.offset < end && a.end?.offset > start;
  });
}

/**
 * Link the word ending at `boundary` in `blockId`, if it looks like a URL or
 * email and is not already linked. `wrap` is the hyperlinks.wrap call.
 * Resolves the candidate that was linked, or null.
 */
export async function linkifyBefore(api, wrap, blockId, boundary) {
  let node;
  try { node = await api.getNodeById({ nodeId: blockId }); } catch { return null; }
  const text = paragraphText(node);
  const cand = linkCandidateBefore(text, boundary);
  if (!cand) return null;
  let links = [];
  try { links = (await api.hyperlinks.list())?.items || []; } catch { links = []; }
  if (linkExistsInRange(links, blockId, cand.start, cand.end, text)) return null;
  const story = { kind: 'story', storyType: 'body' };
  const target = { kind: 'text', blockId, range: { start: cand.start, end: cand.end }, story };
  const r = await wrap({ target, link: { destination: { href: cand.href } } });
  if (r == null || r.success === false || r.ok === false) return null;
  return cand;
}
