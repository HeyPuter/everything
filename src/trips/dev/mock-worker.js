import { parseBanner } from '../src/lib/deploy.js';

// Fixed-name registration of the built worker, for bridge fixtures that need a worker without the deploy flow.
export const mockWorkerName = (username) => `trips-${`mock${username}`.replace(/[^a-z0-9]/g, '').padEnd(10, '0').slice(0, 10)}`;

export async function fetchWorkerSource(url = './worker/trips-worker.js', fetcher = globalThis.fetch) {
  const response = await fetcher(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('worker_bundle_missing');
  return response.text();
}

/** Registers the bundle for every user in every region; returns `{names: {uuid: workerName}, build, builtAt, protocol}`. */
export async function registerMockWorkers(world, users, source, { regions = 1 } = {}) {
  const banner = parseBanner(source);
  const names = {};
  for (const user of users) {
    const name = mockWorkerName(user.username);
    for (let region = 0; region < regions; region++) await world.registerWorker(name, { owner: user.uuid, region, source });
    names[user.uuid] = name;
  }
  return { names, ...banner };
}
