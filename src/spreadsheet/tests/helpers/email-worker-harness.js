/**
 * Runs src/workers/email-worker.js the way the Puter workers runtime would: a `router` global collecting its
 * routes and a `me` global holding the owner's Puter (kv, email, authToken), with the caller's own Puter
 * attached to each request as `user`, as puter.workers.exec() callers have it. Adapted from the Calendar
 * app's worker harness. `sent` records every message either mailer was handed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { vi } from 'vitest';

export const WORKER_SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/workers/email-worker.js'), 'utf8');

export function makeKv() {
  const map = new Map();
  return {
    map,
    get: vi.fn(async (k) => (map.has(k) ? map.get(k) : null)),
    set: vi.fn(async (k, v) => { map.set(k, JSON.parse(JSON.stringify(v))); return true; }),
    incr: vi.fn(async (k, by = 1) => { const n = (Number(map.get(k)) || 0) + by; map.set(k, n); return n; }),
    expire: vi.fn(async () => true),
  };
}

/** A worker with fake mailers on the owner and the caller; `outcome(message)` may return { failed, suppressed } or throw. */
export function loadEmailWorker({ outcome = null, caller = { uuid: 'u-1', username: 'demo', email: 'demo@example.com' } } = {}) {
  const kv = makeKv();
  const sent = [];
  const mailer = (via) => vi.fn(async (message) => {
    const out = outcome ? outcome(message, via) : null;
    sent.push({ via, ...message });
    return { messageId: `m${sent.length}`, suppressed: [], failed: [], ...(out || {}) };
  });
  const me = { puter: { kv, authToken: 'owner-token', email: { sendTransactional: mailer('me') } } };
  const user = caller && { puter: { authToken: 'caller-token', email: { sendTransactional: mailer('user') }, auth: { getUser: async () => ({ ...caller }) } } };
  const routes = [];
  const router = { get: (p, h) => routes.push(['GET', p, h]), post: (p, h) => routes.push(['POST', p, h]) };
  new Function('router', 'me', 'crypto', `'use strict';\n${WORKER_SOURCE}`)(router, me, webcrypto);

  async function call(method, route, { json, asUser = user } = {}) {
    const found = routes.find(([m, p]) => m === method && p === route);
    if (!found) return { status: 404, data: null };
    const request = new Request(`https://spreadsheet-email.puter.work${route}`, {
      method, headers: { 'content-type': 'application/json' }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
    const ctx = { request, me, ...(asUser ? { user: asUser } : {}) };
    const res = await found[2](ctx);
    return { status: res.status, data: await res.json() };
  }
  return { call, kv, sent, me, user };
}
