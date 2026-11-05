/**
 * Dev-only harness: runs the real worker code in the page against a
 * localStorage-backed fake KV, and installs a `puter` global with just the
 * surface the app uses: auth, the user's own kv, fs, and workers (create,
 * get, list, exec). Each mock user "deploys" their own fake worker the way
 * a real user does, and every fake worker sees its own slice of the store,
 * so the per-owner model is exercised end to end without a Puter account.
 * Tabs share the store: open one as ?as=alice and another as ?as=bob to
 * watch messages flow between them.
 *
 *   /mock.html            signed in as the last used mock user (default: alice)
 *   /mock.html?as=bob     sign in as another mock user
 *   /mock.html?reset=1    wipe the mock store
 *   /mock.html?shared=1   use one shared, open worker for everyone (the
 *                         single-deployment mode) instead of per-owner workers
 *   /mock.html?fakemic=1  a tone for a microphone and a canvas for a camera,
 *                         so huddles need no device permission (dev/mock-peer.js)
 */
import {
  createMemoryKv, createMemoryFs, createWorkerRuntime, namespacedKv, fakeAuthToken,
} from './worker-runtime.js';
import { createMockPeer, installFakeDevices } from './mock-peer.js';
import { resetServerConfigCache } from '../worker/lib.js';
import { DUE_HANDLER } from '../src/shared/events.js';

const STORE_KEY = 'teamchat:mock:kv';
const VER_KEY = 'teamchat:mock:kv:v';
const USER_KEY = 'teamchat:mock:user';
const WORKERS_KEY = 'teamchat:mock:workers';
const params = new URLSearchParams(location.search);

if (params.get('reset')) {
  for (const k of Object.keys(localStorage)) if (k.startsWith('teamchat:')) localStorage.removeItem(k);
  history.replaceState(null, '', location.pathname);
}

const USERS = {
  alice: { uuid: 'mock-alice', username: 'alice' },
  bob: { uuid: 'mock-bob', username: 'bob' },
  carol: { uuid: 'mock-carol', username: 'carol' },
};
const who = params.get('as') || localStorage.getItem(USER_KEY) || 'alice';
const currentUser = USERS[who] || USERS.alice;
localStorage.setItem(USER_KEY, who in USERS ? who : 'alice');
document.title = `Teamchat (mock: ${currentUser.username})`;

