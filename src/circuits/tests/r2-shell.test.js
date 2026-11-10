// Round-two shell review regressions: project lifecycle races, dialogs,
// keyboard handling and panel accessibility.
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

describe('a save that finishes after another project opened', () => {
  it('does not point the open project at the saved project’s file', async () => {
    const { app, opfs } = await bootLocal();
    const b = await stored(app, 'Second');
    const a = await stored(app, 'First');
    const hold = deferred();
    opfs.holdWrites = hold.promise;
    const saving = app.save(); // nothing to save, but the write is slow
    await tick(5);
    expect(await app.openLocation(b.location)).toBe(true);
    expect(app.project.name).toBe('Second');
    hold.resolve();
    opfs.holdWrites = null;
    await saving;
    // The next save of Second must go to its own file, not over First.
    expect(app.location).toEqual(b.location);
    expect(JSON.parse(localStorage.getItem('circuits:last-project'))).toEqual(b.location);
    expect(app.saveBadge.textContent).toMatch(/^Saved/);
    app.project.rename('Second, edited');
    await app.save();
    expect(JSON.parse(await storage.loadText(a.location)).name).toBe('First');
    app.kernel.dispose();
  });
});
