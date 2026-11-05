// Shell review regressions: menus, dialogs, panels, storage and saving.
import { describe, it, expect, afterEach } from 'vitest';
import { openMenu, closeMenus, createMenubar } from '../src/ui/menu.js';
import { PropertiesPanel } from '../src/ui/panels/properties.js';
import { App } from '../src/app/app.js';
import { comboOf } from '../src/app/commands.js';
import { setPuterForTests } from '../src/app/puter.js';
import * as storage from '../src/app/storage.js';
import { openProjectDialog } from '../src/app/dialogs.js';
import { Project, newProjectData } from '../src/model/project.js';

/** In-memory Origin Private File System, enough for storage.js and history.js. */
function memoryOpfs() {
  const dir = () => {
    const kids = new Map();
    return {
      kids,
      async getDirectoryHandle(name, { create } = {}) {
        if (!kids.has(name)) {
          if (!create) throw new DOMException('missing', 'NotFoundError');
          kids.set(name, dir());
        }
        return kids.get(name);
      },
      async getFileHandle(name, { create } = {}) {
        if (!kids.has(name)) {
          if (!create) throw new DOMException('missing', 'NotFoundError');
          kids.set(name, file());
        }
        return kids.get(name);
      },
      async removeEntry(name) {
        if (!kids.delete(name)) throw new DOMException('missing', 'NotFoundError');
      },
      async *entries() {
        yield* kids.entries();
      },
    };
  };
  const file = () => {
    const f = { text: '', at: Date.now() };
    return {
      f,
      async getFile() {
        return { text: async () => f.text, size: f.text.length, lastModified: f.at };
      },
      async createWritable() {
        let next = '';
        return {
          write: async (t) => {
            if (opfs.failWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
            next += t;
          },
          close: async () => {
            f.text = next;
            f.at = Date.now();
          },
          abort: async () => {},
        };
      },
    };
  };
  const root = dir();
  const opfs = { root, failWrites: false, getDirectory: async () => root };
  return opfs;
}

async function bootLocal() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  delete window.puter;
  const opfs = memoryOpfs();
  Object.defineProperty(navigator, 'storage', {
    value: { getDirectory: opfs.getDirectory },
    configurable: true,
  });
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  return { app, opfs };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  closeMenus();
  document.body.innerHTML = '';
});

const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('menu focus', () => {
  it('returns focus to where it was when a chord menu is closed with Escape', () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.append(canvas);
    const bar = createMenubar();
    document.body.append(bar.el);
    bar.setMenus([{ label: '&Place', items: [{ label: '&Wire', run: () => {} }] }]);
    canvas.focus();
    expect(bar.openByAccel('p')).toBe(true);
    expect(document.activeElement.classList.contains('menu-item')).toBe(true);
    key(document.activeElement, 'Escape');
    expect(document.querySelector('.menu')).toBeNull();
    expect(document.activeElement).toBe(canvas);
  });

  it('restores focus before running the chosen item', () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.append(canvas);
    canvas.focus();
    let focusedDuringRun = null;
    openMenu(
      [
        {
          label: '&Go',
          run: () => {
            focusedDuringRun = document.activeElement;
          },
        },
      ],
      { x: 0, y: 0 },
    );
    key(document.activeElement, 'Enter');
    expect(focusedDuringRun).toBe(canvas);
    expect(document.activeElement).toBe(canvas);
  });

  it('keeps the menubar button focused when the menu was opened from it', () => {
    const bar = createMenubar();
    document.body.append(bar.el);
    bar.setMenus([{ label: '&File', items: [{ label: '&New', run: () => {} }] }]);
    const btn = bar.el.querySelector('button');
    btn.focus();
    key(btn, 'Enter');
    key(document.activeElement, 'Escape');
    expect(document.activeElement).toBe(btn);
  });
});

