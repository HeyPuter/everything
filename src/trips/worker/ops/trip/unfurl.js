// Chat link previews (`link.unfurl`): the owner's worker reads a public page's title, description and image URL.
// The owner pays, so it fetches only page heads, never images, and caches per URL across every space on this worker.
// URLs must pass the `PAGE` reach rules; redirects are followed by hand (at most 3) and every hop is checked again.
import { plainObject } from '../../../src/shared/schema/dsl.js';
import { PAGE, URL_CHARS, reachableUrl } from '../../../src/shared/reach.js';
import { createCache } from '../../cache.js';
import { check } from '../../http.js';
import { sha256Hex, spaceId } from '../../keys.js';
import { DAY, kvBudget, throttle } from '../../engine/limits.js';
import { loadMember } from '../../engine/space.js';

const HOP_MS = 5000;
const TOTAL_MS = 8000;
const MAX_REDIRECTS = 3;
export const HEAD_BYTES = 128 * 1024;
const CACHE_MS = 7 * DAY;
const MISS_MS = 3_600_000;
const PER_MINUTE = 60;
const FETCHES_PER_DAY = 200;
const TITLE_CHARS = 200;
const DESC_CHARS = 400;
const USER_AGENT = 'Trips link preview (+https://trips.puter.com)';

const memory = createCache({ max: 500 });

/** Test hook: forgets the isolate's preview cache. */
export function resetUnfurlCache() { memory.clear(); }

export { isBlockedIp } from '../../../src/shared/reach.js';

/** A URL the worker may fetch, as a `URL` without its fragment, or null. */
export function allowedUrl(raw) { return reachableUrl(raw, PAGE); }

/**
 * Fetches with the reach rules; resolves `{response, url}` for a 2xx answer or null. Each hop gets the shorter
 * of its own time and what is left of the whole budget.
 */
export async function guardedFetch(raw, { fetch: fetcher = globalThis.fetch, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', deadline = Date.now() + TOTAL_MS, now = Date.now } = {}) {
  let url = allowedUrl(raw);
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    const left = deadline - now();
    if (left <= 0) return null;
    let response;
    try {
      response = await fetcher(url.href, {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(Math.min(HOP_MS, left)),
        headers: { Accept: accept, 'User-Agent': USER_AGENT },
      });
    } catch { return null; }
    // A runtime that followed the redirect anyway reports where it ended up; that address must pass too.
    if (response.url && !allowedUrl(response.url)) { cancel(response); return null; }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      cancel(response);
      if (!location) return null;
      try { url = allowedUrl(new URL(location, url).href); } catch { return null; }
      continue;
    }
    if (!response.ok) { cancel(response); return null; }
    return { response, url: response.url || url.href };
  }
  return null;
}

function cancel(response) {
  try { void response.body?.cancel?.().catch?.(() => {}); } catch { /* already consumed */ }
}

function decoderFor(label) {
  try { return new TextDecoder(label || 'utf-8'); } catch { return null; }
}
const charsetOf = (value) => (/charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(String(value ?? '')) ?? [])[1] ?? '';
const HEAD_END = /<\/head\s*>/i;

/** Comments, scripts and styles removed in one linear pass; one left open runs to the end. */
export function stripHidden(html) {
  const lower = html.toLowerCase();
  const kinds = [['<!--', '-->'], ['<script', '</script'], ['<style', '</style']];
  const next = kinds.map(() => -2);
  let out = '';
  let i = 0;
  for (;;) {
    let k = -1;
    for (let j = 0; j < kinds.length; j++) {
      if (next[j] !== -1 && next[j] < i) next[j] = lower.indexOf(kinds[j][0], i);
      if (next[j] >= 0 && (k < 0 || next[j] < next[k])) k = j;
    }
    if (k < 0) return out + html.slice(i);
    const [opener, closer] = kinds[k];
    out += html.slice(i, next[k]);
    const end = lower.indexOf(closer, next[k] + opener.length);
    if (end < 0) return out;
    i = end + closer.length;
    if (closer !== '-->') { const gt = lower.indexOf('>', i); i = gt < 0 ? html.length : gt + 1; }
  }
}

/** Reads at most `max` bytes, stopping once the visible text holds `</head>`; returns the text and raw bytes. */
export async function readHead(response, { max = HEAD_BYTES } = {}) {
  const declared = charsetOf(response.headers.get('content-type'));
  const decoder = decoderFor(declared) ?? new TextDecoder();
  const reader = response.body?.getReader?.();
  const chunks = [];
  let total = 0;
  let text = '';
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer()).subarray(0, max);
    chunks.push(bytes); total = bytes.byteLength; text = decoder.decode(bytes);
  } else {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const room = max - total;
      const piece = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(piece); total += piece.byteLength;
      text += decoder.decode(piece, { stream: true });
      if (total >= max || HEAD_END.test(stripHidden(text))) { reader.cancel().catch(() => {}); break; }
    }
  }
  if (declared) return text;
  // No charset header: honour a <meta charset> outside comments and scripts.
  const meta = charsetOf((/<meta\s[^>]{0,400}charset[^>]{0,200}>/i.exec(stripHidden(text)) ?? [])[0]);
  const other = meta && decoderFor(meta);
  if (!other || other.encoding === 'utf-8') return text;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return other.decode(bytes);
}

