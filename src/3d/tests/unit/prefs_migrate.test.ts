// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

// a localStorage we can inspect
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage });

describe('key configuration storage', () => {
  it('migrates rebinds stored by older builds and saves the new format', async () => {
    store.set('p3d.keymap.overrides.v1', JSON.stringify([{ km: 'Mig Map', index: 1, op: 'mig.b', orig: { key: 'B', ctrl: false, shift: false, alt: false }, key: 'N', ctrl: true, shift: false, alt: false, active: true }]));
    const { addKeys, keymaps } = await import('../../src/app/keymap');
    addKeys('Mig Map', [
      { key: 'A', op: 'mig.a' },
      { key: 'B', op: 'mig.b' },
    ]);
    const kc = await import('../../src/prefs/keyconfig');
    kc.startKeyconfig();
    expect(keymaps['Mig Map'][1]).toMatchObject({ key: 'N', ctrl: true, op: 'mig.b' });
    kc.keyconfigChanged();
    expect(store.has('p3d.keymap.overrides.v1')).toBe(false);
    const saved = JSON.parse(store.get('p3d.keyconfig.v2')!);
    expect(saved.format).toBe('p3d-keyconfig');
    expect(Object.values(saved.edits)).toEqual([{ key: 'N', ctrl: true }]);
  });

  it('keeps changes unsaved while auto-save is off and reverts to the stored state', async () => {
    const kc = await import('../../src/prefs/keyconfig');
    const { keymaps } = await import('../../src/app/keymap');
    kc.keyconfigSaving.auto = false;
    const a = keymaps['Mig Map'][0];
    kc.keyconfig.edit(a, { key: 'Q' });
    kc.keyconfigChanged();
    expect(kc.keyconfigSaving.dirty).toBe(true);
    expect(JSON.parse(store.get('p3d.keyconfig.v2')!).edits).not.toHaveProperty(kc.keyconfig.idOf(a));
    kc.revertKeyconfig();
    expect(a.key).toBe('A');
    expect(keymaps['Mig Map'][1].key).toBe('N');
    kc.factoryKeyconfig();
    expect(keymaps['Mig Map'][1].key).toBe('B');
    expect(store.has('p3d.keyconfig.v2')).toBe(false);
  });
});
