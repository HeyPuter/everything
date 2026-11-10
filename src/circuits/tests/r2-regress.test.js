// Regressions found when the round-two fixes were reviewed together.
import { describe, it, expect, afterEach } from 'vitest';
import { closeMenus } from '../src/ui/menu.js';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import * as storage from '../src/app/storage.js';
import { Project, newProjectData } from '../src/model/project.js';

/**
 * In-memory Origin Private File System, enough for storage.js and history.js.
 * `holdWrites` and `holdReads` are promises the next write or read waits for.
 */
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
          kids.set(name, file(name));
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
  const file = (name) => {
    const f = { text: '', at: Date.now() };
    return {
      f,
      async getFile() {
        const text = async () => {
          await opfs.holdReads?.[name];
          return f.text;
        };
        return { text, size: f.text.length, lastModified: f.at };
      },
      async createWritable() {
        let next = '';
        return {
          write: async (t) => {
            await opfs.holdWrites;
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
  const opfs = { root, holdWrites: null, holdReads: null, getDirectory: async () => root };
  return opfs;
}

async function bootLocal() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
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
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Saves a project named `name` in the browser and returns it with its location. */
async function stored(app, name) {
  const project = new Project(newProjectData(name));
  const location = await storage.newLocation(name, project.id);
  app.setProject(project, location);
  await app.save({ quiet: true });
  return { project, location };
}

afterEach(() => {
  closeMenus();
  document.body.innerHTML = '';
});

describe('opening another project with unsaved changes', () => {
  const dialogs = () => [...document.querySelectorAll('.dialog')].filter((d) => /Unsaved changes/.test(d.textContent));
  const press = (label) => [...dialogs()[0].querySelectorAll('button')].find((b) => b.textContent === label).click();

  it('asks about discarding them once, not again when the file has loaded', async () => {
    const { app } = await bootLocal();
    const next = await stored(app, 'Next');
    // A project that was never saved (the example, say), then edited.
    const draft = new Project(newProjectData('Draft'));
    app.setProject(draft, null);
    draft.rename('Draft, edited');
    const opening = app.openLocation(next.location);
    await tick(5);
    expect(dialogs()).toHaveLength(1);
    press('Discard changes');
    await tick(20);
    expect(dialogs()).toHaveLength(0);
    expect(await opening).toBe(true);
    expect(app.project.name).toBe('Next');
    app.kernel.dispose();
  });

  it('still asks about edits made after the first answer, while the file loads', async () => {
    const { app, opfs } = await bootLocal();
    const next = await stored(app, 'Next');
    const draft = new Project(newProjectData('Draft'));
    app.setProject(draft, null);
    draft.rename('Draft, edited');
    const hold = deferred();
    opfs.holdReads = { [`${next.location.id}${storage.EXT}`]: hold.promise };
    const opening = app.openLocation(next.location);
    await tick(5);
    press('Discard changes');
    await tick(5);
    draft.rename('Draft, edited again');
    hold.resolve();
    await tick(20);
    expect(dialogs()).toHaveLength(1);
    press('Cancel');
    expect(await opening).toBe(false);
    expect(app.project).toBe(draft);
    app.kernel.dispose();
  });
});

describe('design rules dialog', () => {
  it('keeps its error line out of the way until there is an error', async () => {
    const { rulesDialog } = await import('../src/app/dialogs.js');
    const { defaultRules } = await import('../src/model/schema.js');
    document.body.innerHTML = '<div id="live-region"></div>';
    const ed = { doc: { rules: defaultRules(), nets: {}, store: { transact() {} } } };
    rulesDialog({ settings: { get: () => 'mm' } }, ed);
    await tick(5);
    const alert = document.querySelector('.dialog [role=alert]');
    expect(alert.textContent).toBe('');
    // Box styles of its own would cover the last rule shown above the buttons.
    expect(alert.style.padding).toBe('');
    expect(alert.style.background).toBe('');
    expect(alert.classList.contains('dialog-error')).toBe(true);
  });
});
