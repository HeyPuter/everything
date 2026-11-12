import { describe, it, expect, vi } from 'vitest';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import { versionKey } from '../src/features/panels/file-commands.js';
import { scriptAPI } from '../src/features/scripts/runner.js';
import { LibraryStore } from '../src/features/libraries/store.js';
import { memoryOutbox } from '../src/features/collab/outbox.js';
import { network, joinClient, shareNew, settle, rect, alice, bob } from './collab-helpers.js';

/** Saves in this browser download the file (no cloud, no File System Access): capture the bytes. */
function captureDownloads() {
  const blobs = [];
  const orig = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return 'blob:x';
  };
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return {
    blobs,
    restore() {
      click.mockRestore();
      URL.createObjectURL = orig;
    },
  };
}
const versionsSettle = () => new Promise((r) => setTimeout(r, 400));
const paths = (doc) => [...doc.nodes.values()].filter((n) => n.type === 'path').length;

describe('version history', () => {
  it('keeps exactly the content that was saved, not edits made right after', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument({ name: 'Saved', width: 200, height: 100 });
    const doc = ed.doc;
    const add = (x) =>
      doc.transact('Add', () =>
        doc.insert(createPath(rectangle(x, 0, 10, 10), true), ed.targetLayer().id),
      );
    add(0);
    const dl = captureDownloads();
    try {
      expect(await app.files.service.save(ed)).toBe(true);
      // Edited at once, before the version is written.
      add(20);
      await versionsSettle();
      const list = await app.versions.list(versionKey(ed));
      expect(list.length).toBe(1);
      const kept = await app.versions.read(versionKey(ed), list[0].id);
      expect(paths(kept)).toBe(1);
      // The version stays content only: a copy opened from it is a document of its own.
      expect(kept.fileId).toBe(null);
      // Saving again keeps the edit made after the first save.
      expect(await app.files.service.save(ed)).toBe(true);
      await versionsSettle();
      const after = await app.versions.list(versionKey(ed));
      expect(after.length).toBe(2);
      expect(paths(await app.versions.read(versionKey(ed), after[1].id))).toBe(2);
    } finally {
      dl.restore();
    }
  });

  it('an edit made while the file is written is kept by the next save', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument({ name: 'Slow', width: 200, height: 100 });
    const doc = ed.doc;
    const add = (x) =>
      doc.transact('Add', () =>
        doc.insert(createPath(rectangle(x, 0, 10, 10), true), ed.targetLayer().id),
      );
    add(0);
    let during = () => {};
    const handle = {
      kind: 'file',
      name: 'Slow.vstudio',
      createWritable: async () => ({ write: async () => during(), close: async () => {} }),
    };
    ed.file = { kind: 'local', name: 'Slow.vstudio', handle, handleId: 'h1' };
    during = () => add(20);
    expect(await app.files.service.save(ed)).toBe(true);
    during = () => {};
    expect(doc.dirty).toBe(true);
    await versionsSettle();
    expect(await app.files.service.save(ed)).toBe(true);
    await versionsSettle();
    const list = await app.versions.list(versionKey(ed));
    expect(list.length).toBe(2);
    expect(paths(await app.versions.read(versionKey(ed), list[0].id))).toBe(1);
    expect(paths(await app.versions.read(versionKey(ed), list[1].id))).toBe(2);
  });

  it('a shared document keeps the content the server had when it counted as saved', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument({ name: 'Team' });
    ed.file = { kind: 'shared', name: 'Team', server: 'https://x.puter.work', room: 'r1' };
    const doc = ed.doc;
    const add = (x) =>
      doc.transact('Add', () =>
        doc.insert(createPath(rectangle(x, 0, 10, 10), true), ed.targetLayer().id),
      );
    add(0);
    doc.markSaved();
    add(20);
    await versionsSettle();
    const list = await app.versions.list(versionKey(ed));
    expect(list.length).toBe(1);
    expect(paths(await app.versions.read(versionKey(ed), list[0].id))).toBe(1);
  });
});

