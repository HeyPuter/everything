import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../src/views/settings/delete-data.js';

const W = 'trips-abcdefghij';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

function stubs() {
  const kv = new Map([['me:worker', { name: W, path: '/a/AppData/x/worker/trips-worker.js' }], ['me:spaces', [
    { ref: { w: W, s: '0000000000000001', k: 'trip' }, role: 'owner', title: 'Lisbon' },
    { ref: { w: 'trips-bobbbbbbbb', s: '0000000000000002', k: 'trip' }, role: 'viewer', title: 'Porto' },
  ]], ['me:prefs', { theme: 'dark' }]]);
  const puter = {
    kv: {
      get: vi.fn(async (key) => (Array.isArray(key) ? key.map((item) => kv.get(item) ?? null) : kv.get(key) ?? null)),
      del: vi.fn(async (key) => kv.delete(key)),
      listSharedByMe: vi.fn(async () => ({ items: [] })),
      flush: vi.fn(async () => { kv.clear(); return true; }),
    },
    workers: { list: vi.fn(async () => []), delete: vi.fn(async () => true) },
    fs: { readdir: vi.fn(async () => [{ name: 'identity' }, { name: 'worker' }]), delete: vi.fn(async () => true) },
  };
  const api = {
    request: vi.fn(async (worker, body) => (JSON.parse(body).op === 'space.list' ? { spaces: [{ id: '0000000000000001', kind: 'trip' }] } : { deleted: true })),
    call: vi.fn(async () => ({ ok: true })),
  };
  return { puter, api };
}

describe('Settings → Delete my data', () => {
  it('lists what goes, needs the typed word, then runs every step', async () => {
    const { puter, api } = stubs();
    const container = document.createElement('div');
    document.body.append(container);
    await mount(container, { puter, account: { uuid: '00000000-0000-4000-8000-000000000001' }, session: { api } });
    expect(container.querySelector('a[href="#/settings/data"]')).not.toBeNull();
    [...container.querySelectorAll('button')].find((node) => node.textContent.includes('Review')).click();
    await settle();
    const text = container.querySelector('.delete-plan').textContent;
    expect(text).toContain('1 trip you own');
    expect(text).toContain('Lisbon');
    expect(text).toContain('disappear for everyone');
    expect(text).toContain('1 trip you joined');
    expect(text).toContain('Porto');
    expect(text).toContain('You leave these trips');
    expect(text).toContain(W);
    const run = [...container.querySelectorAll('button')].find((node) => node.textContent === 'Delete everything');
    expect(run.disabled).toBe(true);
    const input = container.querySelector('.delete-confirm-input');
    input.value = 'delete please';
    input.dispatchEvent(new Event('input'));
    expect(run.disabled).toBe(true);
    input.value = ' delete ';
    input.dispatchEvent(new Event('input'));
    expect(run.disabled).toBe(false);
    run.click();
    await settle();
    expect(api.call).toHaveBeenCalledWith({ w: 'trips-bobbbbbbbb', s: '0000000000000002', k: 'trip' }, 'leave', {});
    expect(api.request.mock.calls.map(([, body]) => JSON.parse(body).op)).toEqual(['space.list', 'space.delete']);
    expect(puter.workers.delete).toHaveBeenCalledWith(W);
    expect(puter.fs.delete.mock.calls.map(([name]) => name)).toEqual(['identity', 'worker']);
    expect(puter.kv.del).toHaveBeenCalledWith('me:notify:secret');
    expect(puter.kv.del).toHaveBeenCalledWith('vacay:idx');
    expect(puter.kv.del.mock.invocationCallOrder.at(-1)).toBeLessThan(puter.kv.flush.mock.invocationCallOrder[0]);
    expect(puter.kv.flush).toHaveBeenCalled();
    expect(container.querySelector('.delete-done').hidden).toBe(false);
    expect([...container.querySelectorAll('.delete-step')].every((node) => node.dataset.state === 'done')).toBe(true);
  });
});
