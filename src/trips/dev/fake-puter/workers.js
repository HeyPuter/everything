import { error } from './shared.js';

export function createRouter() {
  const routes = [];
  const on = method => (path, handler) => { routes.push({ method, path, handler }); };
  const router = { routes, custom: method => on(method.toUpperCase()) };
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']) router[method] = on(method.toUpperCase());
  router.find = (method, pathname) => {
    for (const route of routes) {
      if (route.method !== method) continue;
      const pattern = route.path.split('/').filter(Boolean);
      const actual = pathname.split('/').filter(Boolean);
      const params = {};
      let matched = true;
      for (let i = 0; i < pattern.length; i++) {
        const part = pattern[i];
        if (part.startsWith('*')) { params[part.slice(1)] = actual.slice(i).join('/'); break; }
        if (actual[i] === undefined) { matched = false; break; }
        if (part.startsWith(':')) params[part.slice(1)] = actual[i];
        else if (part !== actual[i]) { matched = false; break; }
      }
      if (matched && (pattern.at(-1)?.startsWith('*') || actual.length === pattern.length)) return { handler: route.handler, params };
    }
    return null;
  };
  return router;
}
const response = value => {
  if (value instanceof Response) return value;
  if (value == null) return new Response(null, { status: 204 });
  if (typeof value === 'string' || value instanceof Blob || value instanceof Uint8Array || value instanceof ReadableStream) return new Response(value);
  return Response.json(value);
};
export async function registerWorker(env, name, config) {
  const origin = name.startsWith('https://') ? new URL(name).origin : `https://${name}.puter.work`;
  const owner = env.user(config.owner ?? 'alice');
  const region = config.region ?? 0;
  const me = { puter: env.client(owner, region, { appUid: config.appUid, worker: true }) };
  const router = createRouter();
  if (config.source !== undefined) {
    if (typeof config.source !== 'string') throw new TypeError('Worker source must be a trusted IIFE bundle string');
    // Lexical bindings keep each bundle's handler closures attached to its owner.
    const execute = new Function('router', 'me', `"use strict";\n${config.source}`);
    execute(router, me);
  } else if (config.setup) await config.setup({ router, me });
  if (config.source === undefined && !config.setup && !config.fetch) throw new TypeError('registerWorker requires source, setup or fetch');
  const worker = { origin, owner: owner.uuid, region, appUid: config.appUid ?? me.puter.appID, router, me, fetch: config.fetch, file: config.file };
  env.workers.set(`${origin}:${region}`, worker);
  return { url: origin, router, me, unregister: () => env.workers.delete(`${origin}:${region}`) };
}
const readText = blob => typeof blob.text === 'function' ? blob.text() : new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});
// Deployed workers run their AppData source file: overwriting it redeploys, deleting it destroys the worker.
async function deployedWorker(env, worker) {
  if (!worker?.file) return worker;
  const node = env.files.get(worker.file.uid);
  if (!node) { env.workers.delete(`${worker.origin}:${worker.region}`); env.deployments.delete(worker.file.name); return undefined; }
  if (node.data === worker.file.data) return worker;
  const name = worker.file.name;
  await registerWorker(env, name, { owner: worker.owner, region: worker.region, appUid: worker.appUid, source: await readText(node.data), file: { name, uid: node.uid, data: node.data } });
  return env.workers.get(`${worker.origin}:${worker.region}`);
}
export function createWorkerApi(env, ctx, client) {
  env.deployments ??= new Map();
  const view = ({ name, url, file_path, file_uid, created_at }) => ({ name, url, file_path, file_uid, created_at });
  const owned = name => { const item = env.deployments.get(name); return item && item.owner === ctx.uid && item.appUid === ctx.appUid ? item : undefined; };
  // Deleting a source file destroys its worker and frees the name.
  const guard = () => {
    if (ctx.restricted || ctx.worker || !ctx.uid) throw error('permission_denied', 403);
    for (const [name, item] of env.deployments) {
      if (env.files.has(item.file_uid)) continue;
      env.deployments.delete(name);
      for (const [key, worker] of env.workers) if (worker.file?.name === name) env.workers.delete(key);
    }
  };
  return {
    /** Names are global; the source must be a trusted IIFE bundle in the caller's AppData. */
    async create(name, path) {
      return env.call(ctx, 'workers.create', async () => {
        guard();
        if (!env.users.get(ctx.uid)?.email_confirmed) throw error('email_not_confirmed', 403);
        if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw error('invalid_worker_name');
        const origin = `https://${name}.puter.work`;
        if (env.deployments.has(name) || [...env.workers.values()].some(w => w.origin === origin)) throw error('worker_name_taken', 409);
        const node = env.fsNode(ctx, path);
        if (!node || node.is_dir) throw error('subject_does_not_exist', 404);
        if (!env.fsPermission(ctx, node, 'read') || node.owner !== ctx.uid) throw error('permission_denied', 403);
        // A deployed worker runs in every region, each with that region's KV.
        const source = await readText(node.data);
        for (let region = 0; region < env.stores.length; region++) {
          await registerWorker(env, name, { owner: ctx.uid, region, appUid: ctx.appUid, source, file: { name, uid: node.uid, data: node.data } });
        }
        env.deployments.set(name, { name, url: origin, file_path: node.path, file_uid: node.uid, created_at: env.now(), owner: ctx.uid, appUid: ctx.appUid });
        return { success: true, url: origin, errors: [] };
      });
    },
    async list() { return env.call(ctx, 'workers.list', () => { guard(); return [...env.deployments.keys()].map(owned).filter(Boolean).map(view); }); },
    async get(name) { return env.call(ctx, 'workers.get', () => { guard(); const item = owned(name); return item ? view(item) : null; }); },
    async delete(name) {
      return env.call(ctx, 'workers.delete', () => {
        guard();
        if (!owned(name)) throw error('worker_not_found', 404);
        env.deployments.delete(name);
        for (const [key, worker] of env.workers) if (worker.file?.name === name) env.workers.delete(key);
        return true;
      });
    },
    async exec(input, init = {}) {
      return env.call(ctx, 'workers.exec', async () => {
        const request = new Request(input, init);
        if (!request.headers.get('puter-auth') && !request.headers.get('x-puter-no-auth') && client.authToken) request.headers.set('puter-auth', client.authToken);
        request.headers.delete('x-puter-no-auth');
        const origin = new URL(request.url).origin;
        const worker = await deployedWorker(env, env.workers.get(`${origin}:${ctx.region}`) ?? [...env.workers.values()].find(w => w.origin === origin));
        if (!worker) throw error('worker_not_found', 404);
        const token = request.headers.get('puter-auth');
        const session = env.tokens.get(token);
        const scoped = env.readTokens.get(token);
        let puter;
        if (session) puter = env.client(env.users.get(session.uid), worker.region, { appUid: session.appUid, token });
        else if (scoped) puter = env.client(env.users.get(scoped.ctx.uid), worker.region, { appUid: scoped.ctx.appUid, token, restricted: token });
        else if (token) puter = env.client(null, worker.region, { token });
        const user = puter ? { puter } : undefined;
        const waitUntil = promise => {
          const task = Promise.resolve(promise);
          env.pendingWork.add(task);
          task.catch(() => {}).finally(() => env.pendingWork.delete(task));
        };
        const event = { request, user, waitUntil };
        try {
          if (worker.fetch) return response(await worker.fetch(request, { me: worker.me, user, waitUntil }));
          const found = worker.router.find(request.method, new URL(request.url).pathname);
          if (!found) return new Response('Not Found', { status: 404 });
          return response(await found.handler({ ...event, params: found.params, event }));
        } catch (cause) {
          return new Response(String(cause?.message ?? cause), { status: 500 });
        }
      });
    },
  };
}