describe('scripts', () => {
  async function setup() {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const doc = app.editor.doc;
    const a = createPath(rectangle(0, 0, 10, 10), true);
    const b = createPath(rectangle(20, 0, 10, 10), true);
    doc.transact('add', () => {
      doc.insert(a, app.editor.targetLayer().id);
      doc.insert(b, app.editor.targetLayer().id);
    });
    return { app, doc, a, b };
  }

  it('one run is one undo step, with commands and pauses between changes', async () => {
    const { app, doc, a, b } = await setup();
    const before = doc.undoStack.length;
    const { api } = scriptAPI(app, app.editor, 'Tidy');
    api.update(a.id, { opacity: 0.5 });
    api.select([a.id, b.id]);
    await api.command('object.group');
    // A pause longer than edits normally merge over (waiting for vs.prompt, say).
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 60000);
    try {
      api.update(b.id, { opacity: 0.25 });
    } finally {
      spy.mockRestore();
    }
    expect(doc.get(a.id).parent).not.toBe(doc.get(app.editor.targetLayer().id).id);
    expect(doc.undoStack.length).toBe(before + 1);
    expect(doc.undoLabel).toBe('Tidy');
    doc.undo();
    expect(doc.get(a.id).opacity).toBe(1);
    expect(doc.get(b.id).opacity).toBe(1);
    expect(doc.get(a.id).parent).toBe(app.editor.targetLayer().id);
    expect(doc.undoStack.length).toBe(before);
    doc.redo();
    expect(doc.get(a.id).opacity).toBe(0.5);
    expect(doc.get(b.id).opacity).toBe(0.25);
    expect(doc.get(doc.get(a.id).parent).type).toBe('group');
  });

  it('a selection made in the same task as a merged change is restored by Redo', async () => {
    const { app, doc, a, b } = await setup();
    const ed = app.editor;
    ed.select([a.id]);
    const { api } = scriptAPI(app, ed, 'Tidy');
    api.update(a.id, { opacity: 0.5 });
    await api.command('object.bringToFront');
    api.update(b.id, { opacity: 0.5 }); // merges the run's steps into one
    ed.select([b.id]); // same task as the last change: part of the run's step
    doc.undo();
    expect([...ed.selection]).toEqual([a.id]);
    doc.redo();
    expect([...ed.selection]).toEqual([b.id]);
  });

  it('a shared document saved during the run still undoes the run in one step', async () => {
    const { app, doc, a, b } = await setup();
    const before = doc.undoStack.length;
    const { api } = scriptAPI(app, app.editor, 'Tidy');
    api.update(a.id, { opacity: 0.5 });
    // The server has every edit so far.
    doc.markSaved();
    api.update(b.id, { opacity: 0.5 });
    expect(doc.undoStack.length).toBe(before + 1);
  });
});

describe('libraries', () => {
  it('signing in while libraries load from this browser shows the account libraries', async () => {
    const cloudLib = { id: 'lib-cloud', name: 'Cloud Kit', items: [] };
    const fs = {
      readdir: async () => [{ name: 'lib-cloud.json', is_dir: false }],
      read: async () => new Blob([JSON.stringify(cloudLib)]),
      write: async () => {},
      delete: async () => {},
    };
    const app = { puter: { fs }, env: 'web', user: null };
    const store = new LibraryStore(app, null, { journal: null });
    const first = store.load();
    // Signed in before this browser's libraries finished loading.
    app.user = { username: 'u' };
    const second = store.load(true);
    await Promise.all([first, second]);
    expect(store.location).toBe('cloud');
    expect(store.libraries.map((l) => l.name)).toEqual(['Cloud Kit']);
    expect(await second).toEqual(store.libraries);
  });
});

