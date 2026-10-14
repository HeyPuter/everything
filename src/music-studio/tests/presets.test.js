import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EFFECTS, EFFECT_TYPES, defaultEffectParams } from '../src/effects/catalog.js';
import { EFFECT_PRESETS, effectPresetsFor, effectPresetParams } from '../src/effects/presets.js';
import { UserPresets, PRESETS_DIR, PRESETS_FILE } from '../src/storage/user-presets.js';
import { presetController, paramsEqual } from '../src/ui/presets.js';
import * as puterApi from '../src/storage/puter.js';

/** A fake Puter SDK with an in-memory file system; every fs call is recorded. */
function fakePuter({ signedIn = true, username = 'ada' } = {}) {
  const files = new Map();
  const calls = [];
  const rec = (name, fn) => (...args) => {
    calls.push(name);
    return fn(...args);
  };
  const p = {
    env: 'web',
    files,
    calls,
    signedIn,
    auth: { isSignedIn: () => p.signedIn, getUser: rec('getUser', async () => ({ username })) },
    fs: {
      write: rec('write', async (path, data) => {
        files.set(path, typeof data === 'string' ? data : await new Blob([data]).text());
        return { path };
      }),
      read: rec('read', async (path) => {
        if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 'subject_does_not_exist' });
        return new Blob([files.get(path)]);
      }),
      stat: rec('stat', async () => {
        throw Object.assign(new Error('missing'), { code: 'subject_does_not_exist' });
      }),
      mkdir: rec('mkdir', async (path) => ({ path: `/${username}/AppData/app-test/${path}` })),
      readdir: rec('readdir', async () => []),
    },
  };
  return p;
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

