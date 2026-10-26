import { describe, expect, it, vi } from 'vitest';
import { filesEntry } from '../../src/lib/store/personal.js';
import { featureSet, loadFeatures } from '../../src/lib/sync/features.js';

describe('cached files block', () => {
  it('keeps direct folder uids, drops anything malformed', () => {
    expect(filesEntry({ mode: 'direct', uid: 'a1b2-c3', inbox: 'd4e5', extra: 1 })).toEqual({ mode: 'direct', uid: 'a1b2-c3', inbox: 'd4e5' });
    expect(filesEntry({ mode: 'direct', uid: '../x', inbox: 5 })).toEqual({ mode: 'direct' });
    expect(filesEntry({ mode: 'proxied', uid: 'a' })).toEqual({ mode: 'proxied' });
    expect(filesEntry({ mode: 'shared' })).toBeNull();
    expect(filesEntry(null)).toBeNull();
  });
});

describe('path A and direct-file flags', () => {
  it('runs both in dev, tests and the mock build without reading config.json', async () => {
    const loadConfig = vi.fn(async () => ({}));
    expect(await loadFeatures({ env: { PROD: false, MODE: 'development' }, loadConfig })).toEqual({ pathA: true, directFiles: true });
    expect(await loadFeatures({ env: { PROD: true, MODE: 'mock' }, loadConfig })).toEqual({ pathA: true, directFiles: true });
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('gates production on config.json, off unless set to true', async () => {
    const prod = { PROD: true, MODE: 'production' };
    expect(await loadFeatures({ env: prod, loadConfig: async () => ({}) })).toEqual({ pathA: false, directFiles: false });
    expect(await loadFeatures({ env: prod, loadConfig: async () => ({ pathA: true, directFiles: 'yes' }) })).toEqual({ pathA: true, directFiles: false });
    expect(await loadFeatures({ env: prod, loadConfig: async () => { throw new Error('offline'); } })).toEqual({ pathA: false, directFiles: false });
    expect(featureSet({ directFiles: true })).toEqual({ pathA: false, directFiles: true });
  });
});
