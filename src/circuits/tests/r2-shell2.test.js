// Round-two shell review, second pass: storage ordering, shortcuts inside
// dialogs, panel fields and accessibility.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setPuterForTests } from '../src/app/puter.js';
import { UserLibrary } from '../src/app/user-library.js';
import { PropertiesPanel } from '../src/ui/panels/properties.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('My library with slow storage', () => {
  const PATH = 'Libraries/My components.circuitslib';
  const def = (id) => ({ id, name: id, symbol: { pins: [], graphics: [] }, footprint: null });
  const idsIn = (text) =>
    JSON.parse(text)
      .components.map((c) => c.id)
      .sort();

  /** A cloud whose reads and writes finish only when the test releases them. */
  function slowCloud(initial) {
    const files = new Map(initial ? [[PATH, initial]] : []);
    const writes = [];
    const reads = [];
    const fs = {
      read(path) {
        return new Promise((resolve, reject) => {
          reads.push(() => {
            if (files.has(path)) resolve(new Blob([files.get(path)]));
            else
              reject(
                Object.assign(new Error('subject_does_not_exist'), {
                  code: 'subject_does_not_exist',
                }),
              );
          });
        });
      },
      write(path, text) {
        return new Promise((resolve) => {
          writes.push(() => {
            files.set(path, text);
            resolve({ path });
          });
        });
      },
    };
    setPuterForTests({ env: 'web', auth: { isSignedIn: () => true }, fs });
    return { files, writes, reads };
  }

  afterEach(() => {
    setPuterForTests(null);
    vi.restoreAllMocks();
  });

  it('stores both components when two are added quickly and the first write is slow', async () => {
    const cloud = slowCloud();
    const lib = new UserLibrary();
    const loading = lib.load();
    await tick();
    cloud.reads.shift()();
    await loading;
    const a = lib.put(def('a'));
    const b = lib.put(def('b'));
    // Release whatever writes are pending newest first, as a slow network may.
    for (let i = 0; i < 6; i++) {
      await tick();
      while (cloud.writes.length) cloud.writes.pop()();
    }
    await Promise.all([a, b]);
    expect(idsIn(cloud.files.get(PATH))).toEqual(['a', 'b']);
  });

  it('keeps the stored components when one is added while the library is loading', async () => {
    const stored = JSON.stringify({
      format: 'circuits-library',
      version: 1,
      components: [def('old-1'), def('old-2')],
    });
    const cloud = slowCloud(stored);
    const lib = new UserLibrary();
    const loading = lib.load();
    await tick();
    const adding = lib.put(def('new'));
    await tick();
    while (cloud.writes.length) cloud.writes.pop()();
    await tick();
    cloud.reads.shift()();
    await loading;
    for (let i = 0; i < 6; i++) {
      await tick();
      while (cloud.writes.length) cloud.writes.pop()();
    }
    await adding;
    expect(idsIn(cloud.files.get(PATH))).toEqual(['new', 'old-1', 'old-2']);
    expect(
      lib
        .all()
        .map((d) => d.id)
        .sort(),
    ).toEqual(['new', 'old-1', 'old-2']);
  });
});

describe('properties panel fields while composing text', () => {
  const mount = (spec) => {
    const panel = new PropertiesPanel({
      settings: { get: () => 'mm' },
      activeEditor: null,
      toast: () => {},
    });
    const changes = [];
    const [, input] = panel._field({ ...spec, onChange: (v) => changes.push(v) });
    const el = input.querySelector?.('input') || input;
    document.body.append(panel.el, input);
    return { el, changes };
  };
  const key = (el, k, init) => {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    return ev;
  };

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('leaves the Enter that confirms a composition to the input method', () => {
    const { el, changes } = mount({ label: 'Rotation', type: 'angle', value: 90 });
    el.focus();
    el.value = '45';
    expect(key(el, 'Enter', { isComposing: true }).defaultPrevented).toBe(false);
    expect(key(el, 'Enter', { keyCode: 229 }).defaultPrevented).toBe(false);
    expect(changes).toEqual([]);
    key(el, 'Enter');
    expect(changes).toEqual([45]);
  });

  it('leaves the Escape that cancels a composition to the input method', () => {
    const { el, changes } = mount({ label: 'Comment', type: 'text', value: 'abc' });
    el.focus();
    el.value = 'abcd';
    el.dispatchEvent(new Event('input'));
    expect(key(el, 'Escape', { isComposing: true }).defaultPrevented).toBe(false);
    expect(el.value).toBe('abcd');
    expect(document.activeElement).toBe(el);
    expect(changes).toEqual(['abcd']);
  });
});
