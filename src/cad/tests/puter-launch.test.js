// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/io/storage.js', () => ({
  recovery: {},
  errorText: () => '',
  addRecent: () => {},
  cloudRead: vi.fn(async (path) => new TextEncoder().encode(`read ${path}`).buffer),
}));
const storage = await import('../src/io/storage.js');
const { App } = await import('../src/app.js');

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const fsItem = (path, extra = {}) => ({
  name: path.split('/').pop(),
  path,
  // Stands in for the Blob FSItem.read() resolves with (jsdom's Blob has no arrayBuffer).
  read: vi.fn(async () => ({ arrayBuffer: async () => new TextEncoder().encode(`item ${path}`).buffer })),
  ...extra,
});

/** A Puter SDK that, as the real one does, hands the launch items to every launch handler when it is registered. */
function sdk({ env = 'app', launch = [] } = {}) {
  const ui = {
    onLaunchedWithItems: vi.fn((cb) => launch.length && cb(launch)),
    onItemsOpened: vi.fn((cb) => launch.length && cb(launch)),
    onWindowClose: vi.fn(),
  };
  return { env, ui, fs: {} };
}

function app() {
  const a = Object.create(App.prototype);
  a.docs = [];
  a.openBuffer = vi.fn(async () => null);
  a.fileError = vi.fn();
  return a;
}

beforeEach(() => {
  storage.cloudRead.mockClear();
});
afterEach(() => {
  delete globalThis.puter;
  // The toast region is created once: remove the toasts, not the region.
  for (const el of document.querySelectorAll('.toast')) el.remove();
});

describe('files opened from the Puter desktop', () => {
  it('opens a double-clicked file once', async () => {
    const item = fsItem('/u/Desktop/plan.dwg');
    globalThis.puter = sdk({ launch: [item] });
    const a = app();
    await a.handleLaunchItems();
    await settle();
    expect(a.openBuffer).toHaveBeenCalledTimes(1);
    const [buffer, name, file] = a.openBuffer.mock.calls[0];
    expect(new TextDecoder().decode(buffer)).toBe('item /u/Desktop/plan.dwg');
    expect(name).toBe('plan.dwg');
    expect(file).toEqual({ source: 'cloud', path: '/u/Desktop/plan.dwg' });
  });

  it('opens the launch files in a browser tab the desktop opened too', async () => {
    globalThis.puter = sdk({ env: 'web', launch: [fsItem('/u/site.dxf')] });
    const a = app();
    await a.handleLaunchItems();
    await settle();
    expect(a.openBuffer.mock.calls.map((c) => c[1])).toEqual(['site.dxf']);
  });

  it('skips folders and says so', async () => {
    globalThis.puter = sdk({ launch: [{ name: 'Plans', path: '/u/Plans', is_dir: true }] });
    const a = app();
    await a.handleLaunchItems();
    await settle();
    expect(a.openBuffer).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/Folders cannot be opened/);
  });

  it('opens files dragged in from a Puter folder window', async () => {
    globalThis.puter = sdk();
    const a = app();
    a.bindDrop();
    // The SDK turns the desktop's drop into a drop event of its own, with plain drive entries and no dataTransfer.
    const e = new CustomEvent('drop', { bubbles: true, cancelable: true, detail: { items: [{ name: 'a.dwg', path: '/u/a.dwg' }, { name: 'b.dxf', path: '/u/b.dxf', isDirectory: false }] } });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await settle();
    expect(storage.cloudRead.mock.calls.map((c) => c[0])).toEqual(['/u/a.dwg', '/u/b.dxf']);
    expect(a.openBuffer.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['a.dwg', { source: 'cloud', path: '/u/a.dwg' }],
      ['b.dxf', { source: 'cloud', path: '/u/b.dxf' }],
    ]);
  });

  it('does not read a file that is not a drawing', async () => {
    const item = fsItem('/u/photo.png');
    globalThis.puter = sdk({ launch: [item] });
    const a = app();
    await a.handleLaunchItems();
    await settle();
    expect(item.read).not.toHaveBeenCalled();
    expect(a.openBuffer).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/photo\.png.*\.dwg or \.dxf/);
  });

  it('switches to a drawing that is already open instead of reading it again', async () => {
    const item = fsItem('/u/plan.dwg');
    globalThis.puter = sdk({ launch: [item] });
    const a = app();
    const open = { file: { path: '/u/plan.dwg' } };
    a.docs = [open];
    a.activate = vi.fn();
    await a.handleLaunchItems();
    await settle();
    expect(item.read).not.toHaveBeenCalled();
    expect(a.activate).toHaveBeenCalledWith(open);
  });
});

describe('opening one file twice at the same time', () => {
  it('opens one drawing', async () => {
    const a = Object.create(App.prototype);
    Object.assign(a, { docs: [], cmdline: { log() {} }, zoomExtentsSoon() {} });
    a.addDoc = vi.fn((drawing, name, file) => {
      const doc = { drawing, name, file };
      a.docs.push(doc);
      return doc;
    });
    const { Drawing } = await import('../src/core/drawing.js');
    const bytes = () => new TextEncoder().encode(JSON.stringify({ format: 'cad-drawing', ...new Drawing().toJSON() }));
    const file = { source: 'cloud', path: '/u/plan.cad' };
    const [d1, d2] = await Promise.all([a.openBuffer(bytes(), 'plan.cad', file), a.openBuffer(bytes(), 'plan.cad', { ...file })]);
    expect(a.addDoc).toHaveBeenCalledTimes(1);
    expect(d1).toBe(d2);
  });
});
