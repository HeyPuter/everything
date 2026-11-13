import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';

function setupService(app, get = async () => null) {
  const service = app.files.service;
  service.handles = { get: vi.fn(get) };
  service.recent = { remove: vi.fn(async () => {}) };
  app.dialogs.alert = vi.fn(async () => true);
  return service;
}
const entry = { kind: 'local', handleId: 'drawing-handle', name: 'Drawing.vstudio' };
function openDrawing(app, kind) {
  const ed = app.newDocument();
  const source = { ...entry, handle: { getFile: vi.fn() } };
  ed.file = kind === 'native' ? source : { kind: 'import', name: 'Drawing.svg', format: 'svg', source };
  ed.doc.transact('Unsaved edit', () => ed.doc.updateRoot({ name: 'Unsaved changes' }));
  return ed;
}
async function cleanup(app) {
  for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
}

it.each(['native', 'import'])('opens the existing %s window from Recent without depending on stored handles', async (kind) => {
  const app = await bootAppWithFeatures();
  const service = setupService(app);
  const ed = openDrawing(app, kind);
  app.newDocument();
  const history = ed.doc.undoStack.length;
  try {
    const opened = await service.openRecent(entry);
    expect(opened === ed).toBe(true);
    expect(app.editor === ed).toBe(true);
    expect(ed.doc.root.name).toBe('Unsaved changes');
    expect(ed.doc.undoStack.length).toBe(history);
    expect(service.handles.get).not.toHaveBeenCalled();
    expect(service.recent.remove).not.toHaveBeenCalled();
    expect(app.dialogs.alert).not.toHaveBeenCalled();
  } finally { await cleanup(app); }
});

it.each(['native', 'import'])('finds a %s window opened while the stored handle lookup is pending', async (kind) => {
  const app = await bootAppWithFeatures();
  let release;
  const service = setupService(app, () => new Promise((resolve) => { release = resolve; }));
  try {
    const opening = service.openRecent(entry);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const ed = openDrawing(app, kind);
    app.newDocument();
    release(null);
    expect((await opening) === ed).toBe(true);
    expect(app.editor === ed).toBe(true);
    expect(service.recent.remove).not.toHaveBeenCalled();
    expect(app.dialogs.alert).not.toHaveBeenCalled();
  } finally { release?.(null); await cleanup(app); }
});

it('still removes an unavailable Recent entry and explains how to choose the file again', async () => {
  const app = await bootAppWithFeatures();
  const service = setupService(app);
  try {
    expect(await service.openRecent(entry)).toBeNull();
    expect(service.recent.remove).toHaveBeenCalledWith(entry);
    expect(app.dialogs.alert).toHaveBeenCalledWith(expect.objectContaining({ title: 'File Not Available', message: expect.stringContaining('Use Open to choose it again') }));
  } finally { await cleanup(app); }
});