describe('properties panel fields', () => {
  const fakeApp = () => ({
    settings: { get: () => 'mm' },
    activeEditor: null,
    toast: () => {},
  });
  const mount = (spec) => {
    const panel = new PropertiesPanel(fakeApp());
    const changes = [];
    const [, input] = panel._field({ ...spec, onChange: (v) => changes.push(v) });
    const el = input.querySelector?.('input') || input;
    document.body.append(panel.el, input);
    return { el, changes };
  };

  it('Escape puts back a number without applying it', () => {
    const { el, changes } = mount({ label: 'Rotation', type: 'angle', value: 90 });
    el.focus();
    el.value = '45';
    el.dispatchEvent(new Event('input'));
    key(el, 'Escape');
    el.dispatchEvent(new Event('change'));
    expect(el.value).toBe('90');
    expect(changes).toEqual([]);
  });

  it('Enter applies a changed number once, and an unchanged one not at all', () => {
    const { el, changes } = mount({ label: 'Rotation', type: 'angle', value: 90 });
    el.focus();
    key(el, 'Enter');
    expect(changes).toEqual([]);
    el.value = '180';
    key(el, 'Enter');
    el.dispatchEvent(new Event('change'));
    expect(changes).toEqual([180]);
  });

  it('an invalid entry shows the real value again on blur', () => {
    const { el, changes } = mount({ label: 'X', type: 'length', value: 10_000_000 });
    el.focus();
    el.value = 'abc';
    el.dispatchEvent(new Event('change'));
    expect(el.getAttribute('aria-invalid')).toBe('true');
    el.blur();
    expect(el.value).toBe('10');
    expect(el.getAttribute('aria-invalid')).toBe('false');
    expect(changes).toEqual([]);
  });

  it('Escape in a live text field restores and applies the original text', () => {
    const { el, changes } = mount({ label: 'Designator', type: 'text', value: 'R1' });
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input'));
    key(el, 'Escape');
    expect(el.value).toBe('R1');
    expect(changes).toEqual(['', 'R1']);
  });
});

describe('projects in this browser', () => {
  it('closes the open project when it is deleted, so autosave cannot bring it back', async () => {
    localStorage.clear();
    const { app } = await bootLocal();
    const project = new Project(newProjectData('Alpha'));
    app.setProject(project, await storage.newLocation('Alpha', project.id));
    await app.save();
    expect((await storage.listProjects()).map((p) => p.name)).toEqual(['Alpha']);
    openProjectDialog(app);
    await tick(10);
    document.querySelector('[aria-label="Delete Alpha"]').click();
    await tick(10);
    const confirm = [...document.querySelectorAll('.dialog')].pop();
    expect(confirm.textContent).toContain('It is open now and will be closed');
    confirm.querySelector('.btn.danger').click();
    await tick(10);
    expect(app.project).toBeNull();
    expect(await storage.listProjects()).toEqual([]);
    expect(storage.recentProjects()).toEqual([]);
    expect(app.start?.textContent).not.toContain('Alpha');
  });
});

describe('key combos', () => {
  const ev = (key, code, o = {}) => new KeyboardEvent('keydown', { key, code, ...o });
  it('reads Option+letter on macOS by the physical key', () => {
    expect(comboOf(ev('∑', 'KeyW', { altKey: true }))).toBe('Alt+W');
    expect(comboOf(ev('Dead', 'KeyE', { altKey: true }))).toBe('Alt+E');
    expect(comboOf(ev('w', 'KeyW', { altKey: true }))).toBe('Alt+W');
    expect(comboOf(ev('PageDown', 'PageDown', { altKey: true }))).toBe('Alt+PageDown');
    expect(comboOf(ev('*', 'Digit8', { shiftKey: true }))).toBe('*');
  });
});

describe('Puter SDK loading', () => {
  it('stops waiting as soon as the SDK script fails to load', async () => {
    const { loadPuter } = await import('../src/app/puter.js');
    setPuterForTests(null);
    delete window.puter;
    window.__puterFailed = true;
    // Without the check this would wait the full minute and the test time out.
    try {
      expect(await loadPuter(60_000)).toBeNull();
    } finally {
      delete window.__puterFailed;
    }
  });
});

describe('saving', () => {
  it('reports a new autosave failure after a successful save', async () => {
    localStorage.clear();
    const { app, opfs } = await bootLocal();
    const project = new Project(newProjectData('Beta'));
    app.setProject(project, await storage.newLocation('Beta', project.id));
    const errors = () => document.querySelectorAll('.toast.error').length;
    opfs.failWrites = true;
    project.rename('Beta 1');
    expect(await app.save({ auto: true })).toBe(false);
    expect(errors()).toBe(1);
    project.rename('Beta 2');
    await app.save({ auto: true });
    expect(errors()).toBe(1); // not repeated for the same problem
    opfs.failWrites = false;
    expect(await app.save({ auto: true })).toBe(true);
    opfs.failWrites = true;
    project.rename('Beta 3');
    await app.save({ auto: true });
    expect(errors()).toBe(2);
    expect(app.saveBadge.textContent).toBe('Not saved');
  });
});

