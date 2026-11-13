import { expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

async function setup() {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('drawing', { name: 'Drawing', data: await serializeDocument(VDocument.create({ name: 'Keep my work' })), session: 'old', sequence: 1 });
  const index = backend.files.get('recovery/index.json');
  const [entry] = await store.list();
  return { backend, store, index, entry };
}

it.each(['truncated JSON', 'invalid shape', 'invalid record', 'missing index'])('does not discard valid recovery bytes when metadata becomes %s after the recovery dialog opens', async (damage) => {
  const { backend, store, index } = await setup();
  const app = { editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
  const saver = new Autosaver(app, { store, session: 'new' });
  saver.liveSessions = async () => new Set();
  dialogHooks.open = async () => {
    if (damage === 'truncated JSON') backend.files.set('recovery/index.json', '[{"id":');
    if (damage === 'invalid shape') backend.files.set('recovery/index.json', '{}');
    if (damage === 'invalid record') backend.files.set('recovery/index.json', '[null]');
    if (damage === 'missing index') backend.files.delete('recovery/index.json');
    return 'recover';
  };
  try {
    expect((await saver.offerRecovery()).length).toBe(0);
    expect(app.addDocument).not.toHaveBeenCalled();
    expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toHaveLength(1);
    expect(app.notify.mock.calls.some(([message]) => message.includes('could not be recovered right now'))).toBe(true);
    // Once metadata is available again, the original work can still be recovered.
    backend.files.set('recovery/index.json', index);
    const [entry] = await store.list();
    expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Keep my work');
  } finally { dialogHooks.open = null; }
});

it('can read a valid selected entry despite an unrelated damaged index record', async () => {
  const { backend, store, index, entry } = await setup();
  const value = JSON.parse(index);
  backend.files.set('recovery/index.json', JSON.stringify({ ...value, entries: [...value.entries, null] }));
  expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Keep my work');
});

it('still reports a removed recovery entry as gone when its bytes are also gone', async () => {
  const { store, entry } = await setup();
  await store.remove(entry.id);
  expect(await store.read(entry)).toBeNull();
});
