// Round-two shell review, second pass: storage ordering, shortcuts inside
// dialogs, panel fields and accessibility.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setPuterForTests } from '../src/app/puter.js';
import * as storage from '../src/app/storage.js';
import { LibDoc, LibEditor } from '../src/editors/lib-editor.js';
import { findComponent } from '../src/model/library/builtin.js';
import { UserLibrary } from '../src/app/user-library.js';
import { App } from '../src/app/app.js';
import { Project, newProjectData } from '../src/model/project.js';
import { isMac } from '../src/ui/dom.js';
import { closeMenus } from '../src/ui/menu.js';
import { MessagesPanel } from '../src/ui/panels/messages.js';
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

describe('layer stack dialog', () => {
  const button = (label) =>
    [...document.querySelectorAll('.dialog')]
      .at(-1)
      .querySelector('.dialog-foot')
      .querySelectorAll('button')
      .values()
      .find((b) => b.textContent === label);

  it('changes nothing when removing the inner layers is cancelled', async () => {
    const app = await boot();
    app.setProject(new Project(newProjectData('Stack')), null);
    app.openDoc(app.project.docs.find((d) => d.kind === 'pcb').id);
    const ed = app.activeEditor;
    await app.setCopperLayers(4);
    ed.doc.store.transact('Track', (s) =>
      s.add({ t: 'track', layer: 'in1', w: 250000, x1: 0, y1: 0, x2: 5000000, y2: 0 }),
    );
    const thickness = ed.doc.board.thickness;
    app.editLayerStack();
    const dialog = document.querySelector('.dialog');
    const [layers, thick] = dialog.querySelectorAll('select, input');
    layers.value = '2';
    thick.value = '0.8';
    button('Apply').click();
    await tick();
    expect(document.querySelectorAll('.dialog').length).toBe(2);
    button('Cancel').click();
    await tick();
    await tick();
    expect(ed.doc.board.copper).toBe(4);
    expect(ed.doc.board.thickness).toBe(thickness);
    // The layer stack dialog stays open so the choice can be changed.
    expect(document.querySelectorAll('.dialog').length).toBe(1);
    expect(document.querySelector('.dialog').contains(document.activeElement)).toBe(true);
    button('Cancel').click();
    shutDown(app);
  });
});

describe('dialogs that refuse a value', () => {
  const footButton = (label) =>
    [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === label);

  it('Preferences says what is wrong with the autosave interval', async () => {
    const app = await boot();
    app.preferences();
    const field = document.querySelector('.dialog input[type=number]');
    field.value = '99';
    footButton('Save').click();
    await tick();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const alert = document.querySelector('.dialog [role=alert]');
    expect(alert?.textContent).toMatch(/Autosave.*0 to 60/);
    expect(app.settings.get('autosaveMinutes')).not.toBe(99);
    footButton('Cancel').click();
    shutDown(app);
  });

  it('Layer stack says what is wrong with the thickness', async () => {
    const app = await boot();
    app.setProject(new Project(newProjectData('Stack')), null);
    app.openDoc(app.project.docs.find((d) => d.kind === 'pcb').id);
    app.editLayerStack();
    const field = document.querySelector('.dialog input');
    field.value = 'thick';
    footButton('Apply').click();
    await tick();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('.dialog [role=alert]')?.textContent).toMatch(/Board thickness/);
    footButton('Cancel').click();
    shutDown(app);
  });
});