const readJson = (k, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (k, v) => localStorage.setItem(k, JSON.stringify(v));

/* ---- the shared worker store ------------------------------------------- */

let seenVersion = null;
const storage = {
  load() {
    seenVersion = localStorage.getItem(VER_KEY);
    return readJson(STORE_KEY, {});
  },
  save(obj) {
    writeJson(STORE_KEY, obj);
    seenVersion = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    localStorage.setItem(VER_KEY, seenVersion);
  },
  changed() {
    return localStorage.getItem(VER_KEY) !== seenVersion;
  },
};

/* ---- fake workers: name -> { url, file_path, owner } ------------------- */

const workers = () => readJson(WORKERS_KEY, {});
const hostOf = (url) => new URL(url).host.toLowerCase();
const workerByHost = (host) => Object.values(workers()).find((w) => hostOf(w.url) === host) || null;

if (params.get('shared')) {
  // One open worker everyone creates workspaces on.
  localStorage.setItem('teamchat:worker', 'https://teamchat-api.mock');
  const all = workers();
  if (!all['teamchat-api']) {
    all['teamchat-api'] = { name: 'teamchat-api', url: 'https://teamchat-api.mock', file_path: '/shared/teamchat-worker.js', owner: 'mock-alice', created_at: new Date().toISOString() };
    writeJson(WORKERS_KEY, all);
    const store = storage.load();
    store['teamchat-api.mock|tc:config'] = { owner: 'mock-alice', open: true };
    storage.save(store);
  }
} else {
  localStorage.removeItem('teamchat:worker');
}

// Requests are handled one at a time so `currentHost` (which slice of the
// store the worker sees, and who owns it) is stable across a handler's awaits.
let currentHost = null;
let queue = Promise.resolve();
const serialize = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

const FS_KEY = 'teamchat:mock:fs';
const runtime = await createWorkerRuntime({
  kv: namespacedKv(createMemoryKv({ storage }), () => currentHost || 'nohost'),
  // Files (attachments, photos) persist too, so a reload does not lose them.
  fs: createMemoryFs({ storage: { load: () => readJson(FS_KEY, {}), save: (obj) => writeJson(FS_KEY, obj) } }),
  owner: () => {
    const w = currentHost && workerByHost(currentHost);
    const u = w && Object.values(USERS).find((x) => x.uuid === w.owner);
    return u || null;
  },
  // Every mock worker is "deployed" from the same teamchat app, real workers
  // included, so one shared app uid for all of them is accurate. `puter.events`
  // has no local-subscription fake (no mock socket),
  // so the owner's mode:'own' bootstrap block is real but nothing ever
  // subscribes to it: the mock exercises the events fallback path rather
  // than the healthy one.
  authToken: fakeAuthToken('app-teamchat-mock'),
  loadWorker: () => import('../worker/index.js'),
});

/* ---- the puter global ---------------------------------------------------- */

let signedIn = localStorage.getItem('teamchat:mock:signedin') !== '0';
const latency = () => new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
const userKvKey = `teamchat:mock:ukv:${currentUser.uuid}`;
const driveKey = `teamchat:mock:drive:${currentUser.uuid}`;
const drivePath = (p) => (String(p).startsWith('/') ? String(p) : `/${currentUser.username}/AppData/teamchat/${p}`);

if (params.get('fakemic')) installFakeDevices();

const schedules = new Map();
const pushStateKey = `teamchat:mock:push:${currentUser.uuid}`;

async function fireSchedule(scheduleId) {
  const s = schedules.get(scheduleId);
  if (!s) return;
  clearTimeout(s.timer);
  if (s.at > Date.now()) {
    s.timer = setTimeout(() => fireSchedule(scheduleId).catch(console.error), Math.min(s.at - Date.now(), 2 ** 31 - 1));
    return;
  }
  schedules.delete(scheduleId);
  await window.puter.workers.exec(`${s.context.u}/api/ws/${encodeURIComponent(s.context.w)}/due`, { method: 'POST' });
}

window.puter = {
  env: params.get('env') === 'app' ? 'app' : 'web',
  appID: 'app-teamchat-mock',
  perms: { async check() { return true; }, async request(requests) { return Array.isArray(requests) ? requests.map(() => true) : true; } },
  notifications: {
    async enable() { localStorage.setItem(pushStateKey, 'on'); return true; },
    async disable() { localStorage.removeItem(pushStateKey); return true; },
    async status() { return localStorage.getItem(pushStateKey) || 'off'; },
    async onPush() { return { async off() {} }; },
    on() {},
  },
  events: {
    async onSchedule({ at, handlerName, context }) {
      if (handlerName !== DUE_HANDLER) throw { code: 'events_handler_not_found' };
      const scheduleId = crypto.randomUUID();
      const timer = setTimeout(() => fireSchedule(scheduleId).catch(console.error), Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
      schedules.set(scheduleId, { scheduleId, at, context, timer });
      return { scheduleId };
    },
    async removeSchedule(scheduleId) {
      const s = schedules.get(scheduleId);
      if (!s) throw { code: 'events_schedule_not_found' };
      clearTimeout(s.timer);
      schedules.delete(scheduleId);
    },
  },
  /* Peer connections between mock tabs: real WebRTC, signalled over a BroadcastChannel. */
  peer: createMockPeer({ user: currentUser }),
  auth: {
    isSignedIn: () => signedIn,
    async signIn() {
      await latency();
      signedIn = true;
      localStorage.setItem('teamchat:mock:signedin', '1');
      return { uuid: currentUser.uuid, username: currentUser.username };
    },
    async signOut() {
      signedIn = false;
      localStorage.setItem('teamchat:mock:signedin', '0');
    },
    async getUser() {
      return { ...currentUser, email_confirmed: true };
    },
  },
  /* The user's own key-value store (what the app keeps per account). */
  kv: {
    async get(k) {
      await latency();
      return readJson(userKvKey, {})[k] ?? null;
    },
    async set(k, v) {
      await latency();
      const all = readJson(userKvKey, {});
      all[k] = v;
      writeJson(userKvKey, all);
      return true;
    },
    async del(k) {
      const all = readJson(userKvKey, {});
      delete all[k];
      writeJson(userKvKey, all);
      return true;
    },
  },
  /* The user's drive, enough for the worker bundle. */
  fs: {
    async write(path, data) {
      await latency();
      const text = typeof data === 'string' ? data : await new Response(data).text();
      const full = drivePath(path);
      const drive = readJson(driveKey, {});
      drive[full] = text;
      writeJson(driveKey, drive);
      return { path: full, name: full.split('/').pop(), size: text.length };
    },
    async read(path) {
      const drive = readJson(driveKey, {});
      const full = drivePath(path);
      if (!(full in drive)) throw new Error('File not found');
      return new Blob([drive[full]], { type: 'application/javascript' });
    },
  },
  workers: {
    async create(name, filePath) {
      await latency();
      await latency();
      const all = workers();
      if (all[name]) throw new Error(`A worker named ${name} already exists`);
      const drive = readJson(driveKey, {});
      if (!(drivePath(filePath) in drive)) throw new Error('Worker file not found');
      all[name] = { name, url: `https://${name}.puter.work`, file_path: drivePath(filePath), owner: currentUser.uuid, created_at: new Date().toISOString() };
      writeJson(WORKERS_KEY, all);
      return { name, url: all[name].url };
    },
    async get(name) {
      const w = workers()[name];
      return w && w.owner === currentUser.uuid ? { ...w } : undefined;
    },
    async list() {
      return Object.values(workers()).filter((w) => w.owner === currentUser.uuid);
    },
    async delete(name) {
      const all = workers();
      if (!all[name] || all[name].owner !== currentUser.uuid) throw new Error('Worker not found');
      delete all[name];
      writeJson(WORKERS_KEY, all);
      return true;
    },
    async exec(url, init = {}) {
      await latency();
      const host = hostOf(url);
      // The app's one shared email worker (worker/email.js) lives outside the
      // per-owner workspace workers, so it is faked separately here: sends are
      // recorded, never delivered. Read them back with __mock.emails().
      if (host === 'teamchat-email.puter.work') return mockEmailWorker(url, init);
      if (!workerByHost(host)) return new Response('', { status: 404 });
      return serialize(async () => {
        // One worker module serves every fake host here, so its per-process
        // caches must not carry over from one owner's worker to another's.
        if (currentHost !== host) resetServerConfigCache();
        currentHost = host;
        try {
          return await runtime.dispatch(url, init, signedIn ? currentUser : null);
        } finally {
          currentHost = null;
        }
      });
    },
  },
};

/**
 * The fake teamchat-email worker: same routes and answer shape as
 * worker/email.js, but every "sent" mail is appended to
 * localStorage teamchat:mock:emails instead of delivered.
 */
const EMAILS_KEY = 'teamchat:mock:emails';
async function mockEmailWorker(url, init = {}) {
  const path = new URL(url).pathname;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (init.method !== 'POST' || path !== '/invites') return json({ ok: true, version: 'mock' });
  if (!signedIn) return json({ error: 'sign_in_required', detail: 'no_caller' }, 401);
  let body = null;
  try {
    body = JSON.parse(init.body);
  } catch { /* refused below */ }
  const emails = [...new Set(Array.isArray(body?.emails) ? body.emails : [])].filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e)));
  if (!body || !['workspace', 'guest', 'connect'].includes(body.kind) || !emails.length) return json({ error: 'invalid' }, 400);
  if (emails.length > 10) return json({ error: 'too_many_recipients' }, 400);
  const log = readJson(EMAILS_KEY, []);
  for (const to of emails) log.push({ at: Date.now(), from: currentUser.username, to, kind: body.kind, server: body.server, code: body.code, workspace: body.workspace, channel: body.channel, inviter: body.inviter, note: body.note || null, app: body.app });
  writeJson(EMAILS_KEY, log);
  return json({ ok: true, sent: emails.length, failed: 0, suppressed: 0, capped: 0, results: emails.map((email) => ({ email, status: 'sent' })) });
}

// The worker runs from source here, so the bundle the app would deploy is
// stood in for by a stub with the same build id the source reports ('dev').
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (/\/worker\/teamchat-worker\.js(\?|$)/.test(url)) {
    return new Response('/* teamchat-worker build=dev */\n// mock: the worker runs from source in this page\n', {
      status: 200, headers: { 'Content-Type': 'application/javascript' },
    });
  }
  return realFetch(input, init);
};

window.__mock = { runtime, users: USERS, currentUser, workers, schedules, fireSchedule, notifications: runtime.notifications.sent, emails: () => readJson(EMAILS_KEY, []) };

await import('../src/main.js');
