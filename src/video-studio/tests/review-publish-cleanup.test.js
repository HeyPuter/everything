import { it, expect } from 'vitest';
import { setup, publish } from './review-helpers.js';
import { fixture, clip, onMain } from './helpers.js';
import { shareForReview } from '../src/review/share.js';
import { LIMITS } from '../src/review/protocol.js';

it('retains a video when a timed-out publish finishes after its retry is refused', async () => {
  const env = await setup(), { review } = await publish(env), rid = review.id;
  const base = await env.sdk.alice.kv.get(`vsr:r:${rid}:v:1`);
  for (let n = 2; n < LIMITS.versions; n++) await env.sdk.alice.kv.set(`vsr:r:${rid}:v:${n}`, { ...base, n });
  await env.sdk.alice.kv.set(`vsr:r:${rid}:vseq`, LIMITS.versions - 1);
  const original = env.world.workerPuter;
  let held = false, ready, release, originalRequest, lost = false, requests = 0, releases = 0;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (key, value, options) => {
      if (!held && key.startsWith('vsr:pub:') && value.pending) { held = true;ready();await new Promise(resolve => { release = resolve; }); }
      return set(key, value, options);
    };
    return p;
  };
  env.world.restartWorkers();
  const exec = env.sdk.alice.workers.exec.bind(env.sdk.alice.workers);
  env.sdk.alice.workers.exec = async (url, options) => {
    const op = options?.body ? JSON.parse(options.body).op : null;
    if (op === 'review.publish') requests++;
    if (!lost && op === 'review.publish') {
      lost = true;originalRequest = exec(url, options);await entered;
      throw new Error('Transport timed out while the worker continued');
    }
    return exec(url, options);
  };
  const project = fixture();project.id = review.projectId;onMain(project, clip('video', 0, 1));
  await expect(shareForReview({ puter: env.sdk.alice, project, library: null, title: 'Late final cut', deps: {
    ensureWorker: async () => env.server,
    detectCapabilities: async () => ({ video: ['avc'], audio: ['aac'] }),
    exportProject: async () => ({ blob: new Blob([new Uint8Array(2048)], { type: 'video/mp4' }), duration: 1000000, width: 1280, height: 720, release: () => { releases++; } }),
  } })).rejects.toMatchObject({ status: 409 });
  release();expect((await originalRequest).status).toBe(200);
  expect(requests).toBe(2);expect(releases).toBe(1);
  const saved = await env.sdk.alice.kv.get(`vsr:r:${rid}:v:${LIMITS.versions}`);
  expect(saved.title).toBe('Late final cut');
  expect((await env.sdk.alice.fs.stat(saved.path)).size).toBe(2048);
});
