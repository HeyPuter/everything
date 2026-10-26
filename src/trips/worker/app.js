import { createClock } from '../src/shared/hlc.js';
import { isUuid, newId } from '../src/shared/ids.js';
import { LIMITS } from '../src/shared/limits.js';
import { PROTOCOL, WORKER_PATTERN } from '../src/shared/protocol.js';
import { plainObject } from '../src/shared/schema/dsl.js';
import { createAuth } from './auth.js';
import { createCache, createLimiter } from './cache.js';
import { CORS, check, fail, json, readBody, wrap } from './http.js';
import { K, fileIdOf, own, spaceId } from './keys.js';
import { commit } from './engine/commit.js';
import { fileDel, filePut, getFile, putFile } from './engine/files.js';
import { inviteCreate, inviteDecline, inviteList, inviteRevoke, join, joinPreview, leave, memberRemove, memberRole } from './engine/members.js';
import { feedSet, icsFeed, publicFile, publicThumb, publicView, shareSet } from './engine/public.js';
import { spaceCreate, spaceDelete, spaceExport, spaceList } from './engine/spaces.js';
import { createStore } from './engine/store.js';
import { chatPage, heads, open, pres, repair, snapshot, sync } from './engine/sync.js';
import * as registry from './ops/index.js';
import { getThumb, putThumb } from './ops/trip/file.js';
import { linkUnfurl } from './ops/trip/unfurl.js';
import { allFeedRoute, feedAll } from './ops/feed/all.js';

/* global __TRIPS_BUILD__, __TRIPS_BUILT_AT__ */
export const BUILD = typeof __TRIPS_BUILD__ === 'undefined' ? 'unbuilt' : __TRIPS_BUILD__;
export const BUILT_AT = typeof __TRIPS_BUILT_AT__ === 'undefined' ? 0 : __TRIPS_BUILT_AT__;

const HANDLERS = Object.freeze({
  'space.create': spaceCreate, 'space.list': spaceList, 'space.export': spaceExport, 'space.delete': spaceDelete,
  heads, open, sync, snapshot, repair, pres, commit, 'chat.page': chatPage,
  'invite.create': inviteCreate, 'invite.list': inviteList, 'invite.revoke': inviteRevoke,
  'join.preview': joinPreview, join, 'invite.decline': inviteDecline,
  'member.role': memberRole, 'member.remove': memberRemove, leave,
  'share.set': shareSet, 'feed.set': feedSet, 'file.put': filePut, 'file.del': fileDel,
  'link.unfurl': linkUnfurl, 'feed.all': feedAll,
});

/** Per-isolate state. Caches hold settled values only; no request ever awaits another request's promise. */
export function createContext(me, options = {}) {
  // `me` is the owner object, or a getter for it where the runtime sets it up lazily.
  const owner = typeof me === 'function' ? me : () => me;
  let store = null;
  const now = options.now ?? (() => Date.now());
  const ownerCache = { value: null };
  const hosted = { value: null, at: -Infinity };
  const app = { value: null };
  // The app this worker is bound to: `me.puter.appID`, else read from its AppData root.
  const appUid = async () => {
    if (!app.value) {
      const { puter } = owner();
      let found = typeof puter.appID === 'string' && puter.appID ? puter.appID : null;
      if (!found) found = /\/AppData\/([^/]+)/.exec((await puter.fs.stat('')).path ?? '')?.[1] ?? null;
      if (!found) fail('internal', 500);
      app.value = found;
    }
    return app.value;
  };
  const w = {
    get me() { return owner(); }, now,
    get kv() { return store ??= createStore(owner().puter.kv); },
    get fs() { return owner().puter.fs; },
    clock: createClock({ node: newId(), now }),
    ops: options.ops ?? { typeHooks: registry.typeHooks, domainOps: registry.domainOps, handlers: registry.handlers, guards: registry.guards },
    build: options.build ?? BUILD,
    builtAt: options.builtAt ?? BUILT_AT,
    spaces: createCache({ max: 600 }),
    snapMetas: createCache({ max: 600 }),
    snapshots: createCache({ max: 64, maxBytes: 16 * 1024 * 1024, size: (entry) => entry?.bytes?.byteLength ?? 0 }),
    parsed: createCache({ max: 8, maxBytes: 48 * 1024 * 1024, size: (entry) => entry?.weight ?? 0 }),
    projections: createCache({ max: 200, maxBytes: 8 * 1024 * 1024, size: (entry) => entry?.weight ?? 0 }),
    publicState: createCache({ max: 200 }),
    feeds: createCache({ max: 2000 }),
    presence: createCache({ max: 600 }),
    presenceWrites: createCache({ max: 5000 }),
    // Settled change records keyed `<space>:<rev>`, so repeated catch-ups cost no KV reads.
    records: createCache({ max: 4000, maxBytes: 16 * 1024 * 1024, size: (entry) => entry?.weight ?? 0 }),
    meters: createCache({ max: 5000 }),
    limiter: createLimiter({ now }),
    features: { handlesOff: 0 },
    auth: createAuth({ now, appUid: () => appUid() }),
    /** The worker's `idx`, cached 30 s and re-read (at most every 5 s) when an id is missing. */
    async hosted(ids = []) {
      const time = now();
      const stale = time - hosted.at >= 30_000 || (ids.some((id) => !Object.hasOwn(hosted.value ?? {}, id)) && time - hosted.at >= 5000);
      if (!hosted.value || stale) {
        hosted.value = (await w.kv.get(K.idx)) ?? {};
        hosted.at = time;
      }
      return hosted.value;
    },
    /** The cached `idx` without reading, or null when this isolate has none. */
    hostedCached() { return hosted.value ? { value: hosted.value, fresh: now() - hosted.at < 30_000 } : null; },
    hostedSet(value) { hosted.value = value && typeof value === 'object' ? value : {}; hosted.at = now(); },
    hostedAdd(id, item) { if (hosted.value) hosted.value = { ...hosted.value, [id]: item }; },
    hostedRemove(id) { if (hosted.value) { const { [id]: _gone, ...rest } = hosted.value; hosted.value = rest; } },
    async owner() {
      if (!ownerCache.value) {
        const user = await owner().puter.auth.getUser();
        if (!isUuid(user?.uuid)) fail('internal', 500);
        ownerCache.value = { uuid: user.uuid, username: typeof user.username === 'string' ? user.username : '' };
      }
      return ownerCache.value;
    },
  };
  return w;
}

