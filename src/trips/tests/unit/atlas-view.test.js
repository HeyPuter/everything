import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mapCalls = [];
vi.mock('../../src/views/atlas/map.js', () => ({
  createAtlasMap: vi.fn(async (container, options) => { mapCalls.push(options); return { render: vi.fn((x) => mapCalls.push(['render', x])), frame: vi.fn(), resize: vi.fn(), destroy: vi.fn() }; }),
}));

const UID = '11111111-1111-4111-8111-111111111111';
const serve = async (url) => {
  const path = new URL(url, 'http://localhost/').pathname.replace(/^.*\/data\//, '');
  try { return new Response(readFileSync(`${process.cwd()}/public/data/${path}`, 'utf8'), { status: 200 }); } catch { return new Response('', { status: 404 }); }
};
// Country and region data load in real time, which a loaded machine stretches: wait for results, not for a fixed time.
const WAIT = { timeout: 10_000 };
const until = (check) => vi.waitFor(check, WAIT);

// Smoke test with the map stubbed: list, detail, focus return, search and a manual mark.
beforeEach(() => { mapCalls.length = 0; });
const lastRender = () => mapCalls.filter((call) => call[0] === 'render').at(-1)?.[1];

describe('atlas view', () => {
  it('mounts, lists, selects, marks and searches', async () => {
    vi.stubGlobal('fetch', vi.fn(serve));
    const { mount } = await import('../../src/views/atlas/index.js');
    const ref = { w: 'trips-aaaaaaaaaa', s: 'abcdefghjkmnpqrs', k: 'trip' };
    const ref2 = { w: 'trips-aaaaaaaaaa', s: 'bbcdefghjkmnpqrs', k: 'trip' };
    const record = { rev: 3, confirmed: {
      'meta:meta': { id: 'meta', title: 'Paris', start: '2025-05-01', end: '2025-05-04' },
      'place:p1': { id: 'p1', name: 'Louvre', cc: 'FR', lat: 48.861, lng: 2.336 },
      'place:p2': { id: 'p2', name: 'Somewhere', lat: 41.39, lng: 2.17 },
    }, pending: [] };
    let marks = { visited: { PE: 'manual' } };
    const subs = new Map();
    const personal = {
      spaces: { list: async () => [{ ref, role: 'owner', title: 'Paris' }, { ref: ref2, role: 'viewer', title: 'Far', start: '2024-01-01', end: '2024-01-02' }] },
      get: async (key) => (key === 'me:atlas' ? marks : null),
      refresh: async () => marks,
      subscribe: (key, fn) => { subs.set(key, fn); return () => subs.delete(key); },
    };
    const puter = { kv: { update: vi.fn(async (_key, patch) => {
      marks = structuredClone(marks);
      for (const [path, value] of Object.entries(patch)) { const [group, code] = path.split('.'); marks[group] = { ...(marks[group] ?? {}), [code]: value }; }
      return marks;
    }), remove: vi.fn(async () => marks) } };
    const db = { account: UID, get: async (key) => (key === `space:${ref.w}:${ref.s}` ? record : undefined) };
    const container = document.createElement('div'); document.body.append(container);
    const controller = new AbortController();
    const cleanup = await mount(container, { signal: controller.signal, personal, puter, account: { uuid: UID }, session: { db, personal } });
    await until(() => {
      const text = container.textContent;
      expect(text).toContain('France');
      expect(text).toContain('Spain');
      expect(text).toContain('Peru');
      expect(text).toContain('1 trip isn’t on this device yet');
    });
    expect(container.querySelectorAll('.atlas-stat').length).toBe(9);
    expect(container.querySelector('.atlas-stat dd').textContent).toBe('3');
    // select France
    container.querySelector('[data-focus="row:FR"]').click();
    expect(container.querySelector('.atlas-detail-title').textContent).toBe('France');
    expect(container.textContent).toContain('Louvre');
    expect(document.activeElement.className).toContain('atlas-detail-title');
    container.querySelector('[data-focus="back"]').click();
    expect(document.activeElement.dataset.focus).toBe('row:FR');
    // search and mark Germany
    const input = container.querySelector('input[type=search]');
    input.value = 'germ'; input.dispatchEvent(new Event('input'));
    expect(container.textContent).toContain('Germany');
    container.querySelector('[data-focus="row:DE"]').click();
    container.querySelector('[data-focus="mark"]').click();
    await until(() => expect(container.querySelector('.atlas-status').textContent).toContain('Visited'));
    expect(puter.kv.update).toHaveBeenCalledWith('me:atlas', { 'visited.DE': 'manual' });
    // planned toggle
    container.querySelector('.atlas-toolbar [role=switch]').click();
    expect(lastRender()).toMatchObject({ visited: ['ES', 'FR', 'DE', 'PE'], planned: [], selected: 'DE', wishlist: [], bucket: [] });
    await until(() => expect(container.querySelector('.atlas-detail').textContent).toContain('Bavaria'));

    // France's regions: Paris comes from the Louvre; mark another region by hand.
    container.querySelector('[data-focus="back"]').click();
    input.value = 'france'; input.dispatchEvent(new Event('input'));
    container.querySelector('[data-focus="row:FR"]').click();
    await until(() => expect(container.querySelector('.atlas-region[data-code="FR-75"]')).toBeTruthy());
    const paris = container.querySelector('.atlas-region[data-code="FR-75"]');
    expect(paris.dataset.status).toBe('visited');
    expect(paris.textContent).toContain('From your trips');
    expect(container.querySelector('.atlas-detail').textContent).toContain('1 of 101');
    container.querySelector('[data-focus="region:FR-06"]').click();
    await until(() => expect(container.querySelector('.atlas-region[data-code="FR-06"]').dataset.status).toBe('visited'));
    expect(puter.kv.update).toHaveBeenLastCalledWith('me:atlas', { 'regions.FR-06': 'manual' });
    expect(container.querySelector('.atlas-detail').textContent).toContain('2 of 101');
    const filter = container.querySelector('[data-focus="region-filter"]');
    filter.value = 'savoie'; filter.dispatchEvent(new Event('input'));
    expect([...container.querySelectorAll('.atlas-region')].filter((node) => !node.hidden).map((node) => node.dataset.code).sort()).toEqual(['FR-73', 'FR-74']);
    const regionRender = lastRender();
    expect(regionRender.regions.find((entry) => entry.cc === 'FR').statuses.get('FR-75')).toBe('visited');

    // The other sections.
    const tab = (label) => [...container.querySelectorAll('.atlas-side > .seg button')].find((node) => node.textContent === label);
    tab('Bucket list').click();
    expect(container.textContent).toContain('Your bucket list is empty');
    expect(container.querySelector('input[type=search]').closest('.field').hidden).toBe(true);
    tab('Flights').click();
    expect(container.textContent).toContain('No flights yet');
    expect(JSON.parse(localStorage.getItem('trips:atlas')).view).toBe('flights');
    cleanup();
    controller.abort();
  }, 30_000);
});

describe('atlas bucket list', () => {
  it('adds a place, derives its country offline and marks it visited', async () => {
    vi.stubGlobal('fetch', vi.fn(serve));
    localStorage.setItem('trips:atlas', JSON.stringify({ view: 'bucket' }));
    const { mount } = await import('../../src/views/atlas/index.js');
    const kv = new Map();
    const subs = new Map();
    const notify = (key) => { for (const fn of subs.get(key) ?? []) fn(kv.get(key) ?? null); };
    const personal = {
      spaces: { list: async () => [] },
      get: async (key) => kv.get(key) ?? null,
      set: async (key, value) => { kv.set(key, value); return value; },
      refresh: async (key) => { notify(key); return kv.get(key) ?? null; },
      subscribe: (key, fn) => { subs.set(key, new Set([...(subs.get(key) ?? []), fn])); return () => subs.get(key).delete(fn); },
    };
    const puter = { authToken: 'token', kv: {
      update: vi.fn(async (key, patch) => { const value = { ...(kv.get(key) ?? {}), ...patch }; kv.set(key, value); return value; }),
      remove: vi.fn(async (key, ...paths) => { const value = { ...(kv.get(key) ?? {}) }; for (const path of paths) delete value[path]; kv.set(key, value); return value; }),
      del: vi.fn(async (key) => kv.delete(key)),
    } };
    const container = document.createElement('div'); document.body.append(container);
    const controller = new AbortController();
    const cleanup = await mount(container, { signal: controller.signal, personal, puter, account: { uuid: UID }, session: { db: { get: async () => undefined }, personal } });
    await until(() => expect(container.textContent).toContain('Your bucket list is empty'));
    container.querySelector('[data-focus="bucket-add"]').click();
    const dialog = document.querySelector('.modal-panel');
    const inputs = [...dialog.querySelectorAll('input, select, textarea')];
    const byLabel = (text) => inputs.find((node) => dialog.querySelector(`label[for="${node.id}"]`)?.textContent === text);
    byLabel('Name').value = 'Machu Picchu';
    const coords = byLabel('Coordinates');
    coords.value = '-13.1631, -72.5450'; coords.dispatchEvent(new Event('change'));
    await until(() => expect(byLabel('Country').value).toBe('PE'));
    dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => expect(document.querySelector('.modal-panel')).toBeNull());
    const [id] = Object.keys(kv.get('me:buckets'));
    expect(kv.get(`me:bucket:${id}`)).toMatchObject({ name: 'Machu Picchu', cc: 'PE', lat: -13.1631, lng: -72.545 });
    await until(() => {
      expect(container.textContent).toContain('Machu Picchu');
      expect(lastRender()).toMatchObject({ wishlist: ['PE'], bucket: [{ id, lat: -13.1631, lng: -72.545, visited: false }] });
    });
    container.querySelector(`[data-focus="bucket-done:${id}"]`).click();
    await until(() => {
      expect(kv.get('me:buckets')[id].visitedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(lastRender()).toMatchObject({ visited: ['PE'], wishlist: [] });
      expect(container.querySelector('.atlas-stat dd').textContent).toBe('1');
    });
    cleanup();
    controller.abort();
  }, 30_000);
});
