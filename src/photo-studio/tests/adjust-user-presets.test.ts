import { beforeEach, describe, expect, it } from 'vitest';
import {
  deletePreset,
  lastUsed,
  presetParams,
  rememberLast,
  resetPresetCache,
  savePreset,
  savedPresets,
} from '../src/features/adjust/user-presets';

// Node has no localStorage: a small in-memory stand-in.
const data = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
};

describe('saved adjustment settings', () => {
  beforeEach(() => {
    data.clear();
    resetPresetCache();
  });
  it('saves, replaces by name, sorts and deletes settings per kind', () => {
    savePreset('exposure', ' Night ', { exposure: 1, offset: 0, gamma: 1 });
    savePreset('exposure', 'Bright', { exposure: 2, offset: 0, gamma: 1 });
    savePreset('exposure', 'Night', { exposure: -1, offset: 0, gamma: 1 });
    savePreset('vibrance', 'Pop', { vibrance: 40, saturation: 0 });
    expect(savedPresets('exposure').map((p) => [p.name, p.params.exposure])).toEqual([
      ['Bright', 2],
      ['Night', -1],
    ]);
    deletePreset('exposure', 'Bright');
    expect(savedPresets('exposure').map((p) => p.name)).toEqual(['Night']);
    expect(savedPresets('vibrance')).toHaveLength(1);
    // Survives a reload.
    resetPresetCache();
    expect(savedPresets('exposure').map((p) => p.name)).toEqual(['Night']);
  });
  it('ignores blank names and copies the settings', () => {
    const params = { exposure: 1, offset: 0, gamma: 1 };
    savePreset('exposure', '   ', params);
    expect(savedPresets('exposure')).toEqual([]);
    savePreset('exposure', 'A', params);
    params.exposure = 5;
    expect(savedPresets('exposure')[0].params.exposure).toBe(1);
  });
  it('remembers the settings used last', () => {
    expect(lastUsed('levels')).toBeUndefined();
    rememberLast('posterize', { levels: 6 });
    resetPresetCache();
    expect(lastUsed('posterize')).toEqual({ levels: 6 });
  });
  it('normalizes stored settings against the defaults', () => {
    expect(presetParams('exposure', { exposure: 2 })).toEqual({ exposure: 2, offset: 0, gamma: 1 });
    expect(presetParams('exposure', { exposure: 'x' })).toMatchObject({ exposure: 0 });
  });
  it('treats unreadable storage as empty', () => {
    data.set('photo-studio-adjust-presets', '{not json');
    expect(savedPresets('curves')).toEqual([]);
  });
});
