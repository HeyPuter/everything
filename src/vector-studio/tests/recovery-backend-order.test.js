import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';

it.each([5000, 4000])('recovers a later Undo snapshot from fallback storage when its timestamp is %s', async (laterTime) => {
  const app = await bootAppWithFeatures();
  const cloud = memoryBackend();
  const local = memoryBackend();
  const store = new RecoveryStore([cloud, local]);
  const saver = app.files.autosaver;
  saver.fixedStore = store;
  const ed = app.newDocument();
  const now = vi.spyOn(Date, 'now').mockReturnValue(5000);
  try {
    ed.doc.transact('First edit', () => ed.doc.updateRoot({ name: 'Keep this' }));
    ed.doc.transact('Second edit', () => ed.doc.updateRoot({ name: 'Undo this' }));
    expect(await saver.flush()).toBe(1);
    ed.doc.undo();
    now.mockReturnValue(laterTime);
    // Cloud writing and stale-copy cleanup fail, leaving both snapshots on disk.
    cloud.failNext = 2;
    expect(await saver.flush()).toBe(1);
    expect(cloud.files.has(`recovery/${ed.recoveryId}.vstudio`)).toBe(true);
    expect(local.files.has(`recovery/${ed.recoveryId}.vstudio`)).toBe(true);
    const [entry] = await new RecoveryStore([cloud, local]).list();
    const nextApp = { addDocument: (doc, { file }) => ({ doc, file }), renderTabs: vi.fn() };
    const next = new Autosaver(nextApp, { store, session: 'restarted' });
    const recovered = await next.recover(entry);
    expect(recovered.doc.root.name).toBe('Keep this');
    expect(entry.backend).toBe(local);
    expect(entry.sequence).toBe(2);
    expect(entry.revision).toBe(1);
  } finally {
    now.mockRestore();
    await app.closeDocument(ed, { force: true });
  }
});

it.each([
  ['different sessions', { saved: 100, sequence: 50, session: 'old' }, { saved: 200, sequence: 1, session: 'new' }, 'right'],
  ['older different session', { saved: 200, sequence: 1, session: 'new' }, { saved: 100, sequence: 50, session: 'old' }, 'left'],
  ['legacy timestamps', { saved: 100, revision: 9 }, { saved: 200, revision: 1 }, 'right'],
  ['legacy artwork ties', { saved: 100, revision: 1 }, { saved: 100, revision: 2 }, 'right'],
  ['legacy comment ties', { saved: 100, revision: 1, commentsRevision: 1 }, { saved: 100, revision: 1, commentsRevision: 2 }, 'right'],
])('compares %s consistently across storage backends', async (_, leftMeta, rightMeta, expected) => {
  const left = memoryBackend();
  const right = memoryBackend();
  await new RecoveryStore(left).put('drawing', { name: 'left', data: 'left', session: 'same', ...leftMeta });
  await new RecoveryStore(right).put('drawing', { name: 'right', data: 'right', session: 'same', ...rightMeta });
  const store = new RecoveryStore([left, right]);
  const [entry] = await store.list();
  expect(entry.name).toBe(expected);
  expect(await (await store.read(entry)).text()).toBe(expected);
});