describe('opening a file from the device', () => {
  /** Makes the next file input "choose" these files. */
  function chooseFiles(files) {
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      HTMLInputElement.prototype.click = orig;
      Object.defineProperty(this, 'files', { value: files });
      this.dispatchEvent(new Event('change'));
    };
  }

  it('gives the opened copy its own identity, so it never overwrites the original', async () => {
    localStorage.clear();
    const { app } = await bootLocal();
    const project = new Project(newProjectData('Gamma'));
    app.setProject(project, await storage.newLocation('Gamma', project.id));
    await app.save();
    const backup = JSON.stringify(project.toJSON());
    project.rename('Gamma edited');
    await app.save();
    chooseFiles([new File([backup], 'Gamma.circuits')]);
    await app.importFromDevice();
    expect(app.project.name).toBe('Gamma');
    expect(app.project.id).not.toBe(project.id);
    const names = (await storage.listProjects()).map((p) => p.name).sort();
    expect(names).toEqual(['Gamma', 'Gamma edited']);
  });

  it('explains a damaged file without asking to leave the open project', async () => {
    localStorage.clear();
    const { app } = await bootLocal();
    const project = new Project(newProjectData('Delta'));
    app.setProject(project, null);
    project.rename('Delta 2'); // unsaved changes, nowhere to save them
    chooseFiles([new File(['{"format": nope'], 'broken.circuits')]);
    await app.importFromDevice();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.toast.error').textContent).toContain(
      'not a Circuits project, or it is damaged',
    );
    expect(app.project).toBe(project);
  });
});

describe('save a copy', () => {
  it('leaves the project untouched when the copy has nowhere to go', async () => {
    localStorage.clear();
    const { app } = await bootLocal();
    const project = new Project(newProjectData('Omega'));
    const original = { type: 'cloud', path: 'Projects/Omega.circuits' };
    app.setProject(project, original);
    const id = project.id;
    // Signed in, but the cloud folder cannot be listed right now.
    setPuterForTests({
      env: 'web',
      auth: { isSignedIn: () => true },
      fs: {
        readdir: async () => {
          throw new Error('Network error');
        },
      },
    });
    try {
      const done = app.saveAs();
      await tick(30);
      document.querySelector('.dialog input').value = 'Omega copy';
      document.querySelector('.dialog .btn.primary').click();
      await done;
    } finally {
      setPuterForTests(null);
    }
    expect(project.name).toBe('Omega');
    expect(project.id).toBe(id);
    expect(app.location).toEqual(original);
    expect(document.querySelector('.toast.error').textContent).toContain('Network error');
  });
});

describe('removing a document', () => {
  it('does not promise that closing without saving brings it back', async () => {
    localStorage.clear();
    const { app } = await bootLocal();
    const project = new Project(newProjectData('Sigma'));
    app.setProject(project, await storage.newLocation('Sigma', project.id));
    const doc = project.docs[0];
    app.panels.projects
      ._docMenu(doc)
      .find((i) => /move from/.test(i.label))
      .run();
    await tick(10);
    const text = document.querySelector('.dialog').textContent;
    expect(text).not.toContain('without saving');
    expect(text).toContain('cannot be undone');
  });
});

describe('panel drawers', () => {
  it('Escape closes an open drawer on tablets and phones', async () => {
    localStorage.clear();
    const { app } = await bootLocal();
    app.compactQuery = { matches: true, addEventListener() {} };
    app._toggleDrawer('right');
    expect(app.workspace.classList.contains('show-right')).toBe(true);
    const btn = app.rightDock.el.querySelector('button');
    btn.focus();
    key(btn, 'Escape');
    expect(app.workspace.classList.contains('show-right')).toBe(false);
    expect(app.scrim.hidden).toBe(true);
  });
});

describe('editor lifetime', () => {
  it('closing and reopening a document does not pile up listeners on its store', async () => {
    localStorage.clear();
    const { app } = await bootLocal();
    const project = new Project(newProjectData('Tau'));
    const board = project.boards[0];
    let active = 0;
    const on = board.store.on.bind(board.store);
    board.store.on = (type, fn) => {
      const off = on(type, fn);
      active++;
      let done = false;
      return () => {
        if (!done) active--;
        done = true;
        return off();
      };
    };
    app.setProject(project, null);
    for (let i = 0; i < 5; i++) {
      app.openDoc(board.id);
      await app.closeTab(board.id);
    }
    expect(active).toBe(0);
  });
});

describe('theme button', () => {
  it('shows the chosen theme even when the colours stay the same', async () => {
    localStorage.clear();
    const { app } = await bootLocal();
    expect(app.themeBtn.getAttribute('aria-label')).toBe('Theme: match system');
    app.commands.run('theme.light'); // the system is light in tests, so nothing repaints
    expect(app.themeBtn.getAttribute('aria-label')).toBe('Theme: light');
    app.commands.run('theme.system');
    expect(app.themeBtn.getAttribute('aria-label')).toBe('Theme: match system');
  });
});
