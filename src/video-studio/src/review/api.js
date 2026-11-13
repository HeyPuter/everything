/**
 * The owner's review worker: deploying it to their own Puter account,
 * keeping it up to date, and calling it (from any account).
 *
 * The worker's address and build are kept in the owner's private app KV.
 * A review link never authorizes deploying or updating anything: only the
 * worker this account created and recorded is ever touched.
 */
import { workerURL, COMMENT_DELIVERY_PENDING } from './protocol.js';
import { authorize, refuseCredential } from './auth.js';

export const WORKER_KEY = 'video-studio-review-worker-v1';
export const BUNDLE_PATH = 'worker/video-studio-review-worker.js';

const deployments = new WeakMap();

const unreachable = () => new Error('Could not reach the review server. Check your connection and try again.');

/**
 * Call an operation on a review worker. Errors carry .status from the
 * worker (401, 403, 404, 409, 429...).
 */
export async function call(puter, server, input, { timeout = 30_000 } = {}) {
  server = workerURL(server);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const body = JSON.stringify(input);
    let headers = await authorize(puter, server, body);
    const send = async () => {
      try {
        return await puter.workers.exec(`${server}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal: controller.signal, redirect: 'error' });
      } catch {
        throw unreachable();
      }
    };
    let res = await send();
    if (res.status === 401 && refuseCredential(puter, headers)) {
      headers = await authorize(puter, server, body);
      res = await send();
    }
    const data = await res.json().catch(() => null);
    if (res.ok && !data) throw unreachable();
    if (!res.ok) throw Object.assign(new Error(data?.message || 'The review server had a problem. Try again.'), {
      status: res.status,
      ...(data?.code === COMMENT_DELIVERY_PENDING ? { code: data.code } : {}),
    });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** The recorded worker address for this account, or null. */
export async function ownWorker(puter) {
  const config = await puter.kv.get(WORKER_KEY);
  try {
    return config?.server ? workerURL(config.server) : null;
  } catch {
    return null;
  }
}

async function bundle(fetcher) {
  const res = await fetcher(new URL(BUNDLE_PATH, document.baseURI).href, { cache: 'no-cache' });
  if (!res.ok) throw new Error('The review server could not be prepared.');
  const source = await res.text();
  const build = /video-studio-review-worker build=([a-z0-9]+)/.exec(source)?.[1];
  const builtAt = Number(/ at=(\d+)/.exec(source.slice(0, 160))?.[1]) || 0;
  if (!build) throw new Error('The review server could not be prepared.');
  return { source, build, builtAt };
}

/**
 * Make sure this account's review worker exists and runs the current
 * build; returns its origin. Deploys it on first use. progress(text) gets
 * short status lines for the dialog.
 */
export async function deploy(puter, { progress = () => {}, fetcher = (...a) => fetch(...a), wait = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 20 } = {}) {
  const account = puter.authToken;
  const sameAccount = () => {
    if (puter.authToken !== account) throw new Error('Your Puter account changed. Reload the page.');
  };
  let config = await puter.kv.get(WORKER_KEY);
  progress('Preparing the review server...');
  const { source, build, builtAt } = await bundle(fetcher);
  sameAccount();
  if (!config) {
    const name = `video-review-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const file = await puter.fs.write('video-studio/worker/review-worker.js', source, { overwrite: true, dedupeName: false, createMissingParents: true });
    sameAccount();
    const created = await puter.workers.create(name, file.path);
    sameAccount();
    config = { name, server: workerURL(created?.url || `https://${name}.puter.work`), path: file.path, build, builtAt };
    await puter.kv.set(WORKER_KEY, config);
  } else if (config.build !== build && !(config.builtAt > builtAt)) {
    // Updates only move forward, so an old cached copy of the app never rolls a worker back.
    await puter.fs.write(config.path, source, { overwrite: true, dedupeName: false });
    sameAccount();
    config = { ...config, build, builtAt };
    await puter.kv.set(WORKER_KEY, config);
  }
  progress('Starting the review server...');
  const server = workerURL(config.server);
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await puter.workers.exec(`${server}/health`, { headers: { 'x-puter-no-auth': '1' }, redirect: 'error' });
      if (res.ok) {
        const h = await res.json();
        if (h.build === config.build || (config.builtAt && h.builtAt > config.builtAt)) return server;
      }
    } catch {
      /* still starting */
    }
    sameAccount();
    await wait(1000);
  }
  throw new Error('The review server is still starting. Try again in a moment.');
}

/** deploy() once per page and account; later calls reuse the result. */
export function ensureWorker(puter, opts) {
  let entry = deployments.get(puter);
  if (!entry || entry.account !== puter.authToken) {
    entry = { account: puter.authToken, pending: deploy(puter, opts) };
    deployments.set(puter, entry);
    entry.pending.catch(() => {
      if (deployments.get(puter) === entry) deployments.delete(puter);
    });
  }
  return entry.pending;
}
