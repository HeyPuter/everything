import { expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

async function snapshot(name, sequence) {
  return { name, session: 'previous', sequence, saved: sequence, revision: sequence,
    data: await serializeDocument(VDocument.create({ name }), { compress: false }) };
}
function recoveryApp(store) {
  const app = { editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
  const saver = new Autosaver(app, { store, session: 'current' });
  saver.liveSessions = async () => new Set();
  return { app, saver };
}
async function expectLatest(store) {
  const entries = await store.list();
  expect(entries.length).toBe(1);
  expect(entries[0].sequence).toBe(2);
  expect((await parseDocument(await store.read(entries[0]))).doc.root.name).toBe('Newer work');
}

it.each(['discard all', 'unchecked copy'])('preserves a newer backup published during confirmation for %s', async (choice) => {
  const store = new RecoveryStore(memoryBackend());
  await store.put('drawing', await snapshot('Shown copy', 1));
  const { saver, app } = recoveryApp(store);
  dialogHooks.open = async (opts) => {
    if (opts.title === 'Recover Documents') {
      if (choice === 'discard all') return 'discard';
      opts.body.querySelector('#rec-drawing').checked = false;
      return 'recover';
    }
    await store.put('drawing', await snapshot('Newer work', 2));
    return 'discard';
  };
  try {
    expect((await saver.offerRecovery()).length).toBe(0);
    await expectLatest(store);
    expect(app.notify.mock.calls.some(([message]) => message.includes('kept'))).toBe(true);
  } finally { dialogHooks.open = null; }
});

it('does not discard a newer backup when parsing a stale damaged copy fails', async () => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('drawing', { name: 'Damaged old copy', data: 'not a document', session: 'previous', sequence: 1, saved: 1 });
  const { saver, app } = recoveryApp(store);
  const read = backend.readBlob;
  vi.spyOn(backend, 'readBlob').mockImplementationOnce(async (path) => {
    const stale = await read(path);
    await store.put('drawing', await snapshot('Newer work', 2));
    return stale;
  });
  dialogHooks.open = async () => 'recover';
  try {
    expect((await saver.offerRecovery()).length).toBe(0);
    await expectLatest(store);
    expect(app.addDocument).not.toHaveBeenCalled();
    expect(app.notify.mock.calls.some(([message]) => message.includes('kept'))).toBe(true);
  } finally { dialogHooks.open = null; vi.restoreAllMocks(); }
});

it('checks the expected snapshot when deletion executes after an already queued write', async () => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('drawing', await snapshot('Shown copy', 1));
  const [entry] = await store.list();
  const next = await snapshot('Newer work', 2);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = backend.writeJSON;
  const writing = vi.spyOn(backend, 'writeJSON').mockImplementationOnce(async (...args) => { await gate; return write(...args); });
  try {
    const saving = store.put('drawing', next);
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    const removing = store.remove('drawing', { expected: entry });
    release();
    await saving;
    await removing;
    await expectLatest(store);
  } finally { release(); vi.restoreAllMocks(); }
});

it('discards every unchanged observed copy, including older copies in fallback storage', async () => {
  const cloud = memoryBackend(), local = memoryBackend();
  await new RecoveryStore(cloud).put('drawing', await snapshot('Latest', 2));
  await new RecoveryStore(local).put('drawing', await snapshot('Older', 1));
  const store = new RecoveryStore([cloud, local]);
  const { saver, app } = recoveryApp(store);
  dialogHooks.open = async () => 'discard';
  try {
    await saver.offerRecovery();
    expect(await store.list()).toEqual([]);
    for (const backend of [cloud, local]) expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toEqual([]);
    expect(app.notify).not.toHaveBeenCalled();
  } finally { dialogHooks.open = null; }
});

it.each([false, true])('preserves a later fallback copy when it was previously listed: %s', async (listed) => {
  const cloud = memoryBackend(), local = memoryBackend();
  await new RecoveryStore(cloud).put('drawing', await snapshot('Shown copy', 1));
  if (listed) await new RecoveryStore(local).put('drawing', await snapshot('Older', 0));
  const store = new RecoveryStore([cloud, local]);
  const [entry] = await store.list();
  await new RecoveryStore(local).put('drawing', await snapshot('Newer work', 2));
  expect(await store.remove('drawing', { expected: entry })).toBe(false);
  expect(await new RecoveryStore(cloud).list()).toEqual([]);
  await expectLatest(store);
});

it('distinguishes replacement publications even when capture metadata is identical', async () => {
  const store = new RecoveryStore(memoryBackend());
  await store.put('drawing', await snapshot('Shown copy', 2));
  const [entry] = await store.list();
  await store.put('drawing', await snapshot('Newer work', 2));
  expect(await store.remove('drawing', { expected: entry })).toBe(false);
  await expectLatest(store);
});

it('keeps unindexed bytes while deleting only the confirmed copy', async () => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('drawing', await snapshot('Shown copy', 1));
  const [entry] = await store.list();
  await backend.writeBlob('recovery/drawing/unpublished.vstudio', new Blob(['new bytes']));
  expect(await store.remove('drawing', { expected: entry })).toBe(false);
  expect(await (await backend.readBlob('recovery/drawing/unpublished.vstudio')).text()).toBe('new bytes');
  expect(await backend.readBlob(`recovery/drawing/${entry.snapshot}.vstudio`)).toBeNull();
  // Explicit document cleanup still removes orphan snapshots.
  expect(await store.remove('drawing')).toBe(true);
  expect(await backend.list('recovery/drawing')).toEqual([]);
});

it('reports a failed discard and permits retry without losing the backup', async () => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('drawing', await snapshot('Shown copy', 1));
  const { saver, app } = recoveryApp(store);
  dialogHooks.open = async (opts) => {
    if (opts.title !== 'Recover Documents') vi.spyOn(backend, 'writeJSON').mockRejectedValueOnce(new Error('Offline'));
    return 'discard';
  };
  try {
    await saver.offerRecovery();
    expect((await store.list()).length).toBe(1);
    expect(app.notify.mock.calls.some(([message]) => message.includes('kept'))).toBe(true);
    dialogHooks.open = async () => 'discard';
    await saver.offerRecovery();
    expect(await store.list()).toEqual([]);
  } finally { dialogHooks.open = null; vi.restoreAllMocks(); }
});