const codePoint = (n) => {
  const cp = Number(n);
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
};
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', euro: '€' };
const decodeEntities = (value) => String(value ?? '')
  .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_, n) => codePoint(parseInt(n, 16)))
  .replace(/&#(\d{1,7});/g, (_, n) => codePoint(n))
  .replace(/&([a-zA-Z]{2,8});/g, (match, name) => (Object.hasOwn(NAMED, name) ? NAMED[name] : match));

/** Plain one-line text: controls and bidi overrides removed, whitespace folded, cut at whole characters. */
export function cleanText(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : text;
}

/** Title, description and an https image URL from a document head; null when it names neither title nor description. */
export function parseHead(html, base) {
  const shown = stripHidden(String(html ?? ''));
  const end = shown.search(HEAD_END);
  const head = shown.slice(0, end > -1 ? end : shown.length);
  const metas = {};
  const attr = (tag, name) => {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
    return m ? m[1] ?? m[2] ?? m[3] : undefined;
  };
  for (const m of head.matchAll(/<meta\s[^>]{0,4000}>/gi)) {
    const key = attr(m[0], '(?:property|name)')?.toLowerCase();
    const content = attr(m[0], 'content');
    if (key && content !== undefined && !Object.hasOwn(metas, key)) metas[key] = decodeEntities(content);
  }
  const titleTag = (/<title[^>]{0,200}>([\s\S]{0,4000}?)<\/title>/i.exec(head) ?? [])[1];
  const title = cleanText(metas['og:title'] || metas['twitter:title'] || decodeEntities(titleTag ?? ''), TITLE_CHARS);
  const desc = cleanText(metas['og:description'] || metas['twitter:description'] || metas.description || '', DESC_CHARS);
  if (!title && !desc) return null;
  let image = null;
  const raw = metas['og:image:secure_url'] || metas['og:image'] || metas['og:image:url'] || metas['twitter:image'] || metas['twitter:image:src'];
  if (raw) {
    try {
      const url = allowedUrl(new URL(raw.trim(), base).href);
      if (url?.protocol === 'https:') image = url.href;
    } catch { /* no image */ }
  }
  return { title, desc, image };
}

/** Fetches one page and reads its preview; null for anything that is not a readable HTML page. */
export async function fetchPreview(raw, options = {}) {
  const now = options.now ?? Date.now;
  const fetched = await guardedFetch(raw, { ...options, deadline: now() + TOTAL_MS });
  if (!fetched) return null;
  const type = String(fetched.response.headers.get('content-type') ?? '').toLowerCase();
  if (!/^\s*(text\/html|application\/xhtml\+xml)/.test(type)) { cancel(fetched.response); return null; }
  return parseHead(await readHead(fetched.response), fetched.url);
}

const fresh = (record, time) => plainObject(record) && Number.isSafeInteger(record.at) && time - record.at < (record.none ? MISS_MS : CACHE_MS);
function shape(record) {
  if (!plainObject(record) || record.none) return null;
  const title = cleanText(record.title, TITLE_CHARS);
  const desc = cleanText(record.desc, DESC_CHARS);
  const image = typeof record.image === 'string' && allowedUrl(record.image)?.protocol === 'https:' ? record.image : null;
  return title || desc ? { title, desc, image } : null;
}

/** `link.unfurl {space, url}` → `{preview: {title, desc, image} | null}`. Members of the space only. */
export async function linkUnfurl(w, ident, input, { fetch: fetcher = globalThis.fetch } = {}) {
  const sid = spaceId(input.space);
  check(typeof input.url === 'string' && input.url.length > 0 && input.url.length <= URL_CHARS, 'invalid_url');
  await loadMember(w, ident, sid);
  throttle(w, `unfurl:${ident.uuid}`, PER_MINUTE, 60_000);
  const url = allowedUrl(input.url);
  if (!url) return { preview: null };
  const key = `unfurl:${await sha256Hex(url.href)}`;
  const time = w.now();
  const cached = memory.get(key);
  if (fresh(cached, time)) return { preview: shape(cached) };
  const stored = await w.kv.get(key);
  if (fresh(stored, time)) { memory.set(key, stored); return { preview: shape(stored) }; }
  await kvBudget(w, sid, 'unf', ident.uuid, { windowMs: DAY, limit: FETCHES_PER_DAY });
  let preview = null;
  try { preview = await fetchPreview(url.href, { fetch: fetcher, now: w.now }); } catch { preview = null; }
  const record = preview ? { ...preview, at: time } : { none: true, at: time };
  memory.set(key, record);
  w.waitUntil(w.kv.set(key, record, { expireAt: time + (preview ? CACHE_MS : MISS_MS) }).catch(() => {}));
  return { preview };
}
