import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';
import { fakePuter, alice, bob } from './helpers/puter.js';
import { encode } from '../src/collab/protocol.js';
import { SharedSpace } from '../src/data/shared.js';
import { memoryCache } from '../src/data/cache.js';
import { addPage, childrenOf, updatePage, getPage } from '../src/data/tree.js';
import { insertBlock, listBlocks, setText } from '../src/data/page.js';
import { deltaText } from '../src/data/richtext.js';

const ROOM = 'room0000wxyz';

async function setup() {
  const env = fakePuter();
  env.forget();
  const tree = new Y.Doc();
  const root = addPage(tree, { title: 'Shared root' });
  const page = new Y.Doc();
  insertBlock(page, { text: 'hello' });
  await env.service().call(alice, { op: 'create', room: ROOM, docs: { tree: encode(Y.encodeStateAsUpdate(tree)), [root]: encode(Y.encodeStateAsUpdate(page)) }, title: 'Shared root' });
  const { token } = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'editor' });
  return { env, root, token };
}

const open = async (env, user, extra = {}) => {
  const s = new SharedSpace({ server: 'https://x.puter.work', room: ROOM, request: env.requester(user), cache: extra.cache || memoryCache(), user });
  await s.open(extra);
  return s;
};

const texts = (doc) => listBlocks(doc).map((b) => deltaText(b.delta));