describe('shared documents kept on this device', () => {
  it('a local edit stores its pending batch without writing the whole document again', async () => {
    const net = network();
    const { room, client: a } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const outbox = memoryOutbox();
    const writes = [];
    const put = outbox.put;
    outbox.put = (key, value) => {
      writes.push('state' in value);
      return put(key, value);
    };
    const b = await joinClient(net, bob, room, { invite: token, outbox });
    const L = b.doc.root.children[0];
    expect(writes).toEqual([true]);
    // Offline: edits stay pending, each stored at once, the document state untouched.
    net.offline.add(bob.uuid);
    b.doc.transact('Add', () => b.doc.insert(rect('mine1'), L));
    await b.session.sending;
    b.doc.transact('Add', () => b.doc.insert(rect('mine2'), L));
    await b.session.sending;
    await b.session.persisting;
    expect(writes.slice(1).every((w) => !w)).toBe(true);
    expect((await outbox.get(b.session.key)).pending.length).toBeGreaterThan(0);
    // Someone else's edit, ordered by the server, changes the stored state.
    a.doc.transact('Add', () => a.doc.insert(rect('theirs'), L));
    await settle(a);
    net.offline.delete(bob.uuid);
    writes.length = 0;
    b.doc.transact('Add', () => b.doc.insert(rect('mine3'), L));
    await settle(b, a);
    await b.session.persisting;
    expect(writes).toContain(true);
    // Read back after the connection drops again: everything is there.
    b.session.close({ leave: false });
    await b.session.persisting;
    net.offline.add(bob.uuid);
    const again = await joinClient(net, bob, room, { outbox });
    expect(again.session.status).toBe('offline');
    for (const id of ['mine1', 'mine2', 'mine3', 'theirs']) expect(again.doc.has(id)).toBe(true);
    again.session.close({ leave: false });
  });

  it('reads a device copy kept in one row by an earlier release', async () => {
    const outbox = memoryOutbox();
    outbox.rows.set('k', {
      seq: 3,
      state: { nodes: {}, assets: {}, comments: null },
      pending: [{ id: 'p' }],
    });
    expect(await outbox.get('k')).toMatchObject({ seq: 3, pending: [{ id: 'p' }] });
    await outbox.put('k', {
      seq: 5,
      state: { nodes: { a: 1 }, assets: {}, comments: null },
      pending: [],
    });
    expect(await outbox.get('k')).toMatchObject({
      seq: 5,
      state: { nodes: { a: 1 } },
      pending: [],
    });
    // A write without a state keeps the stored one (and its sequence number).
    await outbox.put('k', { seq: 6, pending: [{ id: 'q' }] });
    expect(await outbox.get('k')).toMatchObject({
      seq: 5,
      state: { nodes: { a: 1 } },
      pending: [{ id: 'q' }],
    });
    await outbox.delete('k');
    expect(await outbox.get('k')).toBe(null);
    expect(outbox.rows.size).toBe(0);
  });
});

describe('recovery copies', () => {
  it('a shared document leaves no recovery copy once the server has its edits', async () => {
    const { RecoveryStore, recoverableEntries } = await import('../src/features/files/recovery.js');
    const { memoryBackend } = await import('../src/features/files/backends.js');
    const app = await bootAppWithFeatures();
    const store = new RecoveryStore([memoryBackend()]);
    app.files.autosaver.fixedStore = store;
    const ed = app.newDocument({ name: 'Team' });
    ed.file = { kind: 'shared', name: 'Team', server: 'https://x.puter.work', room: 'r1' };
    const doc = ed.doc;
    doc.transact('Add', () =>
      doc.insert(createPath(rectangle(0, 0, 10, 10), true), ed.targetLayer().id),
    );
    // Autosave runs while the edit is on its way to the server.
    await app.files.autosaver.flush();
    // The server has every edit.
    doc.markSaved();
    await store.queue;
    expect(recoverableEntries(await store.list(), new Set(), 'next-session')).toHaveLength(0);
  });
});

describe('scripts and tabs', () => {
  it('a menu command a script runs acts on its document after another tab is chosen', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument({ name: 'Script doc' });
    const doc = ed.doc;
    const a = createPath(rectangle(0, 0, 10, 10), true);
    const b = createPath(rectangle(20, 0, 10, 10), true);
    doc.transact('add', () => {
      doc.insert(a, ed.targetLayer().id);
      doc.insert(b, ed.targetLayer().id);
    });
    const { api } = scriptAPI(app, ed, 'Group');
    api.select([a.id, b.id]);
    // The user opens another document while the script runs.
    const other = app.newDocument({ name: 'Other' });
    const c = createPath(rectangle(0, 0, 10, 10), true);
    const d = createPath(rectangle(20, 0, 10, 10), true);
    other.doc.transact('add', () => {
      other.doc.insert(c, other.targetLayer().id);
      other.doc.insert(d, other.targetLayer().id);
    });
    other.select([c.id, d.id]);
    expect(app.editor).toBe(other);
    await api.command('object.group');
    expect(doc.get(doc.get(a.id).parent).type).toBe('group');
    expect(other.doc.get(c.id).parent).toBe(other.targetLayer().id);
    // A closed document cannot take commands.
    await app.closeDocument(other, { force: true });
    const third = scriptAPI(app, other, 'Late').api;
    await expect(third.command('object.group')).rejects.toThrow(/closed/);
  });
});
