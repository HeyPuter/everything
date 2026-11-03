// Images of a public journey link, loaded lazily through a small queue that waits out 429s (the worker allows
// 60 requests a minute per link). Thumbnails first; object URLs are revoked on `destroy`.
import { fetchPublicFile } from '../../../lib/api.js';

const CONCURRENT = 3;

export function createImageLoader({ puter, link, signal }) {
  const cache = new Map();
  const urls = new Set();
  const queue = [];
  let active = 0;
  let pausedUntil = 0;
  let timer = 0;

  function pump() {
    clearTimeout(timer);
    if (signal?.aborted) return;
    const wait = pausedUntil - Date.now();
    if (wait > 0) { timer = setTimeout(pump, wait); return; }
    while (active < CONCURRENT && queue.length) {
      const job = queue.shift();
      active += 1;
      fetchPublicFile(puter, link, job.fileId, { signal, thumb: job.thumb }).then((blob) => {
        const url = URL.createObjectURL(blob);
        urls.add(url);
        job.resolve(url);
      }).catch((error) => {
        if (error?.status === 429 && !signal?.aborted) {
          pausedUntil = Date.now() + (Number(error.retryAfter) > 0 ? error.retryAfter * 1000 : 30_000);
          queue.unshift(job);
        } else job.reject(error);
      }).finally(() => { active -= 1; pump(); });
    }
  }
  function load(fileId, thumb) {
    const key = `${thumb ? 't' : 'f'}:${fileId}`;
    if (!cache.has(key)) {
      const promise = new Promise((resolve, reject) => { queue.push({ fileId, thumb, resolve, reject }); pump(); });
      promise.catch(() => cache.delete(key));
      cache.set(key, promise);
    }
    return cache.get(key);
  }
  return {
    /** The thumbnail when the file has one, else the full image. */
    preview: (file) => (file.thumb ? load(file.id, true).catch(() => load(file.id, false)) : load(file.id, false)),
    full: (file) => load(file.id, false),
    destroy() { clearTimeout(timer); queue.length = 0; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); cache.clear(); },
  };
}

/** An `<img>` filled lazily (when near the viewport) from `load()`; hidden until loaded. */
export function lazyImage(load, { alt = '', className = '' } = {}) {
  const image = document.createElement('img');
  image.alt = alt;
  image.decoding = 'async';
  image.hidden = true;
  if (className) image.className = className;
  const start = () => void load().then((src) => { image.src = src; image.hidden = false; }).catch(() => {});
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver((items) => { if (items.some((item) => item.isIntersecting)) { observer.disconnect(); start(); } }, { rootMargin: '300px' });
    queueMicrotask(() => observer.observe(image.parentElement ?? image));
  } else start();
  return image;
}
