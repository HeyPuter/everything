/**
 * Development only (?local): the real collaboration service (worker/service.js)
 * running in the browser on storage kept in localStorage, so sharing,
 * invitations, roles, presence and live editing can be tried without a
 * Puter account. Every tab of the dev server shares this one "server";
 * open another tab with ?local&as=<name> to act as someone else.
 */
import { WikiService } from '../../worker/service.js';

const KEY = 'wiki-dev-server';
const SERVER = 'https://wiki-dev.puter.work';
const OWNER = { uuid: '00000000-0000-4000-8000-000000000001', username: 'you' };

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{"kv":{},"fs":{}}');
  } catch {
    return { kv: {}, fs: {} };
  }
}

function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* full: the dev server just forgets */
  }
}

function fakePuter(listeners) {
  const state = () => load();
  const missing = () => Object.assign(new Error('not found'), { code: 'subject_does_not_exist' });
  const kv = {
    async get(key) {
      const s = state();
      return Array.isArray(key) ? key.map((k) => s.kv[k] ?? null) : (s.kv[key] ?? null);
    },
    async set(key, value, expireAt) {
      const s = state();
      s.kv[key] = value;
      save(s);
      for (const fn of listeners) fn(key, value);
      return true;
    },
    async del(key) {
      const s = state();
      delete s.kv[key];
      save(s);
      return true;
    },
    async incr(key, amount = 1) {
      const s = state();
      s.kv[key] = (s.kv[key] || 0) + amount;
      save(s);
      return s.kv[key];
    },
    async expire() {
      return true;
    },
    async list({ pattern, reverse, limit = 1000, cursor }) {
      const prefix = String(pattern).replace(/\*$/, '');
      const s = state();
      let keys = Object.keys(s.kv).filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      return { items: page.map((key) => ({ key, value: s.kv[key] })), ...(start + limit < keys.length ? { cursor: String(start + limit) } : {}) };
    },
  };
  const fs = {
    async read(path) {
      const s = state();
      if (!(path in s.fs)) throw missing();
      return new Blob([s.fs[path]]);
    },
    async write(path, text) {
      const s = state();
      s.fs[path] = typeof text === 'string' ? text : await new Blob([text]).text();
      save(s);
      return { path };
    },
    async stat(path) {
      if (!(path in state().fs)) throw missing();
      return { path };
    },
    async delete(path) {
      const s = state();
      delete s.fs[path];
      save(s);
    },
  };
  return { kv, fs, auth: { getUser: async () => OWNER }, authToken: 'dev.eyJhcHBfdWlkIjoiYXBwLWRldiJ9.dev', APIOrigin: 'https://api.invalid' };
}

/** A collab adapter like the one main.js builds for Puter, for a dev identity. */
export function localCollab(user) {
  const listeners = new Set();
  const puter = fakePuter(listeners);
  const subs = new Map();
  // Subjects name their room (in the owner's key or the handle), so a signal
  // reaches only that space. Handles made before they named it get a signal
  // without detail, which fetches everything.
  const deliver = (key, value) => {
    const room = key.split(':')[1];
    for (const [subject, fn] of subs) {
      if (subject.includes(room)) fn({ event: { op: 'set', key, value } });
      else if (/^kv:dev-[0-9a-f]{8}-[0-9a-f]{4}-/.test(subject)) fn({ event: { op: 'set', key, value: {} } });
    }
  };
  // Other tabs' writes arrive as storage events; turn signal writes into live events.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    let before = {};
    let after = {};
    try {
      before = JSON.parse(e.oldValue || '{}').kv || {};
      after = JSON.parse(e.newValue || '{}').kv || {};
    } catch {
      return;
    }
    for (const [key, value] of Object.entries(after)) if (key.endsWith(':ev:signal') && JSON.stringify(before[key]) !== JSON.stringify(value)) deliver(key, value);
  });
  listeners.add((key, value) => {
    if (key.endsWith(':ev:signal')) deliver(key, value);
  });
  const identity = user.username === OWNER.username ? OWNER : user;
  return {
    request: async (_server, op, data) => {
      try {
        const fetcher = async (_url, init) => ({ ok: true, json: async () => ({ handle: `dev-${identity.uuid.slice(0, 8)}-${init?.body ? JSON.parse(init.body).prefix.split(':')[1] : 'x'}` }) });
        const service = new WikiService(puter, { fetcher });
        return structuredClone(await service.call(identity, { op, ...data }));
      } catch (err) {
        throw Object.assign(new Error(err.message), { status: err.status || 500 });
      }
    },
    deploy: async (progress) => {
      progress('Starting the local sharing server...');
      if (identity !== OWNER) throw new Error('In the local sandbox only "you" can share. Open the app without ?as= to share.');
      return SERVER;
    },
    refresh: async () => {},
    events: {
      async onLocal(subject, fn) {
        subs.set(subject, fn);
        return { off: () => subs.delete(subject) };
      },
    },
    grantEvents: () => {},
  };
}

export function devUser(name) {
  if (!name || name === OWNER.username) return OWNER;
  const clean = String(name).replace(/[^a-z0-9]/gi, '').slice(0, 20).toLowerCase() || 'guest';
  let n = 0;
  for (const ch of clean) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const hex = n.toString(16).padStart(8, '0');
  return { uuid: `${hex}-0000-4000-8000-${hex.padEnd(12, '0').slice(0, 12)}`, username: clean };
}