describe('component editor status line', () => {
  it('is not announced again when an edit leaves it unchanged', async () => {
    const project = new Project(newProjectData('Lib'));
    const def = structuredClone(findComponent('res-0603'));
    project.putComponent(def);
    const noop = () => {};
    const app = {
      settings: { get: () => undefined, on: () => () => {} },
      commands: { run: noop },
      toast: noop,
      renderTabs: noop,
      updateTitle: noop,
      updateStatus: noop,
      refreshMenus: noop,
      updateActiveBar: noop,
    };
    const ed = new LibEditor(app, project, new LibDoc({ def }));
    ed._renderStatus();
    const line = ed.statusLine;
    expect(line.getAttribute('aria-live')).toBe('polite');
    const text = line.textContent;
    // A live region is read out whenever its content is replaced, even by the same words.
    let changes = 0;
    const seen = new MutationObserver((list) => (changes += list.length));
    seen.observe(line, { childList: true, characterData: true, subtree: true });
    ed._renderStatus();
    ed._renderStatus();
    await tick();
    expect(line.textContent).toBe(text);
    expect(changes).toBe(0);
    // A new problem still shows.
    ed.doc.symStore.transact('Remove pins', (s) => {
      for (const o of [...ed.doc.symStore.all()]) if (o.t === 'pin') s.remove(o.id);
    });
    ed._renderStatus();
    await tick();
    expect(line.textContent).not.toBe(text);
    expect(changes).toBeGreaterThan(0);
    seen.disconnect();
  });
});

describe('Messages rows', () => {
  it('have a name that contains everything the row shows', () => {
    const app = {
      project: { getDoc: () => ({ name: 'Board1.pcb' }) },
      focusMessage: () => {},
      setBottomDock: () => {},
    };
    const panel = new MessagesPanel(app);
    document.body.innerHTML = '<main></main>';
    document.querySelector('main').append(panel.el);
    panel.set([{ severity: 'error', message: 'Clearance violation', docId: 'd1' }], 'DRC');
    const row = panel.el.querySelector('.list-row');
    // An aria-label that leaves out part of the visible text breaks voice
    // control ("click Board1.pcb"); the row is named by what it contains.
    expect(row.hasAttribute('aria-label')).toBe(false);
    expect(row.getAttribute('role')).toBe('button');
    expect(row.querySelector('.sr-only').textContent).toBe('error: ');
    expect(row.textContent).toBe('error: Clearance violationBoard1.pcb');
    document.body.innerHTML = '';
  });
});

describe('SVG export file names', () => {
  it('leave out the document extension, like the other exports', async () => {
    const app = await boot();
    app.setProject(new Project(newProjectData('Names')), null);
    const names = [];
    URL.createObjectURL ??= () => 'blob:test';
    URL.revokeObjectURL ??= () => {};
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      names.push(this.download);
    });
    for (const doc of app.project.docs) {
      app.openDoc(doc.id);
      await app.exportSvg();
    }
    expect(app.project.docs.map((d) => d.name)).toEqual(['Sheet1.sch', 'Board1.pcb']);
    expect(names).toEqual(['Sheet1.svg', 'Board1.svg']);
    // A dot inside a name is not an extension.
    app.project.renameDoc(app.project.docs[0].id, 'Rev 1.2 power');
    app.openDoc(app.project.docs[0].id);
    await app.exportSvg();
    expect(names.at(-1)).toBe('Rev 1.2 power.svg');
    vi.restoreAllMocks();
    shutDown(app);
  });
});

