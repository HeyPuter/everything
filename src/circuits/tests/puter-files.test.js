// Files from the Puter desktop: double click and "Open with" (launch items),
// and files dragged in from a desktop folder window (the SDK's drop event).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { newProjectData } from '../src/model/project.js';

const projectText = (name) => JSON.stringify(newProjectData(name));
const SCH = '(kicad_sch (version 20231120) (generator "eeschema") (paper "A4") (lib_symbols))';

/** A Puter SDK that, as the real one does, hands the launch items to the handler when it is registered. */
function sdk({ env = 'app', launch = [], files = {} } = {}) {
  const store = new Map(Object.entries(files));
  return {
    env,
    auth: { isSignedIn: () => true, getUser: async () => ({ username: 'ada' }), getProfilePicture: async () => null, signIn: async () => ({}), signOut: async () => {} },
    fs: {
      readdir: async () => [],
      write: async (path, data) => { store.set(path, typeof data === 'string' ? data : await data.text()); return { path, name: path.split('/').pop() }; },
      read: vi.fn(async (path) => {
        if (!store.has(path)) throw { code: 'subject_does_not_exist', message: 'Not found' };
        return new Blob([store.get(path)]);
      }),
      mkdir: async () => ({}),
      stat: async (path) => ({ path, name: path.split('/').pop() }),
    },
    kv: { get: async () => null, set: async () => true },
    ui: {
      wasLaunchedWithItems: () => launch.length > 0,
      onLaunchedWithItems: vi.fn((cb) => launch.length && cb(launch)),
    },
  };
}

const apps = [];
async function boot(mock) {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  window.puter = mock;
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  apps.push(app);
  await app.init();
  return app;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
/** Reads of the user's files (the component library is read at startup too). */
const reads = (mock) => mock.fs.read.mock.calls.map((c) => c[0]).filter((p) => p.startsWith('/ada/'));
const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('circuits:alpha-notice-seen', '1');
});
afterEach(() => {
  for (const a of apps.splice(0)) a.kernel.dispose();
  delete window.puter;
  setPuterForTests(null);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('files opened from the Puter desktop', () => {
  for (const env of ['app', 'web']) {
    it(`opens a double-clicked project where it lives (${env === 'app' ? 'desktop window' : 'browser tab'}), instead of the last project`, async () => {
      localStorage.setItem('circuits:last-project', JSON.stringify({ type: 'cloud', path: '/ada/Last.circuits' }));
      const mock = sdk({ env, launch: [{ name: 'Blinky.circuits', path: '/ada/Desktop/Blinky.circuits' }], files: { '/ada/Desktop/Blinky.circuits': projectText('Blinky'), '/ada/Last.circuits': projectText('Last') } });
      const app = await boot(mock);
      await settle();
      expect(app.project?.name).toBe('Blinky');
      expect(app.location).toEqual({ type: 'cloud', path: '/ada/Desktop/Blinky.circuits' });
      expect(reads(mock)).toEqual(['/ada/Desktop/Blinky.circuits']);
      expect(document.querySelector('.start-page')).toBeNull();
    });
  }

  it('skips folders and files it does not open without reading them, and shows the start page', async () => {
    const mock = sdk({ launch: [{ name: 'Boards', path: '/ada/Boards', is_dir: true }] });
    const app = await boot(mock);
    await settle();
    expect(toasts()).toMatch(/Folders cannot be opened/);
    expect(document.querySelector('.start-page')).not.toBeNull();
    expect(await app.openDriveItems([{ name: 'photo.png', path: '/ada/photo.png' }])).toBe(false);
    expect(toasts()).toMatch(/photo\.png is not a file Circuits opens\. Choose a Circuits project \(\.circuits\) or KiCad files/);
    expect(reads(mock)).toEqual([]);
    expect(app.project).toBeNull();
  });

  it('imports KiCad files opened together as one new project', async () => {
    const importKicad = vi.spyOn(App.prototype, 'importKicad').mockResolvedValue(true);
    const read = vi.fn(async () => new Blob([SCH]));
    const mock = sdk({ launch: [{ name: 'amp.kicad_sch', path: '/ada/amp.kicad_sch', read }, { name: 'amp.kicad_pcb', path: '/ada/amp.kicad_pcb' }], files: { '/ada/amp.kicad_pcb': '(kicad_pcb)' } });
    await boot(mock);
    await settle();
    expect(importKicad).toHaveBeenCalledTimes(1);
    const files = importKicad.mock.calls[0][0];
    expect(files.map((f) => f.name)).toEqual(['amp.kicad_sch', 'amp.kicad_pcb']);
    expect(await files[0].text()).toBe(SCH);
    expect(await files[1].text()).toBe('(kicad_pcb)');
    // The launch item read itself; the other came from the drive.
    expect(read).toHaveBeenCalledTimes(1);
    expect(reads(mock)).toEqual(['/ada/amp.kicad_pcb']);
  });

  it('opens the first of several projects and says so, and does not read the open one again', async () => {
    const mock = sdk({
      launch: [{ name: 'A.circuits', path: '/ada/A.circuits' }, { name: 'B.circuits', path: '/ada/B.circuits' }],
      files: { '/ada/A.circuits': projectText('A'), '/ada/B.circuits': projectText('B') },
    });
    const app = await boot(mock);
    await settle();
    expect(app.project?.name).toBe('A');
    expect(toasts()).toMatch(/only A\.circuits is opened/);
    expect(await app.openDriveItems([{ name: 'A.circuits', path: '/ada/A.circuits' }])).toBe(true);
    expect(toasts()).toMatch(/A is already open/);
    expect(reads(mock)).toHaveLength(1);
  });

  it('opens one drive file once when it arrives twice at the same time', async () => {
    const mock = sdk({ files: { '/ada/A.circuits': projectText('A') } });
    const app = await boot(mock);
    const item = { name: 'A.circuits', path: '/ada/A.circuits' };
    await Promise.all([app.openDriveItems([item]), app.openDriveItems([item])]);
    expect(app.project?.name).toBe('A');
    expect(reads(mock)).toHaveLength(1);
  });

  it('opens files dragged in from a Puter folder window or from this device', async () => {
    const mock = sdk({ files: { '/ada/Dragged.circuits': projectText('Dragged') } });
    const app = await boot(mock);
    // The SDK turns the desktop's drop into a drop event of its own, with plain drive entries and no dataTransfer.
    const drive = new CustomEvent('drop', { bubbles: true, cancelable: true, detail: { items: [{ name: 'Dragged.circuits', path: '/ada/Dragged.circuits' }] } });
    document.body.dispatchEvent(drive);
    expect(drive.defaultPrevented).toBe(true);
    await settle();
    expect(app.project?.name).toBe('Dragged');
    expect(app.location).toEqual({ type: 'cloud', path: '/ada/Dragged.circuits' });

    const device = new Event('drop', { bubbles: true, cancelable: true });
    const file = new File([projectText('Local')], 'Local.circuits');
    Object.defineProperty(device, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
    document.body.dispatchEvent(device);
    expect(device.defaultPrevented).toBe(true);
    await settle();
    expect(app.project?.name).toBe('Local');
    // A copy from the device gets a place of its own, as Open a file does.
    expect(app.location?.path).not.toBe('/ada/Dragged.circuits');
  });
});
