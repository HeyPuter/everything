// Shell review regressions: menus, dialogs, panels, storage and saving.
import { describe, it, expect, afterEach } from 'vitest';
import { openMenu, closeMenus, createMenubar } from '../src/ui/menu.js';
import { PropertiesPanel } from '../src/ui/panels/properties.js';
import { App } from '../src/app/app.js';
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
  return { root, getDirectory: async () => root };
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
