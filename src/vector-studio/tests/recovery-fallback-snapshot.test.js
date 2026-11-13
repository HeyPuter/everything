import { expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

async function copies({ modern = true, same = false } = {}) {
  const preferred = memoryBackend();
  const fallback = memoryBackend();
  const current = await serializeDocument(VDocument.create({ name: 'Latest work' }), { compress: false });
  const older = await serializeDocument(VDocument.create({ name: 'Older work' }), { compress: false });
  const latest = { name: 'Drawing', session: 'previous', saved: 200, revision: 2, commentsRevision: 0, ...(modern ? { sequence: 2 } : {}) };
  const stale = { ...latest, saved: 100, revision: 1, ...(modern ? { sequence: 1 } : {}) };
  await new RecoveryStore(preferred).put('drawing', { ...latest, data: current });
  await new RecoveryStore(fallback).put('drawing', { ...(same ? latest : stale), data: same ? current : older });
  return { preferred, fallback, store: new RecoveryStore([preferred, fallback]) };
}

it.each([false, true].flatMap((modern) => ['offline', 'missing'].map((failure) => [modern, failure])))('keeps the selected recovery copy when only an older fallback is readable (sequences: %s, selected copy: %s)', async (modern, failure) => {
  const { preferred, fallback, store } = await copies({ modern });
  preferred.readBlob = async () => {
    if (failure === 'offline') throw new Error('Offline');
    return null;
  };
  const app = { editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
  const saver = new Autosaver(app, { store, session: 'next' });
  saver.liveSessions = async () => new Set();
  dialogHooks.open = async () => 'recover';
  try {
    expect((await saver.offerRecovery()).map((ed) => ed.doc.root.name)).toEqual([]);
    expect(app.addDocument).not.toHaveBeenCalled();
    expect(app.notify.mock.calls.some(([message]) => message.includes('could not be recovered right now'))).toBe(true);
    expect((await store.list())[0].saved).toBe(200);
    expect(preferred.files.has('recovery/drawing.vstudio')).toBe(true);
    expect(fallback.files.has('recovery/drawing.vstudio')).toBe(true);
  } finally { dialogHooks.open = null; }
});

it.each([false, true])('can use an identical fallback snapshot when the preferred backend is offline (sequences: %s)', async (modern) => {
  const { preferred, store } = await copies({ modern, same: true });
  const [entry] = await store.list();
  preferred.readBlob = async () => { throw new Error('Offline'); };
  const recovered = await parseDocument(await store.read(entry));
  expect(recovered.doc.root.name).toBe('Latest work');
});

it('returns null when the selected bytes are gone and no alternative copy remains', async () => {
  const { preferred, fallback, store } = await copies();
  const [entry] = await store.list();
  preferred.files.delete('recovery/drawing.vstudio');
  fallback.files.clear();
  expect(await store.read(entry)).toBeNull();
});

it.each([
  ['another session', true, { session: 'other' }],
  ['another sequence', true, { sequence: 1 }],
  ['missing sequence', true, { sequence: undefined }],
  ['different comments', false, { commentsRevision: 1 }],
])('rejects fallback bytes from %s even when other metadata ties', async (_, modern, change) => {
  const { preferred, fallback, store } = await copies({ modern });
  const [entry] = await store.list();
  const [candidate] = await fallback.readJSON('recovery/index.json');
  const { session, saved, revision, commentsRevision, sequence } = entry;
  await fallback.writeJSON('recovery/index.json', [{ ...candidate, session, saved, revision, commentsRevision, sequence, ...change }]);
  preferred.readBlob = async () => { throw new Error('Offline'); };
  const read = vi.spyOn(fallback, 'readBlob');
  await expect(store.read(entry)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it('keeps recovery available for retry when fallback metadata cannot be read', async () => {
  const { preferred, fallback, store } = await copies({ same: true });
  const [entry] = await store.list();
  preferred.readBlob = async () => null;
  fallback.readJSON = async () => { throw new Error('Metadata offline'); };
  await expect(store.read(entry)).rejects.toThrow('Metadata offline');
  expect(fallback.files.has('recovery/drawing.vstudio')).toBe(true);
});
