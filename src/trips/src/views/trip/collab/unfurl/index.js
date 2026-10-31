// Link previews under chat messages, read through the trip worker's `link.unfurl` op. Results are kept for the
// session; images load straight from the site with no referrer, like favicons elsewhere in Collab.
import './unfurl.css';
import { el, safeURL } from '../../../../ui/dom.js';

const MAX_CACHED = 300;
const MISS_MS = 10 * 60_000;
const PARALLEL = 2;
// Trailing punctuation that usually ends a sentence rather than the link.
const TRAILING = /[.,;:!?'")\]}>*_~]+$/;

const cache = new Map();
const unsupported = new Set();
let holdUntil = 0;

/** Test hook. */
export function resetLinkPreviews() { cache.clear(); unsupported.clear(); holdUntil = 0; }

/** The first http(s) link in a message's text (markdown links included), or null. */
export function firstLink(text) {
  for (const match of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let raw = match[0];
    while (TRAILING.test(raw)) {
      const cut = raw.replace(TRAILING, '');
      // Keep a closing parenthesis that belongs to the URL, as in Wikipedia links.
      if (raw.endsWith(')') && (cut.match(/\(/g) ?? []).length > (cut.match(/\)/g) ?? []).length) { raw = `${cut})`; break; }
      raw = cut;
    }
    const href = safeURL(raw);
    if (href) return href;
  }
  return null;
}

function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
}
const settled = (hit) => Boolean(hit && (hit.preview || Date.now() - hit.at < MISS_MS));
const hostOf = (href) => new URL(href).hostname.replace(/^www\./, '');

function card(href, preview, onLoad) {
  const image = preview.image && safeURL(preview.image)?.startsWith('https:') ? el('img.chat-preview-image', {
    src: preview.image, alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer',
    onload: () => onLoad?.(), onerror: (event) => event.currentTarget.remove(),
  }) : null;
  return el('a.chat-preview-card', { href, target: '_blank', rel: 'noopener noreferrer' },
    image,
    el('span.chat-preview-text', {},
      el('span.chat-preview-host', { dir: 'ltr' }, hostOf(href)),
      preview.title && el('bdi.chat-preview-title', {}, preview.title),
      preview.desc && el('span.chat-preview-desc', {}, preview.desc)));
}

/**
 * Previews for one open trip. `node(msg, {onLoad})` returns an element for the message's first link (empty until a
 * preview arrives) or null. Without `api`, or against a worker that lacks the op, nothing is fetched. Requests
 * start when the message scrolls near view, two at a time, and pause after a 429 or while offline.
 */
export function createLinkPreviews({ api, space, window: win = globalThis.window }) {
  const ref = space?.ref;
  const worker = ref?.w;
  const waiting = [];
  const flights = new Map();
  let active = 0;
  let timer = 0;
  let destroyed = false;
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); entry.target.dispatchEvent(new Event('preview-visible')); }
  }, { rootMargin: '300px' }) : null;
  const usable = () => Boolean(api?.call && ref && !unsupported.has(worker) && !destroyed);

  function pump() {
    clearTimeout(timer);
    while (active < PARALLEL && waiting.length && usable()) {
      if (win?.navigator?.onLine === false) return;
      const wait = holdUntil - Date.now();
      if (wait > 0) { timer = setTimeout(pump, wait); return; }
      const job = waiting.shift();
      active += 1;
      void job().finally(() => { active -= 1; pump(); });
    }
  }
  win?.addEventListener?.('online', pump);

  async function load(key, href) {
    try {
      const result = await api.call(ref, 'link.unfurl', { url: href });
      remember(key, { preview: result?.preview && typeof result.preview === 'object' ? result.preview : null, at: Date.now() });
    } catch (error) {
      if (error?.code === 'unknown_op' || error?.code === 'invalid_operation') unsupported.add(worker);
      else if (error?.status === 429) holdUntil = Date.now() + (error.retryAfter ?? 60) * 1000;
      else if (error?.status >= 400 && error.status < 500) remember(key, { preview: null, at: Date.now() });
      // Offline, network and server errors are retried the next time the message renders.
    }
  }
  const once = (key, href) => {
    if (!flights.has(key)) flights.set(key, load(key, href).finally(() => flights.delete(key)));
    return flights.get(key);
  };

  function fill(holder, key, href, onLoad) {
    const hit = cache.get(key);
    if (!hit?.preview) return;
    holder.replaceChildren(card(href, hit.preview, onLoad));
    onLoad?.();
  }

  return {
    node(msg, { onLoad } = {}) {
      if (!usable() || !msg || msg.deleted) return null;
      const href = firstLink(msg.text);
      if (!href) return null;
      const key = `${worker}/${ref.s}|${href}`;
      // Empty but laid out: an observer never reports a hidden (display: none) target as visible.
      const holder = el('div.chat-preview');
      if (settled(cache.get(key))) { fill(holder, key, href, null); return holder; }
      const start = () => {
        waiting.push(async () => {
          if (!settled(cache.get(key))) await once(key, href);
          if (holder.isConnected) fill(holder, key, href, onLoad);
        });
        pump();
      };
      if (observer) { holder.addEventListener('preview-visible', start, { once: true }); observer.observe(holder); } else start();
      return holder;
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      observer?.disconnect();
      waiting.length = 0;
      win?.removeEventListener?.('online', pump);
    },
  };
}
