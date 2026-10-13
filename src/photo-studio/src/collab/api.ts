// Requests to a room worker, and deployment of the owner's worker.
// Adapted from the Whiteboard app's collaboration API in this repository.
import { workerURL } from './protocol';
import { authorize, refuseCredential } from './auth';
import type { CollabPuter } from './puter-types';

export const WORKER_KEY = 'photo-studio-collab-worker-v1';
export const WORKER_BUNDLE = '/worker/photo-studio-worker.js';

export class CollabError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
  /** The request never reached the worker (offline, timeout). */
  get network() {
    return this.status === 0;
  }
}

export async function call<T = Record<string, unknown>>(puter: CollabPuter, server: string, input: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), String(input.op).startsWith('asset') || input.op === 'create' ? 120_000 : 30_000);
  try {
    server = workerURL(server);
    const body = JSON.stringify(input);
    let headers = await authorize(puter, server, body);
    const send = async () => {
      try {
        controller.signal.throwIfAborted();
        return await puter.workers.exec(server + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal: controller.signal, redirect: 'error' });
      } catch {
        throw new CollabError('Could not reach the shared document. Check your connection; changes are kept and sent when it returns.');
      }
    };
    let res = await send();
    if (res.status === 401 && refuseCredential(puter, headers)) {
      headers = await authorize(puter, server, body);
      res = await send();
    }
    const data = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (res.ok && !data) throw new CollabError('The shared document did not answer. Try again shortly.');
    if (!res.ok) throw new CollabError(data?.message || 'Could not synchronize this document.', res.status || 500);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

type Deployment = { name: string; server: string; path: string; build: string };

/** Deploy (or update) this account's room worker and return its address.
 * Only a worker this account created and recorded in its private KV is ever
 * updated; an invitation link never triggers a deployment. */
export async function deploy(puter: CollabPuter, progress: (text: string) => void = () => {}, fetchBundle: () => Promise<string> = defaultBundle): Promise<string> {
  const account = puter.authToken;
  const check = () => {
    if (puter.authToken !== account) throw new Error('Your Puter account changed. Try again.');
  };
  let config = (await puter.kv.get(WORKER_KEY)) as Deployment | null;
  check();
  progress('Preparing the collaboration server…');
  const source = await fetchBundle();
  const build = /photo-studio-worker build=([a-f0-9]+)/.exec(source)?.[1];
  if (!build) throw new Error('The collaboration server bundle is invalid.');
  check();
  if (!config) {
    const name = 'photo-studio-' + crypto.randomUUID().replaceAll('-', '').slice(0, 20);
    const file = await puter.fs.write('photo-studio/collab/photo-studio-worker.js', source, { overwrite: true, dedupeName: false, createMissingParents: true });
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
      const res = await puter.workers.exec(workerURL(config.server) + '/health', { headers: { 'x-puter-no-auth': '1' }, redirect: 'error' });
      if (res.ok && ((await res.json()) as { build?: string }).build === config.build) return workerURL(config.server);
    } catch {
      /* Still starting. */
    }
    check();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('The collaboration server is still starting. Try again shortly.');
}
async function defaultBundle() {
  const res = await fetch(WORKER_BUNDLE, { cache: 'no-cache' });
  if (!res.ok) throw new Error('The collaboration server bundle could not load.');
  return res.text();
}
