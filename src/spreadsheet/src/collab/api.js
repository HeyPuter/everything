/**
 * Requests to a room worker, and deployment of the owner's worker. Adapted from the Whiteboard app's
 * collaboration API in this repository.
 */

import { workerURL } from './protocol.js';
import { authorize, refuseCredential } from './auth.js';

export const WORKER_KEY = 'spreadsheet-collab-worker-v1';
export const WORKER_BUNDLE = 'worker/spreadsheet-worker.js';

export class CollabError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
  /** The request never reached the worker (offline, timeout). */
  get network() { return this.status === 0; }
}

/** The page's Puter.js, when it offers what co-authoring needs. */
export function collabPuter() {
  const p = globalThis.puter;
  if (!p?.workers?.exec || !p.workers.create || !p.kv?.get || !p.fs?.getReadURL || !p.auth?.getUser) {
    throw new Error('Editing together needs Puter. Open the spreadsheet from Puter or check your connection, then try again.');
  }
  return p;
}

export async function call(puter, server, input) {
  const controller = new AbortController();
  const slow = input.op === 'create' || input.op === 'load' || input.op === 'checkpoint';
  const timer = setTimeout(() => controller.abort(), slow ? 120_000 : 30_000);
  try {
    server = workerURL(server);
    const body = JSON.stringify(input);
    let headers = await authorize(puter, server, body);
    const send = async () => {
      try {
        controller.signal.throwIfAborted();
        return await puter.workers.exec(`${server}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal: controller.signal, redirect: 'error' });
      } catch {
        throw new CollabError('Could not reach the shared workbook. Check your connection; your changes are kept and sent when it returns.');
      }
    };
    let res = await send();
    if (res.status === 401 && refuseCredential(puter, headers)) {
      headers = await authorize(puter, server, body);
      res = await send();
    }
    const data = await res.json().catch(() => null);
    if (res.ok && !data) throw new CollabError('The shared workbook did not answer. Try again shortly.');
    if (!res.ok) throw new CollabError(data?.message || 'Could not synchronize this workbook.', res.status || 500);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deploy (or update) this account's room worker and return its address. Only a worker this account created
 * and recorded in its private KV is ever updated; an invitation link never triggers a deployment.
 */
export async function deploy(puter, progress = () => {}, fetchBundle = defaultBundle) {
  const account = puter.authToken;
  const check = () => { if (puter.authToken !== account) throw new Error('Your Puter account changed. Try again.'); };
  let config = await puter.kv.get(WORKER_KEY);
  check();
  progress('Preparing the collaboration server…');
  const source = await fetchBundle();
  const build = /spreadsheet-worker build=([a-f0-9]+)/.exec(source)?.[1];
  if (!build) throw new Error('The collaboration server bundle is invalid.');
  check();
  if (!config) {
    const name = `spreadsheet-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const file = await puter.fs.write('spreadsheet/collab/spreadsheet-worker.js', source, { overwrite: true, dedupeName: false, createMissingParents: true });
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
    } catch { /* Still starting. */ }
    check();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('The collaboration server is still starting. Try again shortly.');
}

async function defaultBundle() {
  const res = await fetch(new URL(WORKER_BUNDLE, document.baseURI), { cache: 'no-cache' });
  if (!res.ok) throw new Error('The collaboration server bundle could not load.');
  return res.text();
}
