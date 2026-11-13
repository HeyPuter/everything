import { it, expect } from 'vitest';
import { setup, publish } from './review-helpers.js';
import { LIMITS } from '../src/review/protocol.js';
import { ReviewSession } from '../src/review/session.js';

async function publication() {
  const env = await setup();
  const { review } = await publish(env);
  const file = await env.sdk.alice.fs.write('video-studio/reviews/retry.mp4', new Blob([new Uint8Array(4096)], { type: 'video/mp4' }), { createMissingParents: true });
  const input = { clientId: 'pub_recovery001', projectId: review.projectId, title: 'Retry cut', video: { path: file.path, mime: 'video/mp4', fps: 30, duration: 1000000, width: 1280, height: 720 } };
  return { env, rid: review.id, input, send: () => env.as('alice')('review.publish', input) };
}

it.each(['before', 'after'])('recovers the same saved version when its final receipt fails %s writing', async timing => {
  const { env, rid, input, send } = await publication(), original = env.world.workerPuter;
  let failed = false;
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (key, value, options) => {
      if (!failed && key === `vsr:pub:${input.clientId}` && !value.pending) {
        failed = true;if (timing === 'after') await set(key, value, options);throw new Error('Receipt unavailable');
      }
      return set(key, value, options);
    };
    return p;
  };
  env.world.restartWorkers();
  await expect(send()).rejects.toMatchObject({ status: 500 });
  expect((await env.as('alice')('review.get', { review: rid })).review.versions.map(v => v.n)).toEqual([1, 2]);
  env.world.restartWorkers();const retried = await send();
  expect(retried.version).toBe(2);expect(retried.review.versions.map(v => v.n)).toEqual([1, 2]);
  expect(retried.review.title).toBe(input.title);
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:vseq`)).toBe(2);
});

it('uses one version for overlapping identical publication requests and retires their unused slots', async () => {
  const { env, rid, input, send } = await publication(), original = env.world.workerPuter;
  let arrived = 0, release;const gate = new Promise(resolve => { release = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), get = p.kv.get.bind(p.kv);
    p.kv.get = async key => {
      const value = await get(key);
      if (key === `vsr:pub:${input.clientId}` && arrived < 3) { if (++arrived === 3) release();await gate; }
      return value;
    };
    return p;
  };
  env.world.restartWorkers();
  const results = await Promise.all([send(), send(), send()]);
  expect(new Set(results.map(r => r.version)).size).toBe(1);
  const review = (await env.as('alice')('review.get', { review: rid })).review;
  expect(review.versions).toHaveLength(2);
  expect(review.versionSlots).toBe(4);
  for (const n of [2, 3, 4].filter(n => n !== results[0].version)) {
    await expect(env.as('alice')('video.url', { review: rid, version: n })).rejects.toMatchObject({ status: 404 });
    await expect(env.as('alice')('comment.add', { review: rid, version: n, id: `c_skipversion${n}`, text: 'Invalid', t: 0 })).rejects.toMatchObject({ status: 404 });
  }
  const calls = [], session = new ReviewSession({ review: rid, call: (_p, _s, request) => { calls.push(request.op);return env.as('alice')(request.op, request); } });
  await session.open();calls.length = 0;await session.sync();await session.sync();
  expect(calls).toEqual(['sync', 'sync']);session.dispose();
});

it.each(['before claim', 'after claim', 'before version', 'after version'])('resumes publication after a storage failure %s', async stage => {
  const { env, rid, input, send } = await publication(), original = env.world.workerPuter;
  let failed = false;
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (key, value, options) => {
      const target = stage.endsWith('claim') ? key === `vsr:pub:${input.clientId}` && value.pending : key === `vsr:r:${rid}:v:2` && !value.skip;
      if (!failed && target) { failed = true;if (stage.startsWith('after')) await set(key, value, options);throw new Error('Interrupted publication'); }
      return set(key, value, options);
    };
    return p;
  };
  env.world.restartWorkers();await expect(send()).rejects.toMatchObject({ status: 500 });expect(failed).toBe(true);
  env.world.restartWorkers();const saved = await send(), expected = stage === 'before claim' ? 3 : 2;
  expect(saved.version).toBe(expected);expect(saved.review.versions.map(v => v.n)).toEqual([1, expected]);
  expect((await send()).version).toBe(expected);
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:vseq`)).toBe(expected);
});

it.each(['delayed write', 'failed write'])('preserves a newer title and discovers an older late version after a %s', async mode => {
  const { env, rid, input, send } = await publication(), original = env.world.workerPuter;
  let ready, release, held = false;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (key, value, options) => {
      if (!held && key === `vsr:r:${rid}:v:2` && !value.skip) {
        held = true;ready();
        if (mode === 'failed write') throw new Error('Version unavailable');
        await new Promise(resolve => { release = resolve; });
      }
      return set(key, value, options);
    };
    return p;
  };
  env.world.restartWorkers();const pending = send();
  const failed = mode === 'failed write' ? expect(pending).rejects.toMatchObject({ status: 500 }) : null;
  await entered;if (failed) await failed;
  env.advance(1000);env.world.restartWorkers();
  const newer = await env.as('alice')('review.publish', { ...input, clientId: 'pub_newer001', title: 'Newer cut' });
  expect(newer.version).toBe(3);
  const calls = [], session = new ReviewSession({ review: rid, call: (_p, _s, request) => { calls.push(request.op);return env.as('alice')(request.op, request); } });
  await session.open();expect(session.review.versions.map(v => v.n)).toEqual([1, 3]);
  input.title = 'Mutated retry';input.video.duration = 2000000;
  const recovered = mode === 'failed write' ? await send() : (release(), await pending);
  expect(recovered.version).toBe(2);expect(recovered.review.title).toBe('Newer cut');
  expect(recovered.review.updated).toBe(newer.review.updated);
  expect(recovered.review.versions.find(v => v.n === 2)).toMatchObject({ title: 'Retry cut', duration: 1000000 });
  await session.sync();expect(session.review.versions.map(v => v.n)).toEqual([1, 2, 3]);
  expect(session.review.title).toBe('Newer cut');
  calls.length = 0;await session.sync();await session.sync();expect(calls).toEqual(['sync', 'sync']);session.dispose();
});

