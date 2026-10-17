import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { Workspace } from '../src/data/workspace.js';
import { memoryBackend, memoryKv } from '../src/data/backend.js';
import { memoryCache } from '../src/data/cache.js';
import { childrenOf, getPage, addPage, updatePage } from '../src/data/tree.js';
import { cloneSubtree } from '../src/data/transfer.js';
import { listBlocks, insertBlocks } from '../src/data/page.js';
import { listRows } from '../src/data/database.js';
import { deltaText } from '../src/data/richtext.js';
import { fakePuter, alice } from './helpers/puter.js';

function collabFor(env, user) {
  const request = env.requester(user);
  return { request: (_s, op, data) => request(op, data), deploy: async () => 'https://wiki-test.puter.work', refresh: async () => {}, events: null };
}

describe('moving and copying safely', () => {
  let env;
  beforeEach(() => {
    env = fakePuter();
    env.forget();
  });

  it('keeps the private page when it cannot be read while sharing', async () => {
    const backend = memoryBackend();
    const ws = new Workspace({ backend, kv: memoryKv(), cache: memoryCache(), user: alice, collab: collabFor(env, alice) });
    await ws.start();
    const page = await ws.createPage(ws.personal, { title: 'Precious' });
    insertBlocks(await ws.personal.doc(page), [{ text: 'do not lose me' }]);
    await ws.personal.flushAll();
    // Forget the loaded copy, then fail the next read.
    ws.personal.entries.delete(page);
    await ws.personal.cache.del(ws.personal.cacheKey(page));
    backend.fail = 1;
    await expect(ws.sharePage(page)).rejects.toThrow();
    expect(getPage(ws.personal.tree, page)).toBeTruthy();
    expect(backend.files.has(`pages/${page}.ywk`)).toBe(true);
  });

  it('keeps the source when the shared space refuses the copy', async () => {
    const ws = new Workspace({ backend: memoryBackend(), kv: memoryKv(), cache: memoryCache(), user: alice, collab: collabFor(env, alice) });
    await ws.start();
    const root = await ws.createPage(ws.personal, { title: 'Space' });
    const shared = await ws.sharePage(root);
    const page = await ws.createPage(ws.personal, { title: 'Huge' });
    insertBlocks(await ws.personal.doc(page), [{ text: 'x' }]);
    // The worker refuses every commit, as for a page that is too large.
    const real = shared.requestFn;
    shared.requestFn = async (op, data) => {
      if (op === 'commit') throw Object.assign(new Error('This change is too large to save.'), { status: 413 });
      return real(op, data);
    };
    await expect(ws.moveToSpace(ws.personal, page, shared, root)).rejects.toThrow(/too large/);
    expect(getPage(ws.personal.tree, page)).toBeTruthy();
    expect(deltaText(listBlocks(await ws.personal.doc(page))[0].delta)).toBe('x');
    shared.close();
  });

  it('includes edits kept on this device when moving a page that is not open', async () => {
    const backend = memoryBackend();
    const cache = memoryCache();
    const ws = new Workspace({ backend, kv: memoryKv(), cache, user: alice, collab: collabFor(env, alice) });
    await ws.start();
    const page = await ws.createPage(ws.personal, { title: 'Offline notes' });
    insertBlocks(await ws.personal.doc(page), [{ text: 'saved' }]);
    await ws.personal.flushAll();
    const shared = await ws.sharePage(page);
    expect(deltaText(listBlocks(await shared.doc(page))[0].delta)).toBe('saved');
    shared.close();
  });

  it('duplicates a database row with its values and keeps rows out of moves', async () => {
    const ws = new Workspace({ backend: memoryBackend(), kv: memoryKv(), cache: memoryCache(), user: alice });
    await ws.start();
    const tasks = childrenOf(ws.personal.tree).find((p) => p.title === 'Tasks');
    const db = await ws.personal.doc(tasks.id);
    const [row] = listRows(db);
    const copy = await ws.duplicate(ws.personal, row.id);
    const rows = listRows(db);
    expect(rows.map((r) => r.id)).toEqual([row.id, copy, ...rows.slice(2).map((r) => r.id)]);
    expect(rows[1].values).toEqual(row.values);
    expect(getPage(ws.personal.tree, copy)).toMatchObject({ row: true, parent: tasks.id });
    await expect(ws.moveToSpace(ws.personal, row.id, { tree: null })).rejects.toThrow(/rows stay/);
    // Deleting a row for good removes it from the database too.
    await ws.deleteForever(ws.personal, copy);
    expect(listRows(db).map((r) => r.id)).not.toContain(copy);
  });

  it('copies a page next to a sibling that shares its order key', async () => {
    const tree = new Y.Doc();
    const a = addPage(tree, { id: 'pagea', title: 'A' });
    const b = addPage(tree, { id: 'pageb', title: 'B' });
    updatePage(tree, b, { order: getPage(tree, a).order });
    const space = { tree, doc: async () => new Y.Doc(), putDoc: async () => {} };
    const copy = await cloneSubtree(space, a);
    expect(childrenOf(tree).map((p) => p.id)).toContain(copy);
  });
});
