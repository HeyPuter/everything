import { createBridgeCodec } from './bridge-codec.js';

const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
const calls = Object.freeze({
  'auth.getUser': (client, args) => client.auth.getUser(...args),
  'kv.get': (client, args) => client.kv.get(...args),
  'kv.set': (client, args) => client.kv.set(...args),
  'kv.del': (client, args) => client.kv.del(...args),
  'kv.update': (client, args) => client.kv.update(...args),
  'kv.incr': (client, args) => client.kv.incr(...args),
  'kv.decr': (client, args) => client.kv.decr(...args),
  'kv.add': (client, args) => client.kv.add(...args),
  'kv.remove': (client, args) => client.kv.remove(...args),
  'kv.expire': (client, args) => client.kv.expire(...args),
  'kv.expireAt': (client, args) => client.kv.expireAt(...args),
  'kv.list': (client, args) => { if (args[0]?.stream) throw failure('bridge_stream_requires_paging'); return client.kv.list(...args); },
  'kv.flush': (client, args) => client.kv.flush(...args),
  'kv.clear': (client, args) => client.kv.clear(...args),
  'kv.share': (client, args) => client.kv.share(...args),
  'kv.unshare': (client, args) => client.kv.unshare(...args),
  'kv.listShared': (client, args) => client.kv.listShared(...args),
  'kv.listSharedByMe': (client, args) => client.kv.listSharedByMe(...args),
  'perms.request': (client, args) => client.perms.request(...args),
  'fs.stat': (client, args) => client.fs.stat(...args),
  'fs.read': (client, args) => client.fs.read(...args),
  'fs.write': (client, args) => client.fs.write(...args),
  'fs.mkdir': (client, args) => client.fs.mkdir(...args),
  'fs.readdir': (client, args) => client.fs.readdir(...args),
  'fs.delete': (client, args) => client.fs.delete(...args),
  'fs.move': (client, args) => client.fs.move(...args),
  'fs.rename': (client, args) => client.fs.rename(...args),
  'fs.share': (client, args) => client.fs.share(...args),
  'fs.unshare': (client, args) => client.fs.unshare(...args),
  'fs.listShared': (client, args) => client.fs.listShared(...args),
  'fs.getReadURL': (client, args) => client.fs.getReadURL(...args),
  'fs.revokeReadURL': (client, args) => client.fs.revokeReadURL(...args),
  'fs.sign': (client, args) => client.fs.sign(...args),
  'workers.create': (client, args) => client.workers.create(...args),
  'workers.list': (client, args) => client.workers.list(...args),
  'workers.get': (client, args) => client.workers.get(...args),
  'workers.delete': (client, args) => client.workers.delete(...args),
});
const controls = new Set(['bridge.hello', 'bridge.connection', 'auth.signIn', 'auth.signOut', 'events.onLocal', 'events.unsubscribe', 'workers.exec']);
const offlineControls = new Set(['bridge.hello', 'bridge.connection', 'auth.signIn', 'auth.signOut', 'events.unsubscribe']);
export const BRIDGE_METHODS = Object.freeze([...Object.keys(calls), ...controls]);

