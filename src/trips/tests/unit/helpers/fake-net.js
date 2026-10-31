// A recorded `puter.net.fetch`: routes are `'METHOD /path'` → handler(url, init) returning a Response or
// `{status, json, body, headers}`. Every call is kept in `calls` for assertions. No network is used.
import { readFileSync } from 'node:fs';

export const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/integrations/${name}`, import.meta.url), 'utf8'));

export function fakeNet(routes = {}) {
  const calls = [];
  async function fetch(target, init = {}) {
    const url = new URL(target);
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method, headers: { ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const out = await handler(url, init, calls.length);
    if (out instanceof Response) return out;
    const headers = { 'content-type': 'application/json', ...(out.headers ?? {}) };
    return new Response(out.body ?? (out.json === undefined ? null : JSON.stringify(out.json)), { status: out.status ?? 200, headers });
  }
  return { calls, fetch, puter: { authToken: 'token-a', net: { fetch } } };
}
