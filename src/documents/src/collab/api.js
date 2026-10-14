/**
 * Requests to a room worker, and deployment of the owner's worker. Follows
 * the Whiteboard and Photo Studio apps in this repository.
 *
 * The development server (dev/collab-dev-server.mjs, used by /mock.html and
 * the browser tests) runs the same room service in-process at /__collab; its
 * requests carry the mock user instead of a signed credential.
 */
import { workerURL } from './protocol.js';
import { authorize, refuseCredential } from './auth.js';

export const WORKER_KEY = 'documents-collab-worker-v1';
export const WORKER_BUNDLE = 'worker/documents-worker.js';

export class CollabError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
  get network() { return this.status === 0; }
}

const isDevServer = server => /^https?:\/\/(127\.0\.0\.1|localhost|[a-z0-9.-]+\.localhost)(:\d+)?\/__collab/.test(server);

export async function call(puter, server, input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.op === 'create' || input.op === 'base' ? 120_000 : 30_000);
  try {
    server = workerURL(server);
    const body = JSON.stringify(input);
    let res;
    if (isDevServer(server)) {
      const user = await puter.auth.getUser();
      try { res = await fetch(`${server}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-collab-dev-user': JSON.stringify({ uuid: user.uuid, username: user.username }) }, body, signal: controller.signal }); }
      catch { throw new CollabError('Could not reach the shared document. Check your connection; changes are kept and sent when it returns.'); }
    } else {
      let headers = await authorize(puter, server, body);
      const send = async () => {
        try { return await puter.workers.exec(`${server}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal: controller.signal, redirect: 'error' }); }
        catch { throw new CollabError('Could not reach the shared document. Check your connection; changes are kept and sent when it returns.'); }
      };
      res = await send();
      if (res.status === 401 && refuseCredential(puter, headers)) { headers = await authorize(puter, server, body); res = await send(); }
    }
    const data = await res.json().catch(() => null);
    if (res.ok && !data) throw new CollabError('The shared document did not answer. Try again shortly.');
    if (!res.ok) throw new CollabError(data?.message || 'Could not synchronize this document.', res.status || 500);
    return data;
  } finally { clearTimeout(timer); }
}

/**
 * Deploy (or update) this account's room worker and return its address. Only
 * a worker this account created and recorded in its private KV is updated; an
 * invitation link never triggers a deployment. The mock SDK names the dev server.
 */
export async function deploy(puter, progress = () => {}, fetchBundle = defaultBundle) {
  if (puter.collabDevServer) return puter.collabDevServer;
  const account = puter.authToken;
  const check = () => { if (puter.authToken !== account) throw new Error('Your Puter account changed. Try again.'); };
  let config = await puter.kv.get(WORKER_KEY);
  check();
  progress('Preparing the collaboration server…');
  const source = await fetchBundle();
  const build = /documents-worker build=([a-f0-9]+)/.exec(source)?.[1];
  if (!build) throw new Error('The collaboration server bundle is invalid.');
  check();
  if (!config) {
    const name = `documents-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const file = await puter.fs.write('documents-collab/documents-worker.js', source, { overwrite: true, dedupeName: false, createMissingParents: true });
    check();
    const deployed = await puter.workers.create(name, file.path);
    check();
    config = { name, server: workerURL(deployed.url || `https://${name}.puter.work`), path: file.path, build };
    await puter.kv.set(WORKER_KEY, config);
  } else if (config.build !== build) {
    await puter.fs.write(config.path, source, { overwrite: true, dedupeName: false });
    check();
    config = { ...config, build };
    await puter.kv.set(WORKER_KEY, config);
  }
  progress('Starting the collaboration server…');
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await puter.workers.exec(`${workerURL(config.server)}/health`, { headers: { 'x-puter-no-auth': '1' }, redirect: 'error' });
      if (res.ok && (await res.json()).build === config.build) return workerURL(config.server);
    } catch { /* still starting */ }
    check();
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('The collaboration server is still starting. Try again shortly.');
}
async function defaultBundle() {
  const res = await fetch(new URL(WORKER_BUNDLE, document.baseURI), { cache: 'no-cache' });
  if (!res.ok) throw new Error('The collaboration server bundle could not load.');
  return res.text();
}
