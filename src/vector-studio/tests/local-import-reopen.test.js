import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';

async function setup(format, persistent) {
  const app = await bootAppWithFeatures();
  const service = app.files.service;
  const text = format === 'svg'
    ? '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="30"/></svg>'
    : '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 20 30\n0 0 20 30 rectfill\n';
  const file = new File([text], `Drawing.${format}`);
  const stored = new Map();
  const handle = (key = 'original') => ({
    kind: 'file', name: file.name, key,
    isSameEntry: async (other) => key === other.key,
    getFile: vi.fn(async () => file),
    createWritable: vi.fn(),
  });
  service.handles = {
    find: async (h) => [...stored].find(([, other]) => other.key === h.key)?.[0] || null,
    put: async (id, h) => { if (persistent) stored.set(id, h); return persistent; },
    get: async (id) => stored.get(id) || null,
  };
  return { app, service, file, handle, stored };
}
async function cleanup(app) {
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
}

it.each(['svg', 'eps'].flatMap((format) => [false, true].map((persistent) => [format, persistent])))('reopens the edited %s import from its local source (persistent handles: %s)', async (format, persistent) => {
  const c = await setup(format, persistent);
  const source = c.handle();
  try {
    const first = await c.service.openFileBlob(c.file, { handle: source });
    expect(first.file.kind).toBe('import');
    first.doc.transact('Rename', () => first.doc.updateRoot({ name: 'Unsaved changes' }));
    const history = first.doc.undoStack.length;
    const second = await c.service.openFileBlob(c.file, { handle: c.handle() });
    expect(second === first).toBe(true);
    expect(second.doc.root.name).toBe('Unsaved changes');
    expect(second.doc.undoStack.length).toBe(history);
    if (persistent) {
      const third = await c.service.openRecent({ kind: 'local', handleId: [...c.stored.keys()][0], name: c.file.name });
      expect(third === first).toBe(true);
      expect(source.getFile).not.toHaveBeenCalled();
    }
    // Remembering the source must not make Save overwrite the imported SVG/EPS.
    expect(c.service.canRevert(first)).toBe(false);
    const saveAs = vi.spyOn(c.service, 'saveAs').mockResolvedValue(true);
    expect(await c.service.save(first)).toBe(true);
    expect(saveAs).toHaveBeenCalledWith(first);
    expect(source.createWritable).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await cleanup(c.app); }
});

it('opens the original as a fresh import after Save As gives the previous document another file', async () => {
  const c = await setup('svg', true);
  try {
    const first = await c.service.openFileBlob(c.file, { handle: c.handle() });
    first.doc.transact('Rename', () => first.doc.updateRoot({ name: 'Saved copy' }));
    c.app.user = { username: 'test' };
    c.app.prefs.set('filesSaveDialog', 'puter');
    c.app.puter = { fs: {}, ui: { showSaveFilePicker: async () => ({ path: '/u/Copy.vstudio', name: 'Copy.vstudio' }) } };
    expect(await c.service.saveAs(first)).toBe(true);
    expect(first.file.kind).toBe('puter');
    const second = await c.service.openFileBlob(c.file, { handle: c.handle() });
    expect(second === first).toBe(false);
    expect(second.file.kind).toBe('import');
    expect(second.doc.root.name).not.toBe('Saved copy');
  } finally { await cleanup(c.app); }
});