it('recovers the final permitted version when its completion receipt fails', async () => {
  const { env, rid, input, send } = await publication(), original = env.world.workerPuter;
  const base = await env.sdk.alice.kv.get(`vsr:r:${rid}:v:1`);
  for (let n = 2; n < LIMITS.versions; n++) await env.sdk.alice.kv.set(`vsr:r:${rid}:v:${n}`, { ...base, n });
  await env.sdk.alice.kv.set(`vsr:r:${rid}:vseq`, LIMITS.versions - 1);
  let failed = false;
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (key, value, options) => {
      if (!failed && key === `vsr:pub:${input.clientId}` && !value.pending) { failed = true;throw new Error('Receipt unavailable'); }
      return set(key, value, options);
    };
    return p;
  };
  env.world.restartWorkers();await expect(send()).rejects.toMatchObject({ status: 500 });env.world.restartWorkers();
  const recovered = await send();expect(recovered.version).toBe(LIMITS.versions);expect(recovered.review.versions).toHaveLength(LIMITS.versions);
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:vseq`)).toBe(LIMITS.versions);
});

it.each(['count', 'reservation'])('returns a concurrent winner when a stale duplicate reaches the full review at %s', async stage => {
  const { env, rid, input, send } = await publication(), original = env.world.workerPuter;
  const base = await env.sdk.alice.kv.get(`vsr:r:${rid}:v:1`);
  for (let n = 2; n < LIMITS.versions; n++) await env.sdk.alice.kv.set(`vsr:r:${rid}:v:${n}`, { ...base, n });
  await env.sdk.alice.kv.set(`vsr:r:${rid}:vseq`, LIMITS.versions - 1);
  let ready, release, held = false;const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), get = p.kv.get.bind(p.kv), incr = p.kv.incr.bind(p.kv);
    const hold = async () => { held = true;ready();await new Promise(resolve => { release = resolve; }); };
    p.kv.get = async key => { const value = await get(key);if (!held && stage === 'count' && key === `vsr:pub:${input.clientId}`) await hold();return value; };
    p.kv.incr = async (key, ...args) => { if (!held && stage === 'reservation' && key === `vsr:r:${rid}:vseq`) await hold();return incr(key, ...args); };
    return p;
  };
  env.world.restartWorkers();const stale = send();await entered;env.world.restartWorkers();const winner = await send();release();
  expect((await stale).version).toBe(winner.version);expect(winner.version).toBe(LIMITS.versions);
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:vseq`)).toBe(LIMITS.versions);
});

it('keeps the saved video when Share retries a lost response after the final version was stored', async () => {
  const { shareForReview } = await import('../src/review/share.js');
  const { fixture, clip, onMain } = await import('./helpers.js');
  const { env, rid, input } = await publication(), original = env.world.workerPuter;
  const base = await env.sdk.alice.kv.get(`vsr:r:${rid}:v:1`);
  for (let n = 2; n < LIMITS.versions; n++) await env.sdk.alice.kv.set(`vsr:r:${rid}:v:${n}`, { ...base, n });
  await env.sdk.alice.kv.set(`vsr:r:${rid}:vseq`, LIMITS.versions - 1);
  let failed = false, lost = false, requests = 0, releases = 0;
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (key, value, options) => {
      if (!failed && key.startsWith('vsr:pub:') && !value.pending) { failed = true;throw new Error('Receipt unavailable'); }
      return set(key, value, options);
    };
    return p;
  };
  env.world.restartWorkers();
  const exec = env.sdk.alice.workers.exec.bind(env.sdk.alice.workers);
  env.sdk.alice.workers.exec = async (url, options) => {
    const op = options?.body ? JSON.parse(options.body).op : null;
    if (op === 'review.publish') requests++;
    const response = await exec(url, options);
    if (!lost && op === 'review.publish' && response.status === 500) { lost = true;throw new Error('Response lost'); }
    return response;
  };
  const project = fixture();project.id = input.projectId;onMain(project, clip('video', 0, 1));
  const result = await shareForReview({ puter: env.sdk.alice, project, library: null, title: 'Final cut', deps: {
    ensureWorker: async () => env.server,
    detectCapabilities: async () => ({ video: ['avc'], audio: ['aac'] }),
    exportProject: async () => ({ blob: new Blob([new Uint8Array(2048)], { type: 'video/mp4' }), duration: 1000000, width: 1280, height: 720, release: () => { releases++; } }),
  } });
  expect(failed && lost).toBe(true);expect(requests).toBe(2);expect(releases).toBe(1);
  expect(result.version).toBe(LIMITS.versions);expect(result.review.versions).toHaveLength(LIMITS.versions);
  const saved = await env.sdk.alice.kv.get(`vsr:r:${rid}:v:${LIMITS.versions}`);
  expect((await env.sdk.alice.fs.stat(saved.path)).size).toBe(2048);
});