describe('shared spaces', () => {
  let ctx;
  beforeEach(async () => {
    vi.useRealTimers();
    ctx = await setup();
  });

  it('joins with an invitation and loads the tree', async () => {
    const s = await open(ctx.env, bob, { token: ctx.token });
    expect(s.role).toBe('editor');
    expect(childrenOf(s.tree).map((p) => p.title)).toEqual(['Shared root']);
    s.close();
  });

  it('sends edits and receives everyone else’s', async () => {
    const a = await open(ctx.env, alice);
    const b = await open(ctx.env, bob, { token: ctx.token });
    const pa = await a.doc(ctx.root);
    const pb = await b.doc(ctx.root);
    insertBlock(pa, { text: 'from alice' });
    updatePage(b.tree, ctx.root, { title: 'Renamed by bob' });
    insertBlock(pb, { text: 'from bob' });
    await a.flushAll();
    await b.flushAll();
    await a.synchronize();
    await b.synchronize();
    expect(texts(pa).sort()).toEqual(['from alice', 'from bob', 'hello']);
    expect(texts(pb).sort()).toEqual(texts(pa).sort());
    expect(getPage(a.tree, ctx.root).title).toBe('Renamed by bob');
    a.close();
    b.close();
  });

  it('merges two people typing in the same block', async () => {
    const a = await open(ctx.env, alice);
    const b = await open(ctx.env, bob, { token: ctx.token });
    const pa = await a.doc(ctx.root);
    const pb = await b.doc(ctx.root);
    const id = listBlocks(pa)[0].id;
    setText(pa, id, [{ insert: 'Oh hello' }]);
    setText(pb, id, [{ insert: 'hello there' }]);
    await a.flushAll();
    await b.flushAll();
    await a.synchronize();
    await b.synchronize();
    expect(texts(pa)).toEqual(['Oh hello there']);
    expect(texts(pb)).toEqual(['Oh hello there']);
    a.close();
    b.close();
  });

  it('keeps unsent edits through a failure and a reload', async () => {
    const cache = memoryCache();
    const a = await open(ctx.env, alice, { cache });
    const pa = await a.doc(ctx.root);
    const real = a.requestFn;
    a.requestFn = async (op, data) => {
      if (op === 'commit') throw Object.assign(new Error('offline'), { status: 0 });
      return real(op, data);
    };
    insertBlock(pa, { text: 'written offline' });
    await expect(a.flush(a.entries.get(ctx.root))).rejects.toThrow();
    expect(a.hasUnsaved()).toBe(true);
    a.persist(a.entries.get(ctx.root));
    a.close();
    // A new session with the same local copy sends what was not saved.
    const again = await open(ctx.env, alice, { cache });
    await again.doc(ctx.root);
    await again.flushAll();
    again.close();
    const fresh = await open(ctx.env, alice);
    expect(texts(await fresh.doc(ctx.root))).toContain('written offline');
    fresh.close();
  });

  it('does not send edits for people who can only view', async () => {
    const { token } = await ctx.env.service().call(alice, { op: 'invite', room: ROOM, role: 'viewer' });
    const b = await open(ctx.env, bob, { token });
    expect(b.canEdit).toBe(false);
    const pb = await b.doc(ctx.root);
    insertBlock(pb, { text: 'nope' });
    expect(b.hasUnsaved()).toBe(false);
    b.close();
  });

  it('tells the app when access is lost', async () => {
    const b = await open(ctx.env, bob, { token: ctx.token });
    const lost = new Promise((resolve) => b.on('lost', resolve));
    await ctx.env.service().call(alice, { op: 'role', room: ROOM, uuid: bob.uuid, role: 'removed' });
    await b.synchronize();
    await expect(lost).resolves.toMatchObject({ status: 403 });
    b.close();
  });

  it('shows who else is here', async () => {
    const a = await open(ctx.env, alice);
    const b = await open(ctx.env, bob, { token: ctx.token });
    a.setPage(ctx.root);
    await new Promise((r) => setTimeout(r, 20));
    await b.heartbeat();
    expect(b.roster.map((p) => [p.username, p.page])).toEqual([['alice', ctx.root]]);
    a.close();
    b.close();
  });

  it('uploads images once and reads them back', async () => {
    const a = await open(ctx.env, alice);
    const hash = await a.putAsset(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    a.assetUrls.clear();
    const blob = await a.assetBlob(hash);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    a.close();
  });
});

describe('shared spaces after a refused edit', () => {
  it('goes back to the server copy so later edits still save', async () => {
    const { env, root } = await setup();
    const a = await open(env, alice);
    const pa = await a.doc(root);
    const real = a.requestFn;
    let refuse = true;
    a.requestFn = async (op, data) => {
      if (op === 'commit' && refuse) {
        refuse = false;
        throw Object.assign(new Error('too large'), { status: 413 });
      }
      return real(op, data);
    };
    const resets = [];
    a.on('reset', (id) => resets.push(id));
    insertBlock(pa, { text: 'refused' });
    await expect(a.flush(a.entries.get(root))).rejects.toThrow();
    expect(resets).toEqual([root]);
    // The refused block is gone locally; a later edit on the fresh copy saves.
    const fresh = await a.doc(root);
    expect(texts(fresh)).toEqual(['hello']);
    insertBlock(fresh, { text: 'later edit' });
    await a.flushAll();
    a.close();
    env.forget();
    const b = await open(env, alice);
    expect(texts(await b.doc(root)).sort()).toEqual(['hello', 'later edit']);
    b.close();
  });

  it('synchronizes more documents than one request carries', async () => {
    const { env, root } = await setup();
    const a = await open(env, alice);
    const tree = a.tree;
    const ids = [];
    for (let i = 0; i < 45; i++) ids.push(addPage(tree, { title: `p${i}`, parent: root }));
    await a.flushAll();
    for (const id of ids) {
      const d = await a.doc(id);
      a.hold(id);
      insertBlock(d, { text: id });
    }
    await a.flushAll();
    const b = await open(env, alice);
    const last = ids.at(-1);
    const bd = await b.doc(last);
    for (const id of ids) {
      await b.doc(id);
      b.hold(id);
    }
    // A change to the last document arrives through polling.
    insertBlock(await a.doc(last), { text: 'update' });
    await a.flushAll();
    await b.synchronize();
    expect(texts(await b.doc(last))).toContain('update');
    expect(bd).toBeTruthy();
    a.close();
    b.close();
  });

  describe('live signals', () => {
    let ctx;
    beforeEach(async () => {
      ctx = await setup();
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    /** Records the documents each sync request asks for. */
    const watchSyncs = (space) => {
      const calls = [];
      const real = space.requestFn;
      space.requestFn = (op, data) => {
        if (op === 'sync') calls.push({ docs: Object.keys(data.docs), keys: data.keys || null });
        return real(op, data);
      };
      return calls;
    };

    it('names the saved document, its record and who saved it', async () => {
      const a = await open(ctx.env, alice);
      const pa = await a.doc(ctx.root);
      insertBlock(pa, { text: 'x' });
      await a.flushAll();
      const first = ctx.env.data.get(`wk:${ROOM}:ev:signal`);
      expect(first).toMatchObject({ docs: [ctx.root], session: a.session, by: alice.uuid });
      expect(first.keys[ctx.root]).toMatch(new RegExp(`^wk:${ROOM}:log:${ctx.root}:`));
      expect(ctx.env.data.has(first.keys[ctx.root])).toBe(true);
      insertBlock(pa, { text: 'y' });
      await a.flushAll();
      expect(ctx.env.data.get(`wk:${ROOM}:ev:signal`).seq).toBe(first.seq + 1);
      a.close();
    });

    it('fetches the named record even when the worker copy predates it', async () => {
      const a = await open(ctx.env, alice);
      const pa = await a.doc(ctx.root);
      // Another worker instance saves an edit this instance has not listed yet.
      const other = new Y.Doc();
      Y.applyUpdate(other, Y.encodeStateAsUpdate(pa));
      const before = Y.encodeStateVector(other);
      insertBlock(other, { text: 'from elsewhere' });
      const update = Y.encodeStateAsUpdate(other, before);
      const at = ctx.env.now;
      const key = `wk:${ROOM}:log:${ctx.root}:${new Date(at).toISOString()}:${'a'.repeat(16)}`;
      ctx.env.data.set(key, { id: 'x', author: bob.uuid, username: 'bob', at, update: encode(update) });
      await a.synchronize();
      expect(texts(pa)).not.toContain('from elsewhere');
      await a.synchronize(new Map([[ctx.root, key]]));
      expect(texts(pa)).toContain('from elsewhere');
      // Keys outside the document's own log are ignored.
      const res = await ctx.env.service().call(alice, { op: 'sync', room: ROOM, docs: { tree: null }, keys: { tree: `wk:${ROOM}:meta` } });
      expect(res.updates.tree).toBeTruthy();
      a.close();
    });

    it('reads every record a batch of signals named', async () => {
      const a = await open(ctx.env, alice);
      const pa = await a.doc(ctx.root);
      // Two edits in a row saved through another worker instance.
      const other = new Y.Doc();
      Y.applyUpdate(other, Y.encodeStateAsUpdate(pa));
      const keys = [];
      for (const [i, text] of ['one', 'two'].entries()) {
        const before = Y.encodeStateVector(other);
        insertBlock(other, { text });
        const key = `wk:${ROOM}:log:${ctx.root}:${new Date(ctx.env.now + i).toISOString()}:${String(i).repeat(16)}`;
        ctx.env.data.set(key, { id: 'x', author: bob.uuid, username: 'bob', at: ctx.env.now + i, update: encode(Y.encodeStateAsUpdate(other, before)) });
        keys.push(key);
      }
      a.onSignal({ seq: 1, docs: [ctx.root], keys: { [ctx.root]: keys[0] }, session: 'someoneelse0', by: bob.uuid });
      a.onSignal({ seq: 2, docs: [ctx.root], keys: { [ctx.root]: keys[1] }, session: 'someoneelse0', by: bob.uuid });
      await wait(200);
      await a.syncing;
      expect(texts(pa)).toEqual(['hello', 'one', 'two']);
      a.close();
    });

    it('fetches only what a signal names, skips its own saves, and catches up after a gap', async () => {
      const a = await open(ctx.env, alice);
      await a.doc(ctx.root);
      const calls = watchSyncs(a);
      const from = (seq, extra = {}) => ({ seq, docs: [ctx.root], session: 'someoneelse0', by: bob.uuid, ...extra });
      // The first signal also stands for any sent before this tab listened.
      a.onSignal(from(1, { keys: { [ctx.root]: 'k1' } }));
      await wait(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].docs.sort()).toEqual([ctx.root, 'tree'].sort());
      expect(calls[0].keys).toEqual({ [ctx.root]: ['k1'] });
      calls.length = 0;
      a.onSignal(from(2, { keys: { [ctx.root]: 'k2' } }));
      a.onSignal(from(3, { keys: { [ctx.root]: 'k3' } }));
      await wait(200);
      expect(calls).toEqual([{ docs: [ctx.root], keys: { [ctx.root]: ['k2', 'k3'] } }]);
      calls.length = 0;
      a.onSignal(from(4, { session: a.session, by: alice.uuid }));
      a.onSignal(from(5, { docs: ['notopen'] }));
      await wait(200);
      expect(calls).toEqual([]);
      // Someone else naming this tab's session is not skipped.
      a.onSignal(from(6, { session: a.session }));
      await wait(200);
      expect(calls).toEqual([{ docs: [ctx.root], keys: null }]);
      calls.length = 0;
      a.onSignal(from(8, { keys: { [ctx.root]: 'k8' } }));
      await wait(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].docs.sort()).toEqual([ctx.root, 'tree'].sort());
      expect(calls[0].keys).toEqual({ [ctx.root]: ['k8'] });
      calls.length = 0;
      // People coming and going refresh the roster, not the documents.
      a.onSignal({ seq: 9, docs: [] });
      await wait(200);
      expect(calls).toEqual([]);
      // Signals from an older worker carry no numbers, so each fetches everything.
      a.onSignal({ nonce: 'n', docs: [ctx.root] });
      await wait(200);
      expect(calls[0].docs.sort()).toEqual([ctx.root, 'tree'].sort());
      a.close();
    });
  });
});
