import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { handleStore } from '../src/features/files/handles.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

it.each([
  ['regular backup', true], ['page-close stash', true],
  ['regular backup', false], ['page-close stash', false],
])('restores local-file association from a %s when handle availability is %s', async (mode, available) => {
  const app = await bootAppWithFeatures();
  const backend = memoryBackend();
  const store = new RecoveryStore(mode === 'page-close stash' ? { ...backend, writeBlob: () => new Promise(() => {}) } : backend);
  app.files.autosaver.fixedStore = store;
  const ed = app.newDocument();
  const handle = { name: 'Drawing.vstudio' };
  ed.file = { kind: 'local', name: handle.name, handle, handleId: 'stored-drawing-handle' };
  ed.doc.transact('Edit', () => ed.doc.updateRoot({ name: 'Recovered artwork' }));
  const getHandle = vi.spyOn(handleStore, 'get').mockResolvedValue(available ? handle : null);
  let key;
  try {
    if (mode === 'page-close stash') app.files.autosaver.flush({ hiding: true });
    else await app.files.autosaver.flush();
    key = `vs-recovery-unwritten:${ed.recoveryId}`;
    const nextApp = { prefs: app.prefs, editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: (doc, { file }) => ({ doc, file }) };
    const next = new Autosaver(nextApp, { store: new RecoveryStore(backend), session: 'recover-local-file' });
    next.liveSessions = async () => new Set();
    dialogHooks.open = async () => 'recover';
    const [recovered] = await next.offerRecovery();
    expect(recovered.doc.root.name).toBe('Recovered artwork');
    expect(recovered.doc.dirty).toBe(true);
    if (available) {
      expect(recovered.file.kind).toBe('local');
      expect(recovered.file.handle === handle).toBe(true);
      expect(recovered.file.handleId).toBe('stored-drawing-handle');
    } else {
      expect(recovered.file.kind).toBe('import');
      expect(recovered.file.name).toContain('[Recovered]');
    }
  } finally {
    getHandle.mockRestore();
    dialogHooks.open = null;
    if (key) localStorage.removeItem(key);
    await app.closeDocument(ed, { force: true });
  }
});
