import { clone, error } from './shared.js';
import { createKv } from './kv.js';
import { consentFromPermission, consentRequest, grantConsent, mintHandle, retireApp, revokeHandle, usableHandle } from './shares.js';
import { createFs } from './fs.js';
import { createEvents } from './events.js';
import { createWorkerApi, registerWorker } from './workers.js';
import { aiControls, createAiState, createFakeAi } from './ai.js';

// jsdom's Blob has no text().
const blobText = blob => (typeof blob.text === 'function' ? blob.text() : new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob);
}));

/** A development-only Puter world. All clients from one world share its state. `ai: true` adds the scripted `puter.ai` (ai.js). */
export function createFakePuter(options = {}) {
  const regionCount = options.regions ?? 1;
  if (![1, 2].includes(regionCount)) throw new TypeError('regions must be 1 or 2');
  let offset = 0;
  let sequence = 0;
  const users = new Map();
  const tokens = new Map();
  const stores = Array.from({ length: regionCount }, () => new Map());
  const replication = [];
  const failures = [];
  const offline = new Set();
  const rateWindows = new Map();
  const inFlight = new Map();
  let stats = { calls: {}, byUser: {}, log: [], kvReadUnits: 0, kvWriteUnits: 0, fsReadOps: 0, fsWriteOps: 0, egressBytes: 0, events: 0, microCents: 0 };
  const env = {
    options, users, tokens, stores, handles: new Map(), consents: new Map(), shareNotices: new Map(), deniedPerms: new Set(), removedUsers: new Set(), removedApps: new Set(), files: new Map(), fileShares: new Map(), readTokens: new Map(), workers: new Map(), subscriptions: new Map(), eventQueue: [], pendingWork: new Set(),
    isOffline: uid => offline.has('*') || offline.has(uid),
    ai: options.ai ? createAiState() : null,
    // `onlyIfAbsent: false` models a server that predates the option and ignores it.
    flags: { shareHandles: options.shareHandles ?? false, onlyIfAbsent: options.onlyIfAbsent ?? true },
    now: () => (typeof options.now === 'function' ? options.now() : options.now ?? Date.now()) + offset,
    id: prefix => `${prefix}-${++sequence}`,
    // Puter FS uids are UUIDs; the variant nibble keeps these apart from the fixtures' user uuids.
    uuid: () => `00000000-0000-4000-a000-${(++sequence).toString(16).padStart(12, '0')}`,
    token(claims) {
      const encode = value => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      return `${encode({ alg: 'fake' })}.${encode({ ...claims, jti: env.id('token') })}.fake`;
    },
    user(as = 'alice') {
      if (as && typeof as === 'object') {
        const user = { uuid: as.uuid ?? as.username, username: as.username ?? as.uuid, email_confirmed: true, verified: true, ...as };
        users.set(user.uuid, user);
        return user;
      }
      const found = [...users.values()].find(u => u.uuid === as || u.username === as);
      if (found) return found;
      const user = { uuid: as, username: as, email_confirmed: true, verified: true };
      users.set(user.uuid, user);
      return user;
    },
    charge(ctx, units) {
      const bucket = stats.byUser[ctx.uid] ??= { calls: {}, kvReadUnits: 0, kvWriteUnits: 0, fsReadOps: 0, fsWriteOps: 0, egressBytes: 0, events: 0, microCents: 0 };
      const costs = { kvReadUnits: 50, kvWriteUnits: 250, fsReadOps: 100, fsWriteOps: 1000, egressBytes: 20_000_000 / 2 ** 30, events: 10 };
      for (const [key, amount] of Object.entries(units)) {
        stats[key] += amount; bucket[key] += amount;
        stats.microCents += amount * costs[key]; bucket.microCents += amount * costs[key];
      }
    },
    call(ctx, method, operation) {
      return (async () => {
        // Workers are public HTTP endpoints: a signed-out page may call one without credentials (public links).
        if ((!ctx.uid && method !== 'workers.exec') || env.removedUsers.has(ctx.uid)) throw error('auth_required', 401);
        if (offline.has('*') || offline.has(ctx.uid)) throw error('offline', 0);
        const bucketKey = JSON.stringify([ctx.uid, method === 'fs.getReadURL' ? null : ctx.appUid, method]);
        const policies = [];
        const shareCalls = ['kv.share', 'kv.unshare', 'kv.listShared', 'kv.listSharedByMe'];
        if (method.startsWith('kv.') && !shareCalls.includes(method)) policies.push([400, 10_000]);
        // Sharing and unsharing share one budget per user across apps; both listings share one per user and app.
        if (method === 'kv.share' || method === 'kv.unshare') policies.push([60, 60_000, JSON.stringify([ctx.uid, 'kv.shares']), 'too_many_requests']);
        if (method === 'kv.listShared' || method === 'kv.listSharedByMe') policies.push([120, 60_000, JSON.stringify([ctx.uid, ctx.appUid, 'kv.shareLists']), 'too_many_requests']);
        if (method === 'kv.list') policies.push([users.get(ctx.uid)?.paid ? 240 : 120, 60_000]);
        const fsCaps = { 'fs.read': [600, 300], 'fs.write': [300, 120], 'fs.stat': [1200, 600], 'fs.readdir': [600, 300] };
        if (fsCaps[method]) policies.push([fsCaps[method][users.get(ctx.uid)?.paid ? 0 : 1], 60_000]);
        if (method === 'fs.getReadURL') policies.push([20, 3_600_000]);
        if (method === 'fs.share') policies.push([60, 60_000]);
        if (options.enforceRateLimits !== false) {
          if ((inFlight.get(bucketKey) ?? 0) >= 30) throw error('rate_limit_exceeded', 429);
          for (const [cap, interval, bucket = bucketKey, code = 'rate_limit_exceeded'] of policies) {
            const key = `${bucket}:${interval}`;
            const times = (rateWindows.get(key) ?? []).filter(t => t > env.now() - interval);
            if (times.length >= cap) throw error(code, 429);
            times.push(env.now()); rateWindows.set(key, times);
          }
        }
        const failure = failures.find(f => (!f.method || f.method === method) && (!f.as || f.as === ctx.uid));
        if (failure && --failure.times === 0) failures.splice(failures.indexOf(failure), 1);
        stats.calls[method] = (stats.calls[method] ?? 0) + 1;
        const bucket = stats.byUser[ctx.uid] ??= { calls: {}, kvReadUnits: 0, kvWriteUnits: 0, fsReadOps: 0, fsWriteOps: 0, egressBytes: 0, events: 0, microCents: 0 };
        bucket.calls[method] = (bucket.calls[method] ?? 0) + 1;
        stats.log.push({ method, payer: ctx.uid, region: ctx.region, worker: ctx.worker ?? false, at: env.now() });
        if (failure) throw error(failure.code, failure.status, failure.message);
        inFlight.set(bucketKey, (inFlight.get(bucketKey) ?? 0) + 1);
        try {
          if (options.latency) await new Promise(resolve => setTimeout(resolve, options.latency));
          env.replicate();
          return await operation();
        } finally { inFlight.set(bucketKey, inFlight.get(bucketKey) - 1); }
      })();
    },
    /** A handle usable by this caller, or undefined when unknown, revoked, foreign, or its owner or app is gone. */
    liveHandle(id, uid, appUid) { return usableHandle(env, id, uid, appUid); },
    namespace(uid, appUid) { return JSON.stringify([uid, appUid]); },
    store(region, uid, appUid) {
      const namespace = env.namespace(uid, appUid);
      if (!stores[region].has(namespace)) stores[region].set(namespace, new Map());
      return stores[region].get(namespace);
    },
    live(entry) { return entry && !entry.deleted && (entry.expires == null || entry.expires > env.now()); },
    commit(ctx, scope, key, entry) {
      const stamp = [env.now(), ++sequence];
      const saved = { ...clone(entry), stamp };
      env.store(ctx.region, scope.uid, scope.appUid).set(key, saved);
      for (let region = 0; region < regionCount; region++) {
        if (region !== ctx.region) replication.push({ region, uid: scope.uid, appUid: scope.appUid, key, entry: clone(saved), due: env.now() + (options.replicationDelay ?? 50) });
      }
      env.emitKv?.(ctx, scope, key, saved);
    },
    replicate(all = false) {
      for (let i = replication.length - 1; i >= 0; i--) {
        const item = replication[i];
        if (!all && item.due > env.now()) continue;
        replication.splice(i, 1);
        const map = env.store(item.region, item.uid, item.appUid);
        const old = map.get(item.key);
        if (!old || old.stamp[0] < item.entry.stamp[0] || (old.stamp[0] === item.entry.stamp[0] && old.stamp[1] < item.entry.stamp[1])) map.set(item.key, item.entry);
      }
    },
    client(as, region = 0, config = {}) {
      if (region < 0 || region >= regionCount || !Number.isInteger(region)) throw new TypeError('Unknown region');
      const user = as === null ? null : env.user(as);
      const ctx = { uid: user?.uuid ?? null, appUid: config.appUid ?? options.appUid ?? 'trips', region, worker: config.worker ?? false, restricted: config.restricted ?? null };
      const token = config.token ?? (user ? env.token({ type: 'app-under-user', user_uid: ctx.uid, app_uid: ctx.appUid }) : null);
      if (token && user && !config.restricted) tokens.set(token, { uid: ctx.uid, appUid: ctx.appUid, kind: 'session' });
      const client = {
        env: 'web', appID: ctx.appUid, authToken: token, APIOrigin: 'https://api.puter.test',
        auth: {
          isSignedIn: () => Boolean(ctx.uid),
          getUser: () => env.call(ctx, 'auth.getUser', () => { if (ctx.restricted) throw error('permission_denied', 403); return clone({ ...users.get(ctx.uid), app_name: ctx.appUid }); }),
          async signIn() { if (!ctx.uid) { const signed = env.user('alice'); ctx.uid = signed.uuid; client.authToken = env.token({ type: 'app-under-user', user_uid: ctx.uid, app_uid: ctx.appUid }); tokens.set(client.authToken, { uid: ctx.uid, appUid: ctx.appUid, kind: 'session' }); } return client.auth.getUser(); },
          async signOut() { ctx.uid = null; client.authToken = null; },
        },
        kv: createKv(env, ctx), fs: createFs(env, ctx), events: createEvents(env, ctx),
      };
      // Only the `kvShare` consent is modelled; the user answers Allow unless the world says otherwise. Workers cannot prompt.
      if (!config.worker) {
        client.perms = {
          request: (resource, details) => env.call(ctx, 'perms.request', () => {
            if (ctx.restricted) throw error('permission_denied', 403);
            const consent = resource === 'kvShare' ? consentRequest(ctx, details) : resource === 'permission' ? consentFromPermission(ctx, details?.permission) : null;
            if (!consent || env.deniedPerms.has(ctx.uid)) return false;
            grantConsent(env, ctx, consent);
            return true;
          }),
        };
      }
      client.getUser = client.auth.getUser;
      client.workers = createWorkerApi(env, ctx, client);
      if (env.ai) {
        client.ai = createFakeAi({
          state: env.ai,
          call: (method, run) => env.call(ctx, method, run),
          readFile: async path => { const node = env.fsNode?.(ctx, path); return node && !node.is_dir && env.fsPermission(ctx, node, 'read') && node.data ? blobText(node.data) : null; },
        });
      }
      return client;
    },
  };
  for (const user of options.users ?? ['alice', 'bob', 'carol']) env.user(user);
  return {
    client: env.client,
    flags: env.flags,
    /** Scripts and failure switch for the fake `puter.ai`; null unless created with `ai: true`. */
    ai: env.ai ? aiControls(env.ai) : null,
    user: as => clone(env.user(as)),
    registerWorker: (name, config) => registerWorker(env, name, config),
    counters: () => clone(stats),
    resetCounters() { stats = { calls: {}, byUser: {}, log: [], kvReadUnits: 0, kvWriteUnits: 0, fsReadOps: 0, fsWriteOps: 0, egressBytes: 0, events: 0, microCents: 0 }; },
    setOffline(as, value = true) { const uid = as === '*' ? '*' : env.user(as).uuid; value ? offline.add(uid) : offline.delete(uid); if (!value) env.gap?.(uid); },
    failNext({ method, as, code = 'insufficient_funds', status = 402, times = 1, message = code } = {}) { failures.push({ method, as: as ? env.user(as).uuid : null, code, status, times, message }); },
    advance(ms) { offset += ms; env.replicate(); },
    flushReplication() { env.replicate(true); },
    async flushEvents() { await Promise.resolve(); await Promise.all(env.eventQueue.splice(0)); },
    async flushWorkers() { while (env.pendingWork.size) await Promise.allSettled([...env.pendingWork]); },
    readURL: (url, init) => env.readURL(url, init),
    /** Legacy watch-handle routes: `POST /events/kv-handles {granteeUid, prefix, access?}` and `DELETE /events/kv-handles/<handle>`. */
    async fetchApi(input, init) {
      const request = new Request(input, init);
      const session = tokens.get(/^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]);
      const path = new URL(request.url).pathname;
      const reply = (status, body) => Response.json(body, { status });
      try {
        if (!session) throw error('auth_required', 401);
        const ctx = { uid: session.uid, appUid: session.appUid, region: 0, worker: false, restricted: null };
        if (request.method === 'POST' && path === '/events/kv-handles') {
          const body = await request.json().catch(() => ({}));
          return reply(200, await env.call(ctx, 'kv.share', () => mintHandle(env, ctx, { prefix: body.prefix, recipient: { uid: body.granteeUid }, access: body.access, label: body.label }, 'watch')));
        }
        const match = /^\/events\/kv-handles\/([^/]+)$/.exec(path);
        if (request.method === 'DELETE' && match) {
          return reply(200, await env.call(ctx, 'kv.unshare', () => revokeHandle(env, ctx, decodeURIComponent(match[1]))));
        }
        throw error('not_found', 404);
      } catch (cause) {
        if (cause.code === 'offline') throw new TypeError('Failed to fetch');
        return reply(cause.status >= 400 && cause.status <= 599 ? cause.status : 500, { code: cause.code ?? 'internal_error', message: cause.message });
      }
    },
    removeUser(as) { env.removedUsers.add(env.user(as).uuid); },
    /** Account settings tests flip: `paid`, `email_confirmed`, `temporary`, `refusesShares`, `blocks` (usernames or uuids). */
    configureUser(as, fields) { Object.assign(env.user(as), fields); },
    /** Puter usernames can change; shares and uuids stay with the account. */
    renameUser(as, username) { env.user(as).username = username; },
    removeApp(appUid) { env.removedApps.add(appUid); retireApp(env, appUid); },
    /** The owner's `puter.perms.request('kvShare', {prefix, access})` answered Allow, for tests that skip the UI. */
    grantShareConsent(as, prefix, access = 'watch', appUid = options.appUid ?? 'trips') {
      const ctx = { uid: env.user(as).uuid, appUid };
      grantConsent(env, ctx, consentRequest(ctx, { prefix, access }));
    },
    /** The user withdraws every `kvShare` consent this app holds; existing shares stay. */
    revokeShareConsent(as, appUid = options.appUid ?? 'trips') { env.consents.delete(`${env.user(as).uuid}|${appUid}`); },
    /** Later permission prompts for this user are answered Deny (or Allow again with `false`). */
    denyPermissions(as, value = true) { const uid = env.user(as).uuid; value ? env.deniedPerms.add(uid) : env.deniedPerms.delete(uid); },
    inspectKv(as, region = 0, appUid = options.appUid ?? 'trips') {
      return Object.fromEntries([...env.store(region, env.user(as).uuid, appUid)].filter(([, entry]) => env.live(entry)).map(([key, entry]) => [key, clone(entry.value)]));
    },
    pendingReplication: () => replication.length,
  };
}
