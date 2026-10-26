// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { INTEGRATIONS_KEY, cleanConfig, createIntegrationStore, integrationStore, readIntegrations } from '../../src/lib/integrations/store.js';
import { exportAllData, personalKeys } from '../../src/lib/io/data-export.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { DAWARICH_KEY } from '../../src/lib/integrations/dawarich.js';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function spied() {
  const runtime = createFakePuter({ now: 1_000_000 });
  const puter = runtime.client('alice');
  const set = vi.spyOn(puter.kv, 'set');
  return { runtime, puter, set };
}

describe('integration settings in me:integrations', () => {
  it('cleans what it stores and reads', () => {
    expect(cleanConfig('immich', { url: 'photos.example.com/api/', key: ' k1 ', extra: 1 })).toEqual({ url: 'https://photos.example.com', key: 'k1' });
    expect(cleanConfig('airtrail', { url: 'https://a.example', key: 'k', sync: true, trails: true })).toEqual({ url: 'https://a.example', key: 'k', sync: true });
    expect(cleanConfig('immich', { url: 'ftp://x', key: 'k' })).toBeNull();
    expect(cleanConfig('immich', { url: 'https://x.example', key: 'a\nb' })).toBeNull();
    expect(cleanConfig('other', { url: 'https://x.example', key: 'k' })).toBeNull();
    expect(readIntegrations({ v: 2, immich: { url: 'https://x.example', key: 'k' } }).immich).toBeNull();
  });

  it('writes with disableSharing, keeps other services and fields it does not know', async () => {
    const { puter, set } = spied();
    await puter.kv.set(INTEGRATIONS_KEY, { v: 1, dawarich: { url: 'https://d.example', key: 'dk', trails: true, future: 'kept' }, later: { x: 1 } });
    const store = createIntegrationStore({ puter });
    expect((await store.load()).dawarich).toEqual({ url: 'https://d.example', key: 'dk', trails: true });
    set.mockClear();
    await store.save('immich', { url: 'https://photos.example.com', key: 'ik' });
    expect(set).toHaveBeenCalledWith(INTEGRATIONS_KEY, expect.any(Object), { disableSharing: true });
    const stored = await puter.kv.get(INTEGRATIONS_KEY);
    expect(stored).toEqual({ v: 1, dawarich: { url: 'https://d.example', key: 'dk', trails: true, future: 'kept' }, later: { x: 1 }, immich: { url: 'https://photos.example.com', key: 'ik' } });
    await store.setFlags('dawarich', { trails: false, sync: true });
    expect((await puter.kv.get(INTEGRATIONS_KEY)).dawarich).toEqual({ url: 'https://d.example', key: 'dk', trails: false, future: 'kept' });
    await expect(store.setFlags('airtrail', { sync: true })).rejects.toMatchObject({ code: 'not_configured' });
    await expect(store.save('immich', { url: 'nope nope', key: 'k' })).rejects.toMatchObject({ code: 'invalid_url' });
    await store.remove('immich');
    await store.remove('dawarich');
    expect(await puter.kv.get(INTEGRATIONS_KEY)).toBeNull();
    expect(store.configured('immich')).toBe(false);
  });

  it('refuses to act for another session and shares one store per session', async () => {
    const { puter } = spied();
    const store = createIntegrationStore({ puter });
    expect(integrationStore(puter)).toBe(integrationStore(puter));
    puter.authToken = 'someone-else';
    await expect(store.load()).rejects.toMatchObject({ code: 'account_changed' });
  });

  it('is never cached by the personal store', async () => {
    const { puter } = spied();
    const db = { account: ME, get: async () => undefined, put: async () => {}, remove: async () => {}, update: async () => {} };
    const personal = createPersonalStore({ puter, db });
    expect(() => personal.refresh(INTEGRATIONS_KEY)).toThrow(expect.objectContaining({ code: 'private_store_required' }));
    expect(() => personal.subscribe(INTEGRATIONS_KEY, () => {})).toThrow(expect.objectContaining({ code: 'private_store_required' }));
  });

  it('is left out of "download all my data", while Dawarich review state is included', async () => {
    expect(personalKeys({ spaces: [], templates: {} })).not.toContain(INTEGRATIONS_KEY);
    expect(personalKeys({ spaces: [], templates: {} })).toContain(DAWARICH_KEY);
    const kv = new Map([
      ['me:prefs', { theme: 'dark' }],
      [INTEGRATIONS_KEY, { v: 1, immich: { url: 'https://photos.example.com', key: 'very-secret' } }],
      [DAWARICH_KEY, { reviewed: { '0123abcd_1': { s: 'dismissed', at: 1 } } }],
    ]);
    const { blob } = await exportAllData({ puter: { kv: { get: async (key) => kv.get(key) } }, account: { uuid: ME } });
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const text = strFromU8(files['personal.json']);
    expect(text).not.toContain('very-secret');
    expect(JSON.parse(text).keys).toHaveProperty(DAWARICH_KEY);
    expect(JSON.parse(text).keys).not.toHaveProperty(INTEGRATIONS_KEY);
  });
});