describe('My library after signing out', () => {
  it('no longer lists the account’s components, nor saves them in the browser', async () => {
    const PATH = 'Libraries/My components.circuitslib';
    const def = (id) => ({ id, name: id, symbol: { pins: [], graphics: [] }, footprint: null });
    const cloudFiles = new Map([
      [PATH, JSON.stringify({ format: 'circuits-library', version: 1, components: [def('mine')] })],
    ]);
    const missing = () =>
      Object.assign(new Error('subject_does_not_exist'), { code: 'subject_does_not_exist' });
    let signedIn = true;
    const fake = {
      env: 'web',
      auth: {
        isSignedIn: () => signedIn,
        getUser: async () => ({ username: 'ada' }),
        signOut: async () => void (signedIn = false),
      },
      fs: {
        read: async (path) => {
          if (!cloudFiles.has(path)) throw missing();
          return new Blob([cloudFiles.get(path)]);
        },
        write: async (path, text) => (cloudFiles.set(path, text), { path }),
        readdir: async () => [],
      },
    };
    // The browser's own storage, where a signed-out library is kept.
    const local = new Map();
    const root = {
      async getFileHandle(name, { create } = {}) {
        if (!local.has(name)) {
          if (!create) throw new DOMException('missing', 'NotFoundError');
          local.set(name, '');
        }
        return {
          getFile: async () => ({ text: async () => local.get(name) }),
          createWritable: async () => {
            let next = '';
            return {
              write: async (t) => void (next += t),
              close: async () => void local.set(name, next),
            };
          },
        };
      },
      getDirectoryHandle: async () => root,
    };
    document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
    localStorage.clear();
    setPuterForTests(fake);
    Object.defineProperty(navigator, 'storage', {
      value: { getDirectory: async () => root },
      configurable: true,
    });
    const app = new App(document.getElementById('app'), { puterTimeout: 10 });
    await app.init();
    for (let i = 0; i < 5; i++) await tick();
    expect(app.userLibrary.all().map((d) => d.id)).toEqual(['mine']);

    await app.signOut();
    for (let i = 0; i < 5; i++) await tick();
    expect(app.userLibrary.all().map((d) => d.id)).toEqual([]);
    await app.userLibrary.put(def('guest'));
    const saved = JSON.parse(local.get('my-components.circuitslib'));
    expect(saved.components.map((c) => c.id)).toEqual(['guest']);
    setPuterForTests(null);
    shutDown(app);
  });
});

describe('starting while puter.js is slow to load', () => {
  it('keeps the project opened meanwhile instead of reopening the last one over it', async () => {
    const root = memoryDir();
    const start = async (puterTimeout) => {
      document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
      setPuterForTests(null);
      delete window.puter;
      delete window.__puterFailed;
      Object.defineProperty(navigator, 'storage', {
        value: { getDirectory: async () => root },
        configurable: true,
      });
      const app = new App(document.getElementById('app'), { puterTimeout });
      return { app, ready: app.init() };
    };
    localStorage.clear();
    // An earlier visit left a project to reopen.
    const first = await start(10);
    await first.ready;
    const project = new Project(newProjectData('Last time'));
    first.app.setProject(project, await storage.newLocation('Last time', project.id));
    await first.app.save({ quiet: true });
    first.app.kernel.dispose();

    const second = await start(150);
    await tick();
    expect(second.app.project).toBe(null);
    await second.app.openExample();
    const example = second.app.project;
    await second.ready;
    expect(second.app.project).toBe(example);
    shutDown(second.app);

    // Left alone, it does reopen the last project.
    const third = await start(10);
    await third.ready;
    expect(third.app.project?.name).toBe('Last time');
    shutDown(third.app);
  });
});

describe('printing and SVG export in the component editor', () => {
  it('are unavailable instead of producing a page that says "null"', async () => {
    const app = await boot();
    app.setProject(new Project(newProjectData('Parts')), null);
    const def = structuredClone(findComponent('res-0603'));
    app.project.putComponent(def);
    app.openComponentEditor(def.id);
    expect(app.activeEditor.kind).toBe('lib');
    const saved = [];
    URL.createObjectURL ??= () => 'blob:test';
    URL.revokeObjectURL ??= () => {};
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => (saved.push(blob), 'blob:x'));
    await app.commands.run('export.svg');
    await app.exportSvg();
    await app.print();
    expect(saved).toEqual([]);
    expect(document.querySelector('iframe[title="Print preview"]')).toBe(null);
    expect(app.commands.get('export.svg').enabled()).toBe(false);
    expect(app.commands.get('file.print').enabled()).toBe(false);
    // Still available on a sheet.
    app.openDoc(app.project.docs[0].id);
    expect(app.commands.get('export.svg').enabled()).toBe(true);
    expect(app.commands.get('file.print').enabled()).toBe(true);
    vi.restoreAllMocks();
    shutDown(app);
  });
});