const FILE = `/ada/AppData/app-test/${PRESETS_DIR}/${PRESETS_FILE}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let saved;
beforeEach(() => {
  saved = window.puter;
  puterApi.resetAccountCache();
});
afterEach(() => {
  window.puter = saved;
  puterApi.resetAccountCache();
});

describe('built-in effect presets', () => {
  it('cover every effect with 3 to 8 presets, "Default" first, unique names', () => {
    for (const type of EFFECT_TYPES) {
      const list = EFFECT_PRESETS[type];
      expect(list, type).toBeTruthy();
      expect(list.length, type).toBeGreaterThanOrEqual(3);
      expect(list.length, type).toBeLessThanOrEqual(8);
      expect(list[0].name).toBe('Default');
      expect(new Set(list.map((p) => p.name.toLowerCase())).size, type).toBe(list.length);
    }
  });

  it('only use known parameters, within their ranges, whole numbers for stepped ones', () => {
    for (const type of EFFECT_TYPES) {
      for (const pr of effectPresetsFor(type)) {
        for (const [id, v] of Object.entries(pr.params)) {
          const def = EFFECTS[type].params.find((p) => p.id === id);
          const where = `${type} / ${pr.name} / ${id}`;
          expect(def, where).toBeTruthy();
          expect(Number.isFinite(v), where).toBe(true);
          expect(v, where).toBeGreaterThanOrEqual(def.min);
          expect(v, where).toBeLessThanOrEqual(def.max);
          if (def.step === 1 || def.options) expect(Number.isInteger(v), where).toBe(true);
        }
      }
    }
  });

  it('differ from each other and apply over the defaults', () => {
    for (const type of EFFECT_TYPES) {
      const defs = defaultEffectParams(type);
      const fulls = effectPresetsFor(type).map((p) => effectPresetParams(type, p));
      expect(fulls[0]).toEqual(defs);
      for (let i = 0; i < fulls.length; i++) for (let j = i + 1; j < fulls.length; j++) expect(paramsEqual(fulls[i], fulls[j], defs), `${type} ${i} ${j}`).toBe(false);
    }
  });
});

describe('user preset store', () => {
  it('saves, lists by kind, renames and deletes, persisting to local storage', () => {
    const storage = memoryStorage();
    const s = new UserPresets({ storage });
    const a = s.save('effect:eq', '  Bright  ', { m2_gain: 3, junk: 'x' });
    s.save('effect:eq', 'Analog', { m2_gain: 1 });
    s.save('effect:reverb', 'Room', { size: 0.2 });
    expect(a.name).toBe('Bright');
    expect(a.params).toEqual({ m2_gain: 3 });
    expect(s.list('effect:eq').map((p) => p.name)).toEqual(['Analog', 'Bright']);
    // Same name replaces (keeps the id).
    const again = s.save('effect:eq', 'bright', { m2_gain: 5 });
    expect(again.id).toBe(a.id);
    expect(s.list('effect:eq')).toHaveLength(2);
    expect(s.rename(a.id, 'Shiny').name).toBe('Shiny');
    expect(s.remove(a.id)).toBe(true);
    expect(s.get(a.id)).toBe(null);
    expect(s.list('effect:eq').map((p) => p.name)).toEqual(['Analog']);
    // A new store reads the same data back (the deletion included).
    const t = new UserPresets({ storage });
    expect(t.list('effect:eq').map((p) => p.name)).toEqual(['Analog']);
    expect(t.list('effect:reverb')[0].params).toEqual({ size: 0.2 });
    expect(t.items.get(a.id).deleted).toBe(true);
  });

  it('ignores empty names and survives damaged storage', () => {
    const storage = memoryStorage();
    storage.setItem('music-studio:presets', '{not json');
    const s = new UserPresets({ storage });
    expect(s.list('effect:eq')).toEqual([]);
    expect(s.save('effect:eq', '   ', {})).toBe(null);
  });

  it('merges by id, newest wins, deletions included', () => {
    let clock = 1000;
    const s = new UserPresets({ storage: memoryStorage(), now: () => clock });
    const mine = s.save('effect:eq', 'Mine', { m1_gain: 1 });
    const old = s.save('effect:eq', 'Old', { m1_gain: 2 });
    const r = s.merge([
      { id: mine.id, kind: 'effect:eq', name: 'Mine (stale)', params: { m1_gain: 9 }, updated: 10 },
      { id: old.id, kind: 'effect:eq', name: 'Old renamed', params: { m1_gain: 3 }, updated: 5000 },
      { id: 'pr-remote', kind: 'effect:eq', name: 'Theirs', params: { m1_gain: 4 }, updated: 2000 },
      { id: 'pr-gone', kind: 'effect:eq', name: 'Gone', deleted: true, updated: 3000 },
      { id: 'bad' },
    ]);
    expect(r.changed).toBe(true);
    expect(r.stale).toBe(true); // our "Mine" is newer than theirs
    expect(s.get(mine.id).name).toBe('Mine');
    expect(s.get(old.id).name).toBe('Old renamed');
    expect(s.list('effect:eq').map((p) => p.name)).toEqual(['Mine', 'Old renamed', 'Theirs']);
    // A remote deletion newer than ours removes it here.
    clock = 6000;
    s.merge([{ id: 'pr-remote', kind: 'effect:eq', name: 'Theirs', deleted: true, updated: 7000 }]);
    expect(s.get('pr-remote')).toBe(null);
    // Merging our own data back changes nothing and is not stale.
    const back = s.merge(JSON.parse(JSON.stringify(s.toJSON().presets)));
    expect(back).toEqual({ changed: false, stale: false });
  });

  it('never touches Puter while signed out', async () => {
    const fake = fakePuter({ signedIn: false });
    window.puter = fake;
    const s = new UserPresets({ storage: memoryStorage(), delay: 5 });
    s.save('effect:eq', 'Local only', { m1_gain: 1 });
    expect(await s.sync()).toBe(false);
    await wait(20);
    await s.flush();
    expect(fake.calls).toEqual([]);
  });

  it('when signed in, writes one cloud file a moment after a burst of changes', async () => {
    const fake = fakePuter();
    window.puter = fake;
    const s = new UserPresets({ storage: memoryStorage(), delay: 15 });
    s.save('effect:eq', 'One', { m1_gain: 1 });
    s.save('effect:eq', 'Two', { m1_gain: 2 });
    s.save('instrument:synth', 'Pad', { cutoff: 900 });
    expect(fake.calls.filter((c) => c === 'write')).toHaveLength(0);
    await wait(40);
    await s.flush();
    expect(fake.calls.filter((c) => c === 'write')).toHaveLength(1);
    expect([...fake.files.keys()]).toEqual([FILE]);
    const data = JSON.parse(fake.files.get(FILE));
    expect(data.presets.map((p) => p.name).sort()).toEqual(['One', 'Pad', 'Two']);
  });

  it('merges the cloud file on sync and only writes back when it lacks something', async () => {
    const fake = fakePuter();
    window.puter = fake;
    fake.files.set(FILE, JSON.stringify({ format: 'music-studio-presets', version: 1, presets: [{ id: 'pr-cloud', kind: 'effect:reverb', name: 'From laptop', params: { size: 0.9 }, updated: 100 }] }));
    const s = new UserPresets({ storage: memoryStorage(), delay: 5 });
    await s.sync();
    expect(s.list('effect:reverb').map((p) => p.name)).toEqual(['From laptop']);
    expect(fake.calls.filter((c) => c === 'write')).toHaveLength(0);
    // Something local the cloud lacks: written back, keeping the cloud's preset.
    s.save('effect:reverb', 'From phone', { size: 0.3 });
    await s.flush();
    const names = JSON.parse(fake.files.get(FILE)).presets.map((p) => p.name).sort();
    expect(names).toEqual(['From laptop', 'From phone']);
  });

  it('does not overwrite the cloud file when it cannot be read', async () => {
    const fake = fakePuter();
    fake.fs.read = async () => {
      throw Object.assign(new Error('offline'), { code: 'network' });
    };
    window.puter = fake;
    const s = new UserPresets({ storage: memoryStorage(), delay: 5 });
    s.save('effect:eq', 'Kept', {});
    await expect(s.sync()).rejects.toThrow('offline');
    expect(fake.calls).not.toContain('write');
  });
});

describe('preset controller', () => {
  const app = () => ({ prefs: { storage: memoryStorage() }, on: () => () => {}, notify: () => {} });

  it('names the current parameters, prefers the last pick, steps through built-ins and saved presets', () => {
    window.puter = fakePuter({ signedIn: false });
    const a = app();
    const defaults = defaultEffectParams('eq');
    let params = { ...defaults };
    const applied = [];
    const pc = presetController({
      app: a,
      kind: 'effect:eq',
      builtins: effectPresetsFor('eq'),
      defaults,
      params: () => params,
      apply: (e) => {
        applied.push(e.name);
        params = { ...e.params };
      },
    });
    expect(pc.label()).toBe('Default');
    pc.step(1);
    expect(applied).toEqual(['Low cut 80']);
    expect(pc.label()).toBe('Low cut 80');
    params = { ...params, m1_gain: 2 };
    expect(pc.label()).toBe('Custom');
    // A saved copy of a built-in: the one loaded last wins the name.
    a.userPresets.save('effect:eq', 'My low cut', { ...defaults, hp_freq: 80 });
    const mine = pc.entries().find((e) => e.name === 'My low cut');
    pc.load(mine);
    expect(pc.label()).toBe('My low cut');
    pc.step(1); // wraps from the last entry to the first
    expect(pc.label()).toBe('Default');
    pc.step(-1);
    expect(pc.label()).toBe('My low cut');
    const items = pc.menuItems();
    expect(items.filter((i) => i.type === 'heading').map((i) => i.label)).toEqual(['Built-in', 'My presets']);
    expect(items.some((i) => i.label === 'Rename preset...')).toBe(true);
    expect(items.find((i) => i.checked)?.label).toBe('My low cut');
  });
});
