// Round-two shell review, second pass: storage ordering, shortcuts inside
// dialogs, panel fields and accessibility.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setPuterForTests } from '../src/app/puter.js';
import * as storage from '../src/app/storage.js';
import { UserLibrary } from '../src/app/user-library.js';
import { App } from '../src/app/app.js';
import { Project, newProjectData } from '../src/model/project.js';
import { isMac } from '../src/ui/dom.js';
import { closeMenus } from '../src/ui/menu.js';
import { PropertiesPanel } from '../src/ui/panels/properties.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The app as a signed-out visitor sees it, in a browser without private storage. */
async function boot() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
  setPuterForTests(null);
  delete window.puter;
  Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  return app;
}
const shutDown = (app) => {
  app.kernel.dispose();
  closeMenus();
  document.body.innerHTML = '';
};

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

describe('document name in the Properties panel', () => {
  it('refuses a name another document already has', async () => {
    const app = await boot();
    app.setProject(new Project(newProjectData('Named')), null);
    const docs = app.project.docs;
    expect(docs.length).toBeGreaterThan(1);
    const [first, other] = docs;
    app.openDoc(first.id);
    app.activeEditor.clearSelection?.();
    app.panels.properties.refresh(true);
    const label = [...app.panels.properties.el.querySelectorAll('label')].find(
      (l) => l.textContent === 'Name',
    );
    const input = document.getElementById(label.htmlFor);
    expect(input.value).toBe(first.name);
    const before = first.name;
    input.focus();
    input.value = other.name.toUpperCase();
    input.dispatchEvent(new Event('input'));
    expect(first.name).toBe(before);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.value = 'Renamed here';
    input.dispatchEvent(new Event('input'));
    expect(first.name).toBe('Renamed here');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    shutDown(app);
  });
});

describe('app shortcuts while a dialog is open', () => {
  const press = (el, key, init = {}) => {
    const ev = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      [isMac ? 'metaKey' : 'ctrlKey']: true,
      ...init,
    });
    el.dispatchEvent(ev);
    return ev;
  };

  it('keeps Save, Open and Print from reaching the browser, without running them', async () => {
    const app = await boot();
    app.setProject(new Project(newProjectData('Keys')), null);
    const ran = [];
    app.commands.on('ran', ({ id }) => ran.push(id));
    app.preferences();
    const field = document.querySelector('.dialog select');
    expect(field).toBeTruthy();
    for (const key of ['s', 'o', 'p', 'k']) expect(press(field, key).defaultPrevented).toBe(true);
    expect(press(field, 'S', { shiftKey: true }).defaultPrevented).toBe(true);
    // Text editing keys stay with the field.
    const text = document.querySelector('.dialog input[type=number]');
    for (const key of ['c', 'v', 'x', 'a', 'z'])
      expect(press(text, key).defaultPrevented).toBe(false);
    expect(ran).toEqual([]);
    expect(document.querySelectorAll('.dialog').length).toBe(1);
    document.querySelector('.dialog [aria-label="Close dialog"]').click();
    shutDown(app);
  });
});

describe('a project saved in the browser when the project list cannot be written', () => {
  /** Minimal in-memory private file system. */
  function memoryDir() {
    const kids = new Map();
    return {
      async getDirectoryHandle(name) {
        if (!kids.has(name)) kids.set(name, memoryDir());
        return kids.get(name);
      },
      async getFileHandle(name, { create } = {}) {
        if (!kids.has(name)) {
          if (!create) throw new DOMException('missing', 'NotFoundError');
          const f = { text: '' };
          kids.set(name, {
            getFile: async () => ({
              text: async () => f.text,
              size: f.text.length,
              lastModified: 1234,
            }),
            createWritable: async () => {
              let next = '';
              return {
                write: async (t) => void (next += t),
                close: async () => void (f.text = next),
              };
            },
          });
        }
        return kids.get(name);
      },
      async *entries() {
        yield* kids.entries();
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('is still listed, so it can be opened again', async () => {
    setPuterForTests(null);
    localStorage.clear();
    const root = memoryDir();
    Object.defineProperty(navigator, 'storage', {
      value: { getDirectory: async () => root },
      configurable: true,
    });
    // The browser refuses the write, as when its site storage is full.
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const text = JSON.stringify({ format: 'circuits-project', id: 'p1', name: 'Amplifier' });
    await storage.saveText({ type: 'local', id: 'p1' }, 'Amplifier', text);
    expect(await storage.loadText({ type: 'local', id: 'p1' })).toBe(text);
    const listed = await storage.listProjects();
    expect(listed.map((p) => [p.name, p.location])).toEqual([
      ['Amplifier', { type: 'local', id: 'p1' }],
    ]);
    // A project the list does know about is not listed twice.
    refuse.mockRestore();
    await storage.saveText({ type: 'local', id: 'p2' }, 'Second', '{"name":"Second"}');
    expect((await storage.listProjects()).map((p) => p.name).sort()).toEqual([
      'Amplifier',
      'Second',
    ]);
  });
});
