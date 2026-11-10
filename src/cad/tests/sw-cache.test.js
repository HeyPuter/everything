import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** Run public/sw.js in a stand-in worker scope and hand back its fetch handler. */
function worker() {
  const listeners = {};
  const lookups = [];
  const self = { location: { origin: 'https://cad.example' }, addEventListener: (type, fn) => (listeners[type] = fn), skipWaiting() {}, clients: { claim() {} } };
  const caches = {
    match: async (req, opts) => (lookups.push({ url: req.url ?? req, opts }), new Response('cached')),
    open: async () => ({ put: async () => {}, keys: async () => [], delete: async () => {} }),
  };
  const fetch = async () => Promise.reject(new Error('offline'));
  new Function('self', 'caches', 'fetch', readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'))(self, caches, fetch);
  const request = async (path, init = {}) => {
    let answer;
    const req = new Request(`https://cad.example${path}`, init);
    listeners.fetch({ request: req, respondWith: (p) => (answer = p) });
    return answer && (await answer).text();
  };
  return { request, lookups, listeners };
}

describe('offline app shell', () => {
  it('finds the cached build files whatever Origin header the page sends', async () => {
    // The page asks for its script and style sheet with an Origin header (they are
    // crossorigin); on a host that answers "Vary: Origin" a plain lookup misses the
    // copies cached without one, and the app does not open offline.
    const sw = worker();
    expect(await sw.request('/assets/index-Gn0zDotr.js', { headers: { Origin: 'https://cad.example' } })).toBe('cached');
    expect(await sw.request('/manifest.json')).toBe('cached');
    expect(sw.lookups.map((l) => l.opts)).toEqual([{ ignoreVary: true }, { ignoreVary: true }]);
  });

  it('leaves other origins (the Puter SDK and API) alone', () => {
    const sw = worker();
    let answered = false;
    sw.listeners.fetch({ request: new Request('https://js.puter.com/v2/'), respondWith: () => (answered = true) });
    expect(answered).toBe(false);
    expect(sw.lookups).toEqual([]);
  });
});
