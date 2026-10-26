import { MAX_KEY_SIZE, MAX_VALUE_SIZE, bytes, changePath, clone, counterArgs, error, isObject, jsonBytes, keyString, number, optCallbacks, pathEntries, shorthandConfig, trailing, validateValue } from './shared.js';

import { HANDLE_KEY_MAX, listGranted, listHeld, mintHandle, removeShare } from './shares.js';

export { mintHandle, revokeHandle } from './shares.js';

// One body for every unusable handle, so holders cannot probe why.
const handleNotFound = () => error('kv_handle_not_found', 404, 'kv: no such share handle');
const READS = new Set(['get', 'list']);

/** The namespace a call reaches: the caller's own, or a share's region through `optConfig.handle`. */
export function resolveScope(env, ctx, config = {}, method = 'get') {
  if (ctx.restricted) throw error('permission_denied', 403);
  config ??= {};
  if (config.handle === undefined || config.handle === null) {
    if (config.appUuid && config.appUuid !== ctx.appUid) throw error('permission_denied', 403);
    return { uid: ctx.uid, appUid: ctx.appUid, prefix: '', holder: false };
  }
  if (!env.flags.shareHandles) throw error('kv_handles_disabled', 403);
  if (config.appUuid || config.disableSharing) throw error('kv_handle_option_invalid', 400, 'kv: `handle` cannot be combined with `appUuid` or `disableSharing`');
  if (method === 'flush') throw error('kv_handle_option_invalid', 400, 'kv: `flush` is not available through a share handle');
  if (typeof config.handle !== 'string') throw error('kv_handle_option_invalid', 400, 'kv: `handle` must be a string');
  const handle = env.liveHandle(config.handle, ctx.uid, ctx.appUid);
  if (!handle) throw handleNotFound();
  const needs = READS.has(method) ? 'read' : 'write';
  if (ctx.uid !== handle.uid && (handle.access === 'watch' || (needs === 'write' && handle.access !== 'write'))) throw error('kv_handle_access_denied', 403, 'kv: this share handle does not allow this call');
  return { ...handle, holder: ctx.uid !== handle.uid };
}

// Listings through a handle hand out cursors sealed to that handle, so one cannot be replayed through another.
const toBase64 = text => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromBase64 = text => new TextDecoder().decode(Uint8Array.from(atob(text), char => char.charCodeAt(0)));
const sealCursor = (handle, key, reverse) => `kvc.${toBase64(JSON.stringify({ s: handle, k: key, ...(reverse ? { r: true } : {}) }))}`;
function openCursor(handle, cursor, reverse) {
  try {
    const sealed = JSON.parse(fromBase64(cursor.slice(4)));
    if (cursor.startsWith('kvc.') && sealed.s === handle && typeof sealed.k === 'string' && Boolean(sealed.r) === Boolean(reverse)) return sealed.k;
  } catch { /* falls through */ }
  throw error('bad_request', 400, 'invalid kv: cursor');
}

