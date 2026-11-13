import { afterEach, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

afterEach(() => { dialogHooks.open = null; vi.restoreAllMocks(); });
async function copies(firstPatch, secondPatch = firstPatch, { identical = false } = {}) {
  const preferred = memoryBackend(), fallback = memoryBackend();
  for (const [backend, name, patch] of [[preferred, 'Selected artwork', firstPatch], [fallback, identical ? 'Selected artwork' : 'Different artwork', secondPatch]]) {
    await new RecoveryStore(backend).put('drawing', {
      name: 'Drawing', session: 'previous', saved: 200, revision: 2, commentsRevision: 0,
      data: await serializeDocument(VDocument.create({ name }), { compress: false }),
    });
    const path = 'recovery/index.0.drawing.json';
    const index = await backend.readJSON(path);
    await backend.writeJSON(path, { ...index, entries: [{ ...index.entries[0], ...patch }] });
  }
  const store = new RecoveryStore([preferred, fallback]);
  const [entry] = await store.list();
  return { preferred, fallback, store, entry };
}

it.each([
  ['different invalid sequences', { sequence: 'first' }, { sequence: 'second' }],
  ['equal invalid sequences', { sequence: 'broken' }, { sequence: 'broken' }],
  ['object sequences', { sequence: { value: 1 } }, { sequence: { value: 2 } }],
  ['an invalid sequence and a legacy copy', { sequence: false }, {}],
  ['missing legacy timestamps', { saved: undefined }, { saved: undefined }],
  ['invalid legacy timestamps', { saved: 'broken' }, { saved: 'broken' }],
  ['out-of-range legacy timestamps', { saved: 1e30 }, { saved: 1e30 }],
  ['invalid legacy revisions', { revision: false }, { revision: 0 }],
  ['invalid legacy comment revisions', { commentsRevision: 'broken' }, { commentsRevision: 'broken' }],
  ['invalid modern sessions', { session: true, sequence: 2 }, { session: true, sequence: 2 }],
])('does not substitute fallback bytes identified by %s', async (_, selected, other) => {
  const { preferred, fallback, store, entry } = await copies(selected, other);
  vi.spyOn(preferred, 'readBlob').mockRejectedValue(new Error('Selected storage offline'));
  const reading = vi.spyOn(fallback, 'readBlob');
  await expect(store.read(entry)).rejects.toThrow();
  expect(reading).not.toHaveBeenCalled();
  for (const backend of [preferred, fallback]) expect([...backend.files.keys()].filter((path) => path.endsWith('.vstudio'))).toHaveLength(1);
});

it('does not confirm a different backend as the selected capture when the original index becomes unavailable', async () => {
  const { preferred, store, entry } = await copies({ sequence: 'first' }, { sequence: 'second' });
  vi.spyOn(preferred, 'readJSON').mockRejectedValue(new Error('Metadata offline'));
  expect(await store.isCurrent(entry)).toBe(false);
});

it.each([
  { sequence: 'broken' }, { sequence: { value: 1 } }, { saved: 'broken' },
  { saved: undefined }, { revision: false }, { session: true, sequence: 2 },
])('still reads the selected immutable copy at its own storage location: %j', async (patch) => {
  const { store, entry } = await copies(patch);
  expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Selected artwork');
  expect(await store.isCurrent(entry)).toBe(true);
});

it.each([
  { sequence: undefined }, { sequence: null }, { sequence: 2 },
  { sequence: 2, saved: { valueOf: null, toString: null }, revision: 'broken' },
])('preserves verified legacy and modern fallback captures: %j', async (patch) => {
  const { preferred, store, entry } = await copies(patch, patch, { identical: true });
  vi.spyOn(preferred, 'readBlob').mockRejectedValue(new Error('Selected storage offline'));
  expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Selected artwork');
});

it.each(['offline', 'missing'])('keeps both copies and offers retry when selected storage is %s and fallback identity is uncertain', async (failure) => {
  const { preferred, fallback, store } = await copies({ sequence: 'first' }, { sequence: 'second' });
  vi.spyOn(preferred, 'readBlob').mockImplementation(async () => {
    if (failure === 'offline') throw new Error('Storage offline');
    return null;
  });
  const reading = vi.spyOn(fallback, 'readBlob');
  const app = { editors: [], renderTabs: vi.fn(), notify: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
  const saver = new Autosaver(app, { store, session: 'current' });
  saver.liveSessions = async () => new Set();
  dialogHooks.open = async () => 'recover';
  expect(await saver.offerRecovery()).toEqual([]);
  expect(app.addDocument).not.toHaveBeenCalled();
  expect(reading).not.toHaveBeenCalled();
  expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('kept for the next recovery attempt'), expect.any(Object));
  for (const backend of [preferred, fallback]) expect([...backend.files.keys()].filter((path) => path.endsWith('.vstudio'))).toHaveLength(1);
});

it.each(['broken', { value: 1 }])('reads an exact mirrored snapshot even when its sequence metadata is %j', async (sequence) => {
  const { preferred, fallback, store, entry } = await copies({ sequence });
  // A full mirror retains the immutable snapshot filename, unlike independent
  // writes to two stores (whose separate tokens require matching metadata).
  fallback.files.clear();
  for (const [path, bytes] of preferred.files) fallback.files.set(path, bytes);
  vi.spyOn(preferred, 'readJSON').mockRejectedValue(new Error('Primary unavailable'));
  vi.spyOn(preferred, 'readBlob').mockRejectedValue(new Error('Primary unavailable'));
  expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Selected artwork');
  expect(await store.isCurrent(entry)).toBe(true);
});
