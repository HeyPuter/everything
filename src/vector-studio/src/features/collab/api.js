/**
 * Talking to a collaboration server: signed requests (see auth.js) and,
 * for the owner, deploying the server as a Puter worker in their own
 * account. The worker bundle ships with the app (npm run build:worker);
 * an account's deployment is recorded in its private app storage and
 * updated when the bundled build changes. A share link never causes a
 * deployment: only this account's own recorded worker is created or updated.
 */
import { workerURL } from './protocol.js';
import { authorize, refuseCredential } from './auth.js';
import { classifyError } from '../files/errors.js';

const WORKER_KEY = 'vector-studio-collab-worker-v1';
const BUNDLE = 'worker/vector-studio-worker.js';

export class CollabError extends Error {
  constructor(message, { status = 0, offline = false } = {}) {
    super(message);
    this.name = 'CollabError';
    this.status = status;
    this.offline = offline;
    // Shown as a notification by commands without logging it as a bug.
    this.expected = true;
  }
}

/** POST one operation to a server's /api and return its JSON reply. */
export async function call(puter, server, input, { timeout = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    server = workerURL(server);
    const body = JSON.stringify(input);
    const unreachable = () => new CollabError('Could not reach the shared document. Check your connection.', { offline: true });
    // Loading the credential talks to Puter too: a dropped connection there is being offline.
    const credential = () =>
      authorize(puter, server, body).catch((err) => {
        throw classifyError(err).kind === 'offline' ? unreachable() : err;
      });
    let headers = await credential();
    const send = async () => {
      try {
        return await puter.workers.exec(`${server}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal: controller.signal, redirect: 'error' });
      } catch {
        throw unreachable();
      }
    };
    let res = await send();
    if (res.status === 401 && refuseCredential(puter, headers)) {
      headers = await credential();
      res = await send();
    }
    const reply = await res.json().catch(() => null);
    if (res.ok && !reply) throw unreachable();
    if (!res.ok) throw new CollabError(reply?.message || 'The shared document could not be reached.', { status: res.status, offline: res.status >= 500 && res.status !== 501 });
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

/** This account's collaboration server, deploying or updating it as needed. */
export async function deploy(puter, progress = () => {}) {
  if (!puter?.workers?.create || !puter.fs?.write || !puter.kv) throw new CollabError('Sharing needs the Puter workers service, which is not available here.');
  const account = puter.authToken;
  const sameAccount = () => {
    if (puter.authToken !== account) throw new CollabError('Your Puter account changed. Try sharing again.');
  };
  let config = await puter.kv.get(WORKER_KEY);
  sameAccount();
  progress('Preparing the collaboration server...');
  const res = await fetch(new URL(BUNDLE, document.baseURI), { cache: 'no-cache' });
  if (!res.ok) throw new CollabError('The collaboration server could not be loaded. Reload the app and try again.');
  const source = await res.text();
  const build = /vector-studio-worker build=([a-f0-9]+)/.exec(source.slice(0, 200))?.[1];
  const builtAt = Number(/ at=(\d+)/.exec(source.slice(0, 200))?.[1]) || 0;
  if (!build) throw new CollabError('The collaboration server bundle is not valid.');
  if (!config) {
    const name = `vector-studio-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const file = await puter.fs.write('collab/vector-studio-worker.js', source, { overwrite: true, dedupeName: false, createMissingParents: true });
    sameAccount();
    const deployed = await puter.workers.create(name, file.path);
    sameAccount();
    config = { name, server: workerURL(deployed?.url || `https://${name}.puter.work`), path: file.path, build, builtAt };
    await puter.kv.set(WORKER_KEY, config);
  } else if (config.build !== build && !(config.builtAt > builtAt)) {
    await puter.fs.write(config.path, source, { overwrite: true, dedupeName: false });
    sameAccount();
    config = { ...config, build, builtAt };
    await puter.kv.set(WORKER_KEY, config);
  }
  progress('Starting the collaboration server...');
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const r = await puter.workers.exec(`${workerURL(config.server)}/health`, { headers: { 'x-puter-no-auth': '1' }, redirect: 'error' });
      if (r.ok && (await r.json()).build === config.build) return config.server;
    } catch {
      // Still starting.
    }
    sameAccount();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new CollabError('The collaboration server is still starting. Try again in a moment.');
}

/** This account's own server address, if it has deployed one (no deployment). */
export async function ownServer(puter) {
  try {
    const config = await puter?.kv?.get(WORKER_KEY);
    return config?.server ? workerURL(config.server) : null;
  } catch {
    return null;
  }
}
