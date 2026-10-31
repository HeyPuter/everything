import { expect, it, vi } from 'vitest';
import { loadHeads } from '../../src/lib/heads.js';

const a = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
const b = { ...a, s: '0000000000000002' };
const c = { ...a, w: 'trips-abcdefghij', s: '0000000000000003' };
const head = (title, rev = 1) => ({ title, rev, role: 'editor', start: null, end: null });

it('groups dashboard head reads into one call per worker and keeps reference order', async () => {
  const api = { request: vi.fn(async (worker, body) => {
    const input = JSON.parse(body);
    expect(input.op).toBe('heads');
    return { ok: true, heads: Object.fromEntries(input.spaces.map((id) => [id, head(`${worker}:${id}`)])) };
  }) };
  const result = await loadHeads([a, c, b, a], { api });
  expect(api.request).toHaveBeenCalledTimes(2);
  expect(JSON.parse(api.request.mock.calls[0][1]).spaces).toEqual([a.s, b.s]);
  expect(result.heads.map((item) => item.ref)).toEqual([a, c, b]);
  expect(result.errors).toEqual([]); expect(result.missing).toEqual([]);
});
it('retains successful owners when another owner is unavailable and reports missing heads separately', async () => {
  const api = { request: vi.fn(async (worker) => {
    if (worker === c.w) throw Object.assign(new Error('Private worker error'), { status: 402, code: 'insufficient_funds' });
    return { ok: true, heads: { [a.s]: head('Trip') } };
  }) };
  const result = await loadHeads([a, b, c], { api });
  expect(result.heads).toHaveLength(1); expect(result.missing).toEqual([b]);
  expect(result.errors).toEqual([{ worker: c.w, status: 402, code: 'insufficient_funds' }]);
  expect(JSON.stringify(result)).not.toContain('Private worker error');
});
it('rejects every invalid reference before sending any request', async () => {
  const api = { request: vi.fn() };
  await expect(loadHeads([a, { ...b, w: 'evil.example' }], { api })).rejects.toThrow('untrusted_worker');
  expect(api.request).not.toHaveBeenCalled();
  await expect(loadHeads([a, { ...a, k: 'collection' }], { api })).rejects.toThrow('conflicting_space_ref');
});
it('drops malformed worker responses and ignores metadata for unrequested spaces', async () => {
  const api = { request: vi.fn(async (worker) => ({ ok: true, heads: worker === a.w
    ? { [a.s]: { ...head('Trip'), role: 'admin' } }
    : { [c.s]: head('Other trip'), foreign: { secret: 'hidden' } } })) };
  const result = await loadHeads([a, c], { api });
  expect(result.heads.map((item) => item.ref)).toEqual([c]);
  expect(result.errors).toEqual([{ worker: a.w, status: 502, code: 'invalid_heads_response' }]);
  expect(JSON.stringify(result)).not.toContain('hidden');
});
it('caps simultaneous worker requests and makes no requests after an initial abort', async () => {
  let running = 0; let maximum = 0;
  const api = { request: async () => { running++; maximum = Math.max(maximum, running); await new Promise((resolve) => setTimeout(resolve, 1)); running--; return { ok: true, heads: {} }; } };
  await loadHeads([a, c, { ...a, w: 'trips-0000000000' }], { api, concurrency: 2 });
  expect(maximum).toBe(2);
  const controller = new AbortController(); controller.abort();
  await expect(loadHeads([a], { api, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
});
it('applies the owner cap after deduplication and permits more than 500 spaces across workers', async () => {
  const owner = Array.from({ length: 500 }, (_, i) => ({ ...a, s: String(i).padStart(16, '0') }));
  const api = { request: vi.fn(async () => ({ ok: true, heads: {} })) };
  const result = await loadHeads([...owner, ...owner, c], { api });
  expect(api.request).toHaveBeenCalledTimes(2);
  expect(result.missing).toHaveLength(501);
  api.request.mockClear();
  await expect(loadHeads([...owner, { ...a, s: '0000000000000500' }], { api })).rejects.toThrow('invalid_space_refs');
  expect(api.request).not.toHaveBeenCalled();
});
it('bounds aggregate unique spaces before network access', async () => {
  const refs = Array.from({ length: 10_001 }, (_, i) => ({ ...a,
    w: `trips-${String(Math.floor(i / 500)).padStart(10, '0')}`, s: String(i % 500).padStart(16, '0') }));
  const api = { request: vi.fn() };
  await expect(loadHeads(refs, { api })).rejects.toThrow('invalid_space_refs');
  expect(api.request).not.toHaveBeenCalled();
});
it('settles cancellation while a request is hung and does not schedule another worker', async () => {
  const controller = new AbortController();
  let rejectLate;
  const api = { request: vi.fn(() => new Promise((_, reject) => { rejectLate = reject; })) };
  const pending = loadHeads([a, c], { api, concurrency: 1, signal: controller.signal });
  await vi.waitFor(() => expect(api.request).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  rejectLate(new Error('late transport failure'));
  await Promise.resolve();
  expect(api.request).toHaveBeenCalledOnce();
});