const handlerOf = (w, op) => (Object.hasOwn(HANDLERS, op) ? HANDLERS[op] : own(w.ops.handlers, op));

function features(w) {
  return [...Object.keys(HANDLERS), ...Object.keys(w.ops.handlers ?? {}), ...Object.keys(w.ops.domainOps).map((name) => `do:${name}`)];
}

/** A request-scoped view of the isolate state with this request's `waitUntil` and worker name. */
function scoped(w, event, request) {
  const host = new URL(request.url).hostname.split('.')[0];
  const waitUntil = event?.event?.waitUntil ?? event?.waitUntil;
  return Object.assign(Object.create(w), {
    workerName: WORKER_PATTERN.test(host) ? host : null,
    waitUntil: (promise) => { if (typeof waitUntil === 'function') waitUntil.call(event?.event ?? event, promise); else void promise; },
  });
}

/** Registers every route on the worker router. */
export function install({ router, me, options = {} }) {
  // The runtime forbids random values and timers at load, and `me` only exists from the first request on, so the
  // context is built on first use. Every route reads `w` inside its handler.
  let context = null;
  const ready = () => (context ??= createContext(me, options));
  const w = new Proxy({}, { get: (_, key) => ready()[key], has: (_, key) => key in ready(), set: (_, key, value) => { ready()[key] = value; return true; } });
  const decoder = new TextDecoder();

  router.get('/health', wrap(async () => json({ ok: true, build: w.build, builtAt: w.builtAt, protocol: PROTOCOL })));

  router.post('/api', wrap(async (event) => {
    const { request, user } = event;
    const text = decoder.decode(await readBody(request, LIMITS.bodyBytes));
    let input;
    try { input = JSON.parse(text); } catch { fail('invalid_json'); }
    check(plainObject(input) && typeof input.op === 'string', 'invalid_request');
    if (input.op === 'hello') return json({ ok: true, build: w.build, builtAt: w.builtAt, protocol: PROTOCOL, features: features(w) });
    const handler = handlerOf(w, input.op);
    if (typeof handler !== 'function') fail('unknown_op', 400);
    const rq = scoped(w, event, request);
    const ident = await w.auth(request, user, text);
    const result = await handler(rq, ident, input);
    return result instanceof Response ? result : json({ ok: true, ...result });
  }));

  const fileRoute = (method, run, suffix = '') => wrap(async (event) => {
    const { request, user, params } = event;
    const sid = spaceId(params.space);
    const fileId = fileIdOf(params.fileId);
    const rq = scoped(w, event, request);
    // File routes sign "<METHOD> <pathname>" because the body is the file itself.
    const ident = await w.auth(request, user, `${method} /files/${sid}/${fileId}${suffix}`);
    return run(rq, ident, request, sid, fileId);
  });
  router.put('/files/:space/:fileId', fileRoute('PUT', (rq, ident, request, sid, fileId) => putFile(rq, ident, request, sid, fileId)));
  router.get('/files/:space/:fileId', fileRoute('GET', (rq, ident, _request, sid, fileId) => getFile(rq, ident, sid, fileId)));
  router.put('/files/:space/:fileId/thumb', fileRoute('PUT', (rq, ident, request, sid, fileId) => putThumb(rq, ident, request, sid, fileId), '/thumb'));
  router.get('/files/:space/:fileId/thumb', fileRoute('GET', (rq, ident, _request, sid, fileId) => getThumb(rq, ident, sid, fileId), '/thumb'));

  router.get('/pub/:space/:token', wrap(async (event) => publicView(scoped(w, event, event.request), event.params, event.request)));
  router.get('/pub/:space/:token/f/:fileId', wrap(async (event) => publicFile(scoped(w, event, event.request), event.params)));
  router.get('/pub/:space/:token/f/:fileId/thumb', wrap(async (event) => publicThumb(scoped(w, event, event.request), event.params)));
  router.get('/ics/:space/:uuid/:file', wrap(async (event) => icsFeed(scoped(w, event, event.request), event.params, event.request)));
  router.get('/feed/:file', wrap(async (event) => allFeedRoute(scoped(w, event, event.request), event.params, event.request)));

  router.options('/*path', () => new Response(null, { status: 204, headers: CORS }));
  for (const method of ['get', 'post', 'put', 'delete']) router[method]('/*path', wrap(async () => fail('not_found', 404)));
  return w;
}