/** Only fixture code can choose an account or manipulate the shared world. */
export function createTestBridgeHost(world, options = {}) {
  const codec = createBridgeCodec(options);
  const credentialsByUser = new Map();
  const contexts = new Set(); const deliveries = new Set();
  let nextConnection = 0; let running = 0; let delivered = 0; let dropped = 0;
  const snapshot = () => ({ contexts: contexts.size, pages: [...contexts].reduce((n, context) => n + context.connections.size, 0), subscriptions: [...contexts].reduce((n, context) => n + [...context.connections].reduce((m, connection) => m + connection.subscriptions.size, 0), 0), offlinePages: [...contexts].reduce((n, context) => n + [...context.connections].filter(connection => !connection.online).length, 0), inFlight: running, delivered, dropped });
  const publish = (connection, message, documentId = connection.documentId) => {
    if (connection.closed || !connection.online || connection.documentId !== documentId) { dropped++; return; }
    const task = Promise.resolve().then(() => connection.deliver({ ...message, documentId })).then(() => { delivered++; }).catch(() => { dropped++; });
    deliveries.add(task); task.finally(() => deliveries.delete(task));
    return task;
  };
  const closeSubscriptions = async connection => {
    const subscriptions = [...connection.subscriptions.values()]; connection.subscriptions.clear();
    await Promise.allSettled(subscriptions.map(subscription => subscription.native.off()));
  };
  /** `as: null` is a signed-out visitor with no account; signing in leaves it signed out. */
  function openContext({ as, region = 0, appUid } = {}) {
    if (as === undefined) throw new TypeError('A fixture account (or null for a signed-out visitor) is required');
    const identity = as === null ? null : world.user(as);
    if (identity && !credentialsByUser.has(identity.uuid)) credentialsByUser.set(identity.uuid, new Set());
    const context = { identity, region, appUid, connections: new Set(), client: world.client(identity, region, { appUid }), revision: 0, credentials: identity ? credentialsByUser.get(identity.uuid) : new Set(), closed: false };
    contexts.add(context);
    const metadata = () => ({ revision: context.revision, env: context.client.env, appID: context.client.appID, APIOrigin: context.client.APIOrigin, signedIn: context.client.auth.isSignedIn(), authToken: context.client.authToken, user: context.client.auth.isSignedIn() ? { ...identity, app_name: context.client.appID } : null });
    const authChanged = () => { context.revision++; for (const connection of context.connections) publish(connection, { type: 'auth', metadata: metadata() }); };
    const bound = {
      connect(deliver) {
        if (context.closed || typeof deliver !== 'function') throw failure('bridge_closed', 410);
        const connection = { id: ++nextConnection, deliver, documentId: null, online: true, closed: false, subscriptions: new Map(), requests: new Set(), eventsClient: world.client(context.client.auth.isSignedIn() ? identity : null, region, { appUid }) };
        context.connections.add(connection);
        const endpoint = {
          id: connection.id,
          async navigate() { connection.documentId = null; await closeSubscriptions(connection); },
          async close() { connection.closed = true; await closeSubscriptions(connection); context.connections.delete(connection); },
          async request(envelope) {
            running++;
            let requestKey; let registered = false;
            try {
              if (context.closed || connection.closed) throw failure('bridge_closed', 410);
              if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).some(key => !['version', 'documentId', 'requestId', 'method', 'args'].includes(key)) || envelope.version !== 1 || !/^[a-zA-Z0-9-]{1,80}$/.test(envelope.documentId ?? '') || !/^[a-zA-Z0-9-]{1,80}$/.test(envelope.requestId ?? '') || typeof envelope.method !== 'string') throw failure('bridge_invalid_request');
              if (!Object.hasOwn(calls, envelope.method) && !controls.has(envelope.method)) throw failure('bridge_method_denied', 403);
              if (JSON.stringify(envelope).length > (options.maxBytes ?? 8 * 1024 * 1024) * 3) throw failure('bridge_invalid_value');
              const args = codec.decode(envelope.args);
              if (!Array.isArray(args) || args.length > 12) throw failure('bridge_invalid_request');
              requestKey = envelope.documentId + ':' + envelope.requestId;
              if (connection.requests.has(requestKey)) throw failure('bridge_duplicate_request', 409);
              connection.requests.add(requestKey); registered = true;
              if (envelope.method === 'bridge.hello') {
                if (args.length) throw failure('bridge_invalid_request');
                if (connection.documentId !== envelope.documentId) { connection.documentId = envelope.documentId; await closeSubscriptions(connection); }
                return { ok: true, metadata: metadata(), value: await codec.encode(null) };
              }
              if (connection.documentId !== envelope.documentId) throw failure('bridge_stale_document', 409);
              if (!connection.online && !offlineControls.has(envelope.method)) throw failure('offline', 0);
              const client = context.client;
              let value;
              if (envelope.method === 'bridge.connection') {
                if (args.length !== 1 || typeof args[0] !== 'boolean') throw failure('bridge_invalid_request');
                const reconnect = !connection.online && args[0]; connection.online = args[0];
                if (reconnect) {
                  publish(connection, { type: 'auth', metadata: metadata() });
                  for (const subscription of connection.subscriptions.values()) publish(connection, { type: 'event', callbackId: subscription.callbackId, value: await codec.encode({ event: { id: 'bridge-reconnect', subject: subscription.subject, op: 'gap', reason: 'reconnect', ts: Date.now() } }) });
                }
                value = null;
              } else if (envelope.method === 'auth.signOut' || envelope.method === 'auth.signIn') {
                if (args.length) throw failure('bridge_invalid_request');
                for (const page of context.connections) await closeSubscriptions(page);
                context.client = world.client(envelope.method === 'auth.signOut' ? null : identity, region, { appUid });
                for (const page of context.connections) page.eventsClient = world.client(context.client.auth.isSignedIn() ? identity : null, region, { appUid });
                authChanged(); value = metadata().user;
              } else if (envelope.method === 'events.onLocal') {
                const [subject, eventOptions, callbackId] = args;
                if (args.length !== 3 || typeof subject !== 'string' || subject.length > 2048 || !eventOptions || typeof eventOptions !== 'object' || Array.isArray(eventOptions) || Object.keys(eventOptions).some(key => key !== 'includeValue') || !/^[a-zA-Z0-9-]{1,80}$/.test(callbackId)) throw failure('bridge_invalid_request');
                if ([...connection.subscriptions.values()].some(subscription => subscription.callbackId === callbackId)) throw failure('bridge_duplicate_subscription', 409);
                const documentId = connection.documentId;
                const native = await connection.eventsClient.events.onLocal(subject, async event => {
                  const value = await codec.encode(event);
                  return publish(connection, { type: 'event', callbackId, value }, documentId);
                }, { includeValue: eventOptions.includeValue === true });
                if (connection.closed || connection.documentId !== documentId || context.client !== client) { await native.off(); throw failure('bridge_stale_document', 409); }
                connection.subscriptions.set(native.subId, { native, subject, callbackId });
                value = { subject, subId: native.subId, anchor: native.anchor, includeValue: native.includeValue };
              } else if (envelope.method === 'events.unsubscribe') {
                if (args.length !== 1 || typeof args[0] !== 'string') throw failure('bridge_invalid_request');
                const subscription = connection.subscriptions.get(args[0]);
                if (!subscription) throw failure('bridge_subscription_not_found', 404);
                await connection.eventsClient.events.unsubscribe(args[0]); connection.subscriptions.delete(args[0]); value = null;
              } else if (envelope.method === 'workers.exec') {
                if (args.length !== 1 || !(args[0] instanceof Request)) throw failure('bridge_invalid_request');
                const token = args[0].headers.get('puter-auth');
                if (token && token !== client.authToken && !context.credentials.has(token)) throw failure('bridge_credential_scope', 403);
                value = await client.workers.exec(args[0]);
              } else {
                value = await calls[envelope.method](client, args);
                if (envelope.method === 'fs.getReadURL') context.credentials.add(new URL(value).searchParams.get('token'));
              }
              return { ok: true, metadata: metadata(), value: await codec.encode(value) };
            } catch (cause) {
              return { ok: false, metadata: metadata(), error: { code: typeof cause.code === 'string' ? cause.code : 'bridge_call_failed', message: String(cause.message ?? 'Bridge call failed').slice(0, 500), status: Number.isInteger(cause.status) ? cause.status : 400 } };
            } finally { if (registered) connection.requests.delete(requestKey); running--; }
          },
        };
        return endpoint;
      },
      async close() {
        if (context.closed) return;
        context.closed = true;
        for (const connection of context.connections) { connection.closed = true; await closeSubscriptions(connection); }
        context.connections.clear(); contexts.delete(context);
      },
    };
    return bound;
  }
  return { openContext, stats: snapshot, async flush() { await world.flushEvents(); while (deliveries.size) await Promise.allSettled([...deliveries]); }, async close() { for (const context of [...contexts]) { context.closed = true; for (const connection of context.connections) { connection.closed = true; await closeSubscriptions(connection); } context.connections.clear(); contexts.delete(context); } } };
}