export function createKv(env, ctx) {
  const scopeFor = (args, method) => resolveScope(env, ctx, args.optConfig, method);
  const relativeKey = (scope, key) => {
    if (scope.handle && (key == null || String(key) === '' || bytes(String(key)) > HANDLE_KEY_MAX)) throw error('kv_handle_key_invalid');
    return keyString(scope.prefix + keyString(key));
  };
  const readEntry = (scope, key) => {
    const entry = env.store(ctx.region, scope.uid, scope.appUid).get(key);
    return env.live(entry) ? entry : undefined;
  };
  const chargeRead = entries => env.charge(ctx, { kvReadUnits: entries.reduce((n, entry) => n + Math.max(1, Math.ceil(jsonBytes(entry?.value) / 4096)), 0) });
  const chargeWrite = (old, value, replace = false) => env.charge(ctx, { kvWriteUnits: Math.max(1, Math.ceil((replace ? jsonBytes(value) : Math.max(jsonBytes(old?.value), jsonBytes(value))) / 1024)) });
  // Private (`disableSharing`) entries are invisible through handles and cannot be overwritten through one.
  const privacy = (scope, old) => {
    if (scope.handle && env.live(old) && old.private) throw error('forbidden', 403, 'kv: this entry is private to the app that wrote it');
  };
  const save = (scope, key, value, args, old, expires = old?.expires ?? null, deleted = false) => {
    privacy(scope, old);
    validateValue(value);
    chargeWrite(old, value, args._replace === true);
    env.commit(ctx, scope, key, { value: clone(value), expires, private: args.optConfig?.disableSharing ?? old?.private ?? false, eventOp: args._eventOp, deleted });
  };
  const invoke = (method, args, operation) => env.call(ctx, `kv.${method}`, operation).catch(cause => { if (typeof args.error === 'function') args.error(cause); throw cause; });
  const oneArgs = (key, rest) => isObject(key) && !rest.length ? key : { key, ...optCallbacks(rest) };
  const setSingle = (args, scope) => {
    const key = relativeKey(scope, args.key);
    if (args.value === undefined) throw error('bad_request');
    const old = readEntry(scope, key);
    // A conditional put checks only this region's copy: two regions can both claim a key before replication.
    if (args.onlyIfAbsent && env.flags.onlyIfAbsent !== false && old) return false;
    privacy(scope, old);
    const expiry = args.expireAt;
    const expires = expiry == null || expiry === false || expiry === '' || expiry === 0 ? null : number(expiry) * 1000;
    save(scope, key, args.value, { ...args, _replace: true }, old, expires);
    return true;
  };
  const kv = {
    MAX_KEY_SIZE, MAX_VALUE_SIZE,
    async get(key, ...rest) {
      const args = oneArgs(key, rest);
      return invoke('get', args, () => {
        const scope = scopeFor(args, 'get');
        const keys = Array.isArray(args.key) ? args.key : [args.key];
        if (keys.length > 1000) throw error('bad_request');
        const entries = keys.map(key => readEntry(scope, relativeKey(scope, key))).map(entry => scope.handle && entry?.private ? undefined : entry);
        chargeRead(entries);
        const result = entries.map(entry => entry ? clone(entry.value) : null);
        return Array.isArray(args.key) ? result : result[0];
      });
    },
    async set(key, value, ...rest) {
      let args;
      if (Array.isArray(key)) args = { items: key, ...trailing([value, ...rest]) };
      else if (isObject(key) && value === undefined && !rest.length) args = key;
      else {
        let expireAt;
        if (rest[0] !== undefined && !isObject(rest[0]) && typeof rest[0] !== 'function') expireAt = rest.shift();
        args = { key, value, expireAt, ...trailing(rest) };
      }
      return invoke('set', args, () => {
        // Only `optConfig.onlyIfAbsent` counts; a top-level `onlyIfAbsent` in the object form is ignored.
        const conditional = args.optConfig?.onlyIfAbsent;
        if (conditional !== undefined && conditional !== null && typeof conditional !== 'boolean') throw error('bad_request', 400, 'kv: onlyIfAbsent must be a boolean');
        if (Array.isArray(args.items) && conditional) throw error('invalid_request', 400, 'kv: onlyIfAbsent is not available on a batch write');
        const scope = scopeFor(args, 'set');
        if (!Array.isArray(args.items)) return setSingle({ ...args, onlyIfAbsent: conditional === true }, scope);
        if (!args.items.length || args.items.length > 1000) throw error('items_required');
        // Validation precedes the non-transactional sequence of individual writes.
        for (const item of args.items) {
          if (!isObject(item) || !Object.hasOwn(item, 'key')) throw error('invalid_item');
          relativeKey(scope, String(item.key)); validateValue(item.value);
        }
        for (const item of args.items) setSingle({ key: String(item.key), value: item.value, expireAt: item.expireAt, optConfig: args.optConfig, onlyIfAbsent: false }, scope);
        return true;
      });
    },
    async del(key, ...rest) {
      const args = oneArgs(key, rest);
      return invoke('del', args, () => {
        const scope = scopeFor(args, 'del'); const absolute = relativeKey(scope, args.key);
        save(scope, absolute, null, args, readEntry(scope, absolute), null, true);
        return true;
      });
    },
    async update(key, map, ...rest) {
      let args;
      if (isObject(key) && map === undefined && !rest.length) args = key;
      else {
        let ttl;
        if (rest[0] !== undefined && !isObject(rest[0]) && typeof rest[0] !== 'function') ttl = rest.shift();
        args = { key, pathAndValueMap: map, ttl, ...trailing(rest) };
      }
      return mutate('update', args, args.pathAndValueMap);
    },
    async incr(key, amount, config) { const args = counterArgs(key, amount, config); return mutate('incr', args, args.pathAndAmountMap); },
    async decr(key, amount, config) { const args = counterArgs(key, amount, config); return mutate('decr', args, args.pathAndAmountMap); },
    async add(key, value, optConfig) {
      let args;
      if (isObject(key) && value === undefined && optConfig === undefined) args = key;
      else {
        if (key === undefined && value === undefined && optConfig === undefined) throw error('arguments_required');
        if (isObject(value) && Object.hasOwn(value, 'appUuid') && optConfig === undefined) { optConfig = shorthandConfig(value); value = undefined; }
        args = { key, pathAndValueMap: value === undefined ? { '': 1 } : isObject(value) ? value : { '': value }, optConfig };
      }
      return mutate('add', args, args.pathAndValueMap);
    },
    async remove(key, ...paths) {
      const optConfig = isObject(paths.at(-1)) ? paths.pop() : undefined;
      if (!paths.length) throw error('arguments_required');
      if (paths.some(path => typeof path !== 'string')) throw error('paths_invalid');
      const args = { key, optConfig };
      return invoke('remove', args, () => {
        const parsed = pathEntries(Object.fromEntries(paths.map(path => [path, null])));
        const scope = scopeFor(args, 'remove'); const absolute = relativeKey(scope, key); const old = readEntry(scope, absolute);
        privacy(scope, old);
        let value = clone(old?.value);
        if (value !== undefined) for (const [parts] of parsed) value = changePath(value, parts, () => undefined, true);
        save(scope, absolute, value ?? null, args, old, old?.expires, !parsed.every(([parts]) => parts.length));
        return value ?? null;
      });
    },
    async expire(key, ttl, optConfig) { return expiry('expire', key, number(ttl), optConfig); },
    async expireAt(key, timestamp, optConfig) { return expiry('expireAt', key, number(timestamp), optConfig); },
    list(patternOrOptions, returnValuesOrConfig, maybeConfig) {
      const input = patternOrOptions;
      const objectForm = isObject(input) && returnValuesOrConfig === undefined && maybeConfig === undefined;
      let opts = {};
      let paginated = false;
      if (objectForm) {
        if (input.reverse !== undefined && typeof input.reverse !== 'boolean') return listFailure(input.stream, error('invalid_request'));
        opts = { pattern: input.pattern, returnValues: !!input.returnValues, reverse: input.reverse, stream: input.stream === true };
        if (isObject(input.optConfig)) opts.optConfig = input.optConfig;
        else if (Object.hasOwn(input, 'appUuid')) opts.optConfig = shorthandConfig(input);
        for (const name of ['limit', 'cursor', 'offset', 'includeTotal', 'fetchUntilFull']) if (input[name] !== undefined) { opts[name] = input[name]; paginated = true; }
      } else {
        opts.pattern = typeof input === 'string' ? input : undefined;
        opts.returnValues = input === true || returnValuesOrConfig === true;
        if (isObject(returnValuesOrConfig)) opts.optConfig = returnValuesOrConfig;
        if (isObject(maybeConfig)) opts.optConfig = maybeConfig;
      }
      opts.pattern = typeof opts.pattern === 'string' ? opts.pattern.trim().replace(/\*$/, '') : '';
      if (opts.stream) {
        if (opts.offset !== undefined) return listFailure(true, error('invalid_request'));
        return (async function* () {
          let cursor = opts.cursor;
          do {
            const page = await pageList({ ...opts, limit: opts.limit ?? 1000, cursor });
            yield page;
            cursor = page.cursor;
          } while (cursor);
        })();
      }
      if (paginated) return pageList(opts);
      return (async () => {
        const items = []; let cursor;
        do { const page = await pageList({ ...opts, limit: 1000, cursor }); items.push(...page.items); cursor = page.cursor; } while (cursor);
        return items;
      })();
    },
    async flush(input, ...rest) {
      const args = isObject(input) && !rest.length ? Object.hasOwn(input, 'optConfig') || Object.hasOwn(input, 'success') || Object.hasOwn(input, 'error') ? input : { optConfig: input } : optCallbacks([input, ...rest]);
      return invoke('flush', args, () => {
        const scope = scopeFor(args, 'flush');
        for (const [key, entry] of env.store(ctx.region, scope.uid, scope.appUid)) if (env.live(entry)) save(scope, key, null, args, entry, null, true);
        return true;
      });
    },
    async share(prefix, recipient, access) {
      const args = isObject(prefix) ? prefix : { prefix, recipient, access };
      // The SDK refuses an address before the request.
      const named = typeof args.recipient === 'string' ? args.recipient : args.recipient?.username;
      if (typeof named === 'string' && named.includes('@')) throw error('invalid_recipient', 400, '`recipient` must be a username, not an email address');
      return invoke('share', args, () => mintHandle(env, ctx, args, 'read'));
    },
    async unshare(handle) {
      if (typeof handle !== 'string' || !handle.trim()) throw error('invalid_request', 400, '`handle` is required');
      return invoke('unshare', {}, () => removeShare(env, ctx, handle));
    },
    async listShared(options) {
      return invoke('listShared', {}, () => listHeld(env, ctx, options));
    },
    async listSharedByMe(options) {
      return invoke('listSharedByMe', {}, () => listGranted(env, ctx, options));
    },
  };
  kv.clear = kv.flush;
  function mutate(method, args, map) {
    return invoke(method, args, () => {
      const entries = pathEntries(map);
      if (['incr', 'decr'].includes(method) && entries.some(([, by]) => typeof by !== 'number' || !Number.isFinite(by))) throw error('bad_request');
      const scope = scopeFor(args, method); const key = relativeKey(scope, args.key); const old = readEntry(scope, key);
      privacy(scope, old);
      let value = clone(old?.value);
      for (const [parts, field] of entries) value = changePath(value, parts, current => {
        if (method === 'incr' || method === 'decr') {
          if (current !== undefined && typeof current !== 'number') throw error('value_not_a_number');
          return (current ?? 0) + field * (method === 'decr' ? -1 : 1);
        }
        if (method === 'add') {
          if (current !== undefined && !Array.isArray(current)) throw error('value_not_a_list');
          return [...(current ?? []), ...clone(Array.isArray(field) ? field : [field])];
        }
        return clone(field);
      });
      let expires = old?.expires ?? null;
      if (method === 'update' && args.ttl !== undefined && args.ttl !== '' && args.ttl !== false) expires = args.ttl === null ? null : env.now() + number(args.ttl, 'ttl_invalid') * 1000;
      save(scope, key, value, args, old, expires);
      return clone(value);
    });
  }
  function expiry(method, key, seconds, optConfig) {
    const args = { key, optConfig, _eventOp: 'expire' };
    return invoke(method, args, () => {
      const scope = scopeFor(args, method); const absolute = relativeKey(scope, key); const old = readEntry(scope, absolute);
      save(scope, absolute, old?.value ?? null, args, old, method === 'expire' ? env.now() + seconds * 1000 : seconds * 1000);
      return true;
    });
  }
  function pageList(opts) {
    return invoke('list', opts, () => {
      const scope = scopeFor(opts, 'list');
      if (scope.handle && bytes(opts.pattern ?? '') > HANDLE_KEY_MAX) throw error('kv_handle_key_invalid', 400, `kv: a pattern used with a share handle may be at most ${HANDLE_KEY_MAX} bytes`);
      const limit = opts.limit === undefined ? 1000 : Math.min(1000, number(opts.limit));
      if (!Number.isInteger(limit) || limit < 1) throw error('invalid_request');
      if (opts.offset !== undefined && (!Number.isInteger(opts.offset) || opts.offset < 0)) throw error('invalid_request');
      let pairs = [...env.store(ctx.region, scope.uid, scope.appUid)].filter(([key, entry]) => key.startsWith(scope.prefix + (opts.pattern ?? '')) && env.live(entry) && !(scope.handle && entry.private)).map(([key, entry]) => [key.slice(scope.prefix.length), entry]);
      pairs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      if (opts.reverse) pairs.reverse();
      const total = pairs.length;
      if (opts.cursor != null && opts.cursor !== '') {
        if (typeof opts.cursor !== 'string') throw error('invalid_request');
        const after = scope.handle ? openCursor(scope.handle, opts.cursor, opts.reverse) : opts.cursor;
        pairs = pairs.filter(([key]) => opts.reverse ? key < after : key > after);
      }
      if (opts.offset) pairs = pairs.slice(opts.offset);
      const selected = pairs.slice(0, limit);
      chargeRead(selected.length ? selected.map(([, e]) => e) : [undefined]);
      return { items: selected.map(([key, entry]) => opts.returnValues ? { key, value: clone(entry.value) } : key), cursor: pairs.length > limit ? (scope.handle ? sealCursor(scope.handle, selected.at(-1)[0], opts.reverse) : selected.at(-1)[0]) : null, ...(opts.includeTotal ? { total } : {}) };
    });
  }
  function listFailure(stream, cause) { return stream ? (async function* () { throw cause; })() : Promise.reject(cause); }
  return kv;
}
