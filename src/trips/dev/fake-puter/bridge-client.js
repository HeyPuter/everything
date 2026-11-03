import { createBridgeCodec } from './bridge-codec.js';
const abortError = () => new DOMException('Aborted', 'AbortError');
const localError = (code, status = 400) => Object.assign(new Error(code), { code, status, statusCode: status });

/** The supplied transport is fixture-owned; account metadata comes only from it. */
export function createRemoteFakePuter({ request, documentId = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join(''), maxBytes, isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
  if (typeof request !== 'function') throw new TypeError('A bridge transport is required');
  const codec = createBridgeCodec({ maxBytes });
  const callbacks = new Map(); let sequence = 0; let stopped = false;
  // Calls made right after the browser's online event wait until the bridge has reconnected.
  let connecting = Promise.resolve();
  let metadata = { revision: -1, signedIn: false, authToken: null, user: null, env: 'web', appID: null, APIOrigin: null };
  const update = value => { if (value && Number.isInteger(value.revision) && value.revision >= metadata.revision) metadata = structuredClone(value); };
  const rpc = (method, args = [], { signal, control = false } = {}) => {
    if (signal?.aborted) return Promise.reject(abortError());
    if (stopped) return Promise.reject(localError('bridge_closed', 410));
    if (!control && !isOnline()) return Promise.reject(localError('offline', 0));
    const operation = (async () => {
      if (!control) await connecting;
      const encoded = await codec.encode(args, signal);
      if (signal?.aborted) throw abortError();
      const reply = await request({ version: 1, documentId, requestId: 'request-' + ++sequence, method, args: encoded });
      update(reply.metadata);
      if (!reply.ok) throw Object.assign(new Error(reply.error.message), { ...reply.error, statusCode: reply.error.status });
      return codec.decode(reply.value);
    })();
    if (!signal) return operation;
    return new Promise((resolve, reject) => {
      const cancel = () => reject(abortError()); signal.addEventListener('abort', cancel, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      if (signal.aborted) cancel();
    });
  };
  const client = { auth: { isSignedIn: () => metadata.signedIn, getUser: () => rpc('auth.getUser'), async signIn() { return rpc('auth.signIn', [], { control: true }); }, async signOut() { callbacks.clear(); await rpc('auth.signOut', [], { control: true }); } }, kv: {}, fs: {} };
  for (const name of ['get', 'set', 'del', 'update', 'incr', 'decr', 'add', 'remove', 'expire', 'expireAt', 'flush', 'clear', 'share', 'unshare', 'listShared', 'listSharedByMe']) client.kv[name] = (...args) => rpc('kv.' + name, args);
  client.kv.list = (...args) => {
    const input = args[0];
    if (input && typeof input === 'object' && input.stream === true && args.length === 1) {
      return (async function* () {
        if (input.offset !== undefined) throw localError('invalid_request');
        const options = { ...input, stream: false, limit: input.limit ?? 1000 }; let cursor = input.cursor;
        do { const page = await rpc('kv.list', [{ ...options, cursor }]); yield page; cursor = page.cursor; } while (cursor);
      })();
    }
    return rpc('kv.list', args);
  };
  for (const name of ['stat', 'read', 'write', 'mkdir', 'readdir', 'delete', 'move', 'rename', 'share', 'unshare', 'listShared', 'getReadURL', 'revokeReadURL', 'sign']) client.fs[name] = (...args) => rpc('fs.' + name, args);
  client.perms = { request: (...args) => rpc('perms.request', args) };
  client.workers = {
    create: (...args) => rpc('workers.create', args),
    list: (...args) => rpc('workers.list', args),
    get: (...args) => rpc('workers.get', args),
    delete: (...args) => rpc('workers.delete', args),
    exec(input, init = {}) {
      const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal?.aborted) return Promise.reject(abortError());
      // The Node-side client attaches its bound session, never browser metadata.
      const request = new Request(input, init);
      return rpc('workers.exec', [request], { signal });
    },
  };
  const unsubscribe = async id => {
    const subId = typeof id === 'string' ? id : id.subId;
    for (const [callbackId, callback] of callbacks) if (callback.subId === subId) callbacks.delete(callbackId);
    return rpc('events.unsubscribe', [subId], { control: true });
  };
  client.events = {
    async onLocal(subject, handler, options = {}) {
      if (typeof handler !== 'function') throw localError('invalid_request');
      const callbackId = 'callback-' + ++sequence;
      const callback = { handler, onError: options.onError, subId: null }; callbacks.set(callbackId, callback);
      try {
        const subscription = await rpc('events.onLocal', [subject, { includeValue: options.includeValue === true }, callbackId]);
        callback.subId = subscription.subId;
        let removed = false;
        const off = async () => { if (removed) return; removed = true; callbacks.delete(callbackId); try { await unsubscribe(subscription.subId); } catch (cause) { if (!['bridge_subscription_not_found', 'bridge_closed'].includes(cause.code)) throw cause; } };
        return { ...subscription, off, unsubscribe: off };
      } catch (cause) { callbacks.delete(callbackId); throw cause; }
    },
    unsubscribe,
  };
  for (const key of ['env', 'appID', 'APIOrigin', 'authToken']) Object.defineProperty(client, key, { enumerable: true, get: () => metadata[key] });
  client.getUser = client.auth.getUser;
  client.ready = rpc('bridge.hello', [], { control: true }).then(() => rpc('bridge.connection', [isOnline()], { control: true })).then(() => client);
  return {
    client,
    receive(message) {
      if (stopped || message.documentId !== documentId) return;
      if (message.type === 'auth') { update(message.metadata); if (!metadata.signedIn) callbacks.clear(); return; }
      if (message.type !== 'event' || !isOnline()) return;
      const callback = callbacks.get(message.callbackId); if (!callback) return;
      Promise.resolve().then(() => callback.handler(codec.decode(message.value))).catch(cause => { try { callback.onError?.(cause); } catch { /* Isolate consumer errors. */ } });
    },
    connection(online) { const call = rpc('bridge.connection', [online], { control: true }); connecting = call.catch(() => {}); return call; },
    stop() { stopped = true; callbacks.clear(); },
  };
}
