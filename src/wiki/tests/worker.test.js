import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { fakePuter, alice, bob, cam } from './helpers/puter.js';
import { encode, decode, hash } from '../src/collab/protocol.js';
import { addPage } from '../src/data/tree.js';
import { insertBlock, listBlocks } from '../src/data/page.js';
import { DOCS } from '../worker/service.js';

const ROOM = 'room0000abcd';

function seed() {
  const tree = new Y.Doc();
  const root = addPage(tree, { title: 'Team handbook' });
  const page = new Y.Doc();
  insertBlock(page, { text: 'Welcome' });
  return { root, docs: { tree: encode(Y.encodeStateAsUpdate(tree)), [root]: encode(Y.encodeStateAsUpdate(page)) } };
}

async function created(env) {
  const { root, docs } = seed();
  await env.service().call(alice, { op: 'create', room: ROOM, docs, title: 'Team handbook' });
  return root;
}

async function commit(env, user, doc, mutate) {
  const svc = env.service();
  const { updates } = await svc.call(user, { op: 'sync', room: ROOM, docs: { [doc]: null } });
  const y = new Y.Doc();
  Y.applyUpdate(y, decode(updates[doc]));
  const before = Y.encodeStateVector(y);
  mutate(y);
  const update = Y.encodeStateAsUpdate(y, before);
  return svc.call(user, { op: 'commit', room: ROOM, doc, update: encode(update), id: await hash(update) });
}

async function send(env, user, doc, update) {
  return env.service().call(user, { op: 'commit', room: ROOM, doc, update: encode(update), id: await hash(update) });
}

async function read(env, user, doc) {
  const { updates } = await env.service().call(user, { op: 'sync', room: ROOM, docs: { [doc]: null } });
  const y = new Y.Doc();
  Y.applyUpdate(y, decode(updates[doc]));
  return y;
}

describe('collaboration worker', () => {
  let env;
  beforeEach(() => {
    env = fakePuter();
    env.forget();
  });

  it('lets only the server owner create a space', async () => {
    const { docs } = seed();
    await expect(env.service().call(bob, { op: 'create', room: ROOM, docs })).rejects.toMatchObject({ status: 403 });
    await expect(env.service().call(alice, { op: 'create', room: ROOM, docs })).resolves.toEqual({ room: ROOM });
    // Creating again is harmless for the owner.
    await expect(env.service().call(alice, { op: 'create', room: ROOM, docs })).resolves.toEqual({ room: ROOM });
  });

  it('keeps people out until they are invited', async () => {
    await created(env);
    await expect(env.service().call(bob, { op: 'join', room: ROOM })).rejects.toMatchObject({ status: 403 });
    await expect(env.service().call(bob, { op: 'sync', room: ROOM, docs: { tree: null } })).rejects.toMatchObject({ status: 403 });
  });

  it('admits people with an invitation, at its role', async () => {
    const root = await created(env);
    const { token } = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'editor' });
    const joined = await env.service().call(bob, { op: 'join', room: ROOM, token });
    expect(joined).toMatchObject({ role: 'editor', title: 'Team handbook', owner: 'alice' });
    await commit(env, bob, root, (y) => insertBlock(y, { text: 'Added by Bob' }));
    const page = await read(env, alice, root);
    expect(listBlocks(page).map((b) => b.delta[0]?.insert)).toContain('Added by Bob');
  });

  it('refuses expired or revoked invitations', async () => {
    await created(env);
    const { token } = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'viewer' });
    await env.service().call(alice, { op: 'revoke-invites', room: ROOM });
    await expect(env.service().call(bob, { op: 'join', room: ROOM, token })).rejects.toMatchObject({ status: 403 });
    const second = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'viewer' });
    env.now += 15 * 24 * 60 * 60 * 1000;
    await expect(env.service().call(bob, { op: 'join', room: ROOM, token: second.token })).rejects.toMatchObject({ status: 403 });
  });

  it('enforces roles on every save', async () => {
    const root = await created(env);
    const v = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'viewer' });
    const c = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'commenter' });
    await env.service().call(bob, { op: 'join', room: ROOM, token: v.token });
    await env.service().call(cam, { op: 'join', room: ROOM, token: c.token });
    await expect(commit(env, bob, root, (y) => insertBlock(y, { text: 'x' }))).rejects.toMatchObject({ status: 403 });
    await expect(commit(env, cam, root, (y) => insertBlock(y, { text: 'x' }))).rejects.toMatchObject({ status: 403 });
    // Commenters can write a page's comments document.
    await expect(commit(env, cam, `${root}.c`, (y) => y.getMap('comments').set('a', 'hi'))).resolves.toBeTruthy();
    await expect(commit(env, bob, `${root}.c`, (y) => y.getMap('comments').set('b', 'hi'))).rejects.toMatchObject({ status: 403 });
    // Viewers cannot manage access.
    await expect(env.service().call(bob, { op: 'invite', room: ROOM, role: 'editor' })).rejects.toMatchObject({ status: 403 });
  });

  it('checks the update checksum', async () => {
    const root = await created(env);
    const y = new Y.Doc();
    insertBlock(y, { text: 'x' });
    const update = Y.encodeStateAsUpdate(y);
    await expect(env.service().call(alice, { op: 'commit', room: ROOM, doc: root, update: encode(update), id: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(env.service().call(alice, { op: 'commit', room: ROOM, doc: root, update: 'not base64!', id: 'x' })).rejects.toMatchObject({ status: 400 });
  });

  it('opens to anyone signed in when link sharing is on, and closes again', async () => {
    const root = await created(env);
    await env.service().call(alice, { op: 'settings', room: ROOM, visibility: 'link', linkRole: 'commenter' });
    expect(await env.service().call(bob, { op: 'join', room: ROOM })).toMatchObject({ role: 'commenter' });
    await env.service().call(alice, { op: 'settings', room: ROOM, visibility: 'private' });
    await expect(env.service().call(bob, { op: 'sync', room: ROOM, docs: { [root]: null } })).rejects.toMatchObject({ status: 403 });
  });

  it('changes roles and removes people', async () => {
    await created(env);
    const { token } = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'viewer' });
    await env.service().call(bob, { op: 'join', room: ROOM, token });
    await env.service().call(alice, { op: 'role', room: ROOM, uuid: bob.uuid, role: 'editor' });
    let { members } = await env.service().call(alice, { op: 'members', room: ROOM });
    expect(members.find((m) => m.uuid === bob.uuid).role).toBe('editor');
    await expect(env.service().call(alice, { op: 'role', room: ROOM, uuid: alice.uuid, role: 'viewer' })).rejects.toMatchObject({ status: 400 });
    await env.service().call(alice, { op: 'role', room: ROOM, uuid: bob.uuid, role: 'removed' });
    ({ members } = await env.service().call(alice, { op: 'members', room: ROOM }));
    expect(members.map((m) => m.uuid)).toEqual([alice.uuid]);
    // A removed person cannot come back with an old invitation.
    await expect(env.service().call(bob, { op: 'join', room: ROOM, token })).rejects.toMatchObject({ status: 403 });
  });

  it('serves only what a client is missing', async () => {
    const root = await created(env);
    const y = await read(env, alice, root);
    const vector = encode(Y.encodeStateVector(y));
    const { updates } = await env.service().call(alice, { op: 'sync', room: ROOM, docs: { [root]: vector } });
    // Nothing new: the diff is tiny.
    expect(decode(updates[root]).length).toBeLessThan(10);
  });

  it('merges edits from separate worker instances and after a restart', async () => {
    const root = await created(env);
    const { token } = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'editor' });
    await env.service().call(bob, { op: 'join', room: ROOM, token });
    await commit(env, alice, root, (y) => insertBlock(y, { text: 'one' }));
    env.forget();
    await commit(env, bob, root, (y) => insertBlock(y, { text: 'two' }));
    env.forget();
    const texts = listBlocks(await read(env, alice, root)).map((b) => b.delta[0]?.insert);
    expect(texts).toEqual(expect.arrayContaining(['Welcome', 'one', 'two']));
  });

  it('writes checkpoints and keeps the document intact', async () => {
    const root = await created(env);
    for (let i = 0; i < 205; i++) {
      env.now += 1000;
      await commit(env, alice, root, (y) => insertBlock(y, { text: `line ${i}` }));
    }
    expect(env.data.get(`wk:${ROOM}:cp:${root}`).prevAt).toBeGreaterThan(0);
    env.forget();
    const blocks = listBlocks(await read(env, alice, root));
    expect(blocks.length).toBe(206);
  }, 30000);

  it('keeps presence and tells who is on which page', async () => {
    const root = await created(env);
    const { token } = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'viewer' });
    await env.service().call(bob, { op: 'join', room: ROOM, token });
    await env.service().call(alice, { op: 'presence', room: ROOM, session: 'sessiona1', page: root });
    const { roster } = await env.service().call(bob, { op: 'presence', room: ROOM, session: 'sessionb1', page: null });
    expect(roster.map((p) => [p.username, p.page])).toEqual(expect.arrayContaining([['alice', root], ['bob', null]]));
    env.now += 61_000;
    const later = await env.service().call(bob, { op: 'presence', room: ROOM, session: 'sessionb1' });
    expect(later.roster.map((p) => p.username)).toEqual(['bob']);
  });

  it('stores images by content hash and checks them', async () => {
    await created(env);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const asset = await hash(bytes);
    const data = `data:image/png;base64,${encode(bytes)}`;
    await expect(env.service().call(alice, { op: 'asset.put', room: ROOM, asset: '0'.repeat(64), data })).rejects.toMatchObject({ status: 400 });
    await env.service().call(alice, { op: 'asset.put', room: ROOM, asset, data });
    expect((await env.service().call(alice, { op: 'asset.get', room: ROOM, asset })).data).toBe(data);
  });

  it('signals saves for live updates', async () => {
    const root = await created(env);
    const seen = [];
    env.onSet((key, value) => key.endsWith(':ev:signal') && seen.push(value.docs));
    await commit(env, alice, root, (y) => insertBlock(y, { text: 'x' }));
    expect(seen.at(-1)).toEqual([root]);
    const owner = await env.service().call(alice, { op: 'events', room: ROOM });
    expect(owner.events).toEqual({ app: 'app-wiki', key: `wk:${ROOM}:ev:signal` });
  });

  it('marks a space deleted for everyone', async () => {
    await created(env);
    await env.service().call(alice, { op: 'delete', room: ROOM });
    await expect(env.service().call(alice, { op: 'join', room: ROOM })).rejects.toMatchObject({ status: 404 });
  });

  it('lets people leave a space but not its owner', async () => {
    await created(env);
    const { token } = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'viewer' });
    await env.service().call(bob, { op: 'join', room: ROOM, token });
    await env.service().call(bob, { op: 'forget', room: ROOM });
    await expect(env.service().call(bob, { op: 'sync', room: ROOM, docs: {} })).rejects.toMatchObject({ status: 403 });
    await expect(env.service().call(alice, { op: 'forget', room: ROOM })).rejects.toMatchObject({ status: 400 });
  });
});

describe('collaboration worker: access edge cases', () => {
  let env;
  beforeEach(() => {
    env = fakePuter();
    env.forget();
  });

  it('gives people who joined by link whatever the link gives now', async () => {
    const root = await created(env);
    await env.service().call(alice, { op: 'settings', room: ROOM, visibility: 'link', linkRole: 'editor' });
    await env.service().call(bob, { op: 'join', room: ROOM });
    await expect(commit(env, bob, root, (y) => insertBlock(y, { text: 'ok' }))).resolves.toBeTruthy();
    await env.service().call(alice, { op: 'settings', room: ROOM, linkRole: 'viewer' });
    await expect(commit(env, bob, root, (y) => insertBlock(y, { text: 'no' }))).rejects.toMatchObject({ status: 403 });
    // Turning the link off and on again as view-only keeps them a viewer.
    await env.service().call(alice, { op: 'settings', room: ROOM, visibility: 'private' });
    await env.service().call(alice, { op: 'settings', room: ROOM, visibility: 'link', linkRole: 'viewer' });
    expect((await env.service().call(bob, { op: 'join', room: ROOM })).role).toBe('viewer');
  });

  it('does not let a viewer invitation keep edit rights from an old link', async () => {
    await created(env);
    await env.service().call(alice, { op: 'settings', room: ROOM, visibility: 'link', linkRole: 'editor' });
    await env.service().call(bob, { op: 'join', room: ROOM });
    await env.service().call(alice, { op: 'settings', room: ROOM, visibility: 'private' });
    const { token } = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'viewer' });
    expect((await env.service().call(bob, { op: 'join', room: ROOM, token })).role).toBe('viewer');
  });

  it('lets a removed person back in only with a newer invitation', async () => {
    await created(env);
    const first = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'editor' });
    await env.service().call(bob, { op: 'join', room: ROOM, token: first.token });
    env.now += 1000;
    await env.service().call(alice, { op: 'role', room: ROOM, uuid: bob.uuid, role: 'removed' });
    await expect(env.service().call(bob, { op: 'join', room: ROOM, token: first.token })).rejects.toMatchObject({ status: 403 });
    env.now += 1000;
    const second = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'viewer' });
    expect((await env.service().call(bob, { op: 'join', room: ROOM, token: second.token })).role).toBe('viewer');
  });

  it('never checkpoints without an edit whose file could not be read', async () => {
    const root = await created(env);
    // A large edit is stored as a file.
    const big = 'x'.repeat(200_000);
    await commit(env, alice, root, (y) => insertBlock(y, { text: big }));
    const [path] = [...env.files.keys()].filter((k) => k.includes('/updates/'));
    expect(path).toBeTruthy();
    env.forget();
    // Reading that file fails once (not missing, just failing).
    const realRead = env.puter.fs.read;
    let failures = 1;
    env.puter.fs.read = async (p) => {
      if (p === path && failures-- > 0) throw Object.assign(new Error('timeout'), { code: 'timeout' });
      return realRead(p);
    };
    for (let i = 0; i < 205; i++) {
      env.now += 1000;
      await commit(env, alice, root, (y) => insertBlock(y, { text: `n${i}` }));
    }
    env.forget();
    const blocks = listBlocks(await read(env, alice, root));
    expect(blocks.some((b) => b.delta[0]?.insert === big)).toBe(true);
  }, 30000);

  it('never checkpoints a copy that misses edits another instance already checkpointed', async () => {
    const root = await created(env);
    const words = async () => listBlocks(await read(env, alice, root)).map((b) => b.delta[0]?.insert);
    // This instance reads the page, then sits idle.
    await read(env, alice, root);
    const stale = DOCS.get(`${ROOM}|${root}`);
    // Meanwhile another instance saves edits, and two checkpoints drop the
    // first edit's record from the log.
    env.forget();
    await commit(env, alice, root, (y) => insertBlock(y, { text: 'kept' }));
    env.now += 31 * 60_000;
    await commit(env, alice, root, (y) => insertBlock(y, { text: 'a' }));
    env.now += 31 * 60_000;
    await commit(env, alice, root, (y) => insertBlock(y, { text: 'b' }));
    // Back here, whose copy listed the log a minute ago, an edit is saved
    // and triggers a checkpoint.
    env.forget();
    stale.listedAt = env.now - 60_000;
    DOCS.set(`${ROOM}|${root}`, stale);
    await commit(env, alice, root, (y) => insertBlock(y, { text: 'c' }));
    env.forget();
    expect(await words()).toEqual(expect.arrayContaining(['Welcome', 'kept', 'a', 'b', 'c']));
  });

  it('only accepts comments in the author’s own name', async () => {
    const root = await created(env);
    const c = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'commenter' });
    await env.service().call(bob, { op: 'join', room: ROOM, token: c.token });
    const C = await import('../src/data/comments.js');
    // Bob comments as himself: fine. As alice: refused.
    await expect(commit(env, bob, `${root}.c`, (y) => C.addThread(y, { text: 'hi', by: 'bob' }))).resolves.toBeTruthy();
    await expect(commit(env, bob, `${root}.c`, (y) => C.addThread(y, { text: 'fake', by: 'alice' }))).rejects.toMatchObject({ status: 403 });
    // Alice's thread cannot be edited or resolved by Bob.
    let thread;
    await commit(env, alice, `${root}.c`, (y) => (thread = C.addThread(y, { text: 'mine', by: 'alice' })));
    await expect(commit(env, bob, `${root}.c`, (y) => C.setResolved(y, thread, true))).rejects.toMatchObject({ status: 403 });
    await expect(
      commit(env, bob, `${root}.c`, (y) => {
        const t = C.getThread(y, thread);
        C.editMessage(y, thread, t.messages[0].id, 'changed');
      }),
    ).rejects.toMatchObject({ status: 403 });
    // But he can reply.
    await expect(commit(env, bob, `${root}.c`, (y) => C.reply(y, thread, 'a reply', 'bob'))).resolves.toBeTruthy();
  });

  it('lets people edit their own messages and the owner delete anyone’s', async () => {
    const root = await created(env);
    const c = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'commenter' });
    await env.service().call(bob, { op: 'join', room: ROOM, token: c.token });
    const C = await import('../src/data/comments.js');
    let thread;
    await commit(env, bob, `${root}.c`, (y) => (thread = C.addThread(y, { text: 'draft', by: 'bob' })));
    const msg = (y) => C.getThread(y, thread).messages[0];
    await expect(commit(env, bob, `${root}.c`, (y) => C.editMessage(y, thread, msg(y).id, 'final'))).resolves.toBeTruthy();
    expect(msg(await read(env, alice, `${root}.c`)).text).toBe('final');
    await expect(commit(env, alice, `${root}.c`, (y) => C.deleteMessage(y, thread, msg(y).id))).resolves.toBeTruthy();
    expect(C.getThread(await read(env, alice, `${root}.c`), thread)).toBe(null);
  });

  describe('comments changed around the rules', () => {
    let root;
    let C;
    let thread;
    const messages = (y) => y.getMap('threads').get(thread).get('messages');
    const texts = async () => C.getThread(await read(env, alice, `${root}.c`), thread).messages.map((m) => m.text);
    beforeEach(async () => {
      root = await created(env);
      const c = await env.service().call(alice, { op: 'invite', room: ROOM, role: 'commenter' });
      await env.service().call(bob, { op: 'join', room: ROOM, token: c.token });
      C = await import('../src/data/comments.js');
      await commit(env, alice, `${root}.c`, (y) => (thread = C.addThread(y, { text: 'mine', by: 'alice' })));
      await commit(env, bob, `${root}.c`, (y) => C.reply(y, thread, 'reply', 'bob'));
    });

    it('refuses removing someone else’s message or swapping it for a plain lookalike', async () => {
      await expect(commit(env, bob, `${root}.c`, (y) => messages(y).delete(0, 1))).rejects.toMatchObject({ status: 403 });
      await expect(
        commit(env, bob, `${root}.c`, (y) => {
          const copy = messages(y).get(0).toJSON();
          messages(y).delete(0, 1);
          messages(y).insert(0, [copy]);
        }),
      ).rejects.toMatchObject({ status: 403 });
      // A plain list or thread would hide the thread or break every reader.
      await expect(commit(env, bob, `${root}.c`, (y) => y.getMap('threads').get(thread).set('messages', messages(y).toJSON()))).rejects.toMatchObject({ status: 403 });
      await expect(commit(env, bob, `${root}.c`, (y) => y.getMap('threads').set(thread, y.getMap('threads').get(thread).toJSON()))).rejects.toMatchObject({ status: 403 });
      expect(await texts()).toEqual(['mine', 'reply']);
    });

    it('refuses an edit of a message the worker has not seen yet', async () => {
      // Alice writes a reply that is not saved yet; Bob builds an edit of it.
      const ya = await read(env, alice, `${root}.c`);
      const base = Y.encodeStateVector(ya);
      C.reply(ya, thread, 'hello', 'alice');
      const aliceReply = Y.encodeStateAsUpdate(ya, base);
      const yb = new Y.Doc();
      Y.applyUpdate(yb, Y.encodeStateAsUpdate(ya));
      const known = Y.encodeStateVector(yb);
      messages(yb).get(2).set('text', 'forged');
      await expect(send(env, bob, `${root}.c`, Y.encodeStateAsUpdate(yb, known))).rejects.toMatchObject({ status: 409 });
      await send(env, alice, `${root}.c`, aliceReply);
      expect(await texts()).toEqual(['mine', 'reply', 'hello']);
    });

    it('accepts a reply to a message another worker instance saved', async () => {
      const ya = await read(env, alice, `${root}.c`);
      const base = Y.encodeStateVector(ya);
      C.reply(ya, thread, 'from elsewhere', 'alice');
      const update = Y.encodeStateAsUpdate(ya, base);
      env.data.set(`wk:${ROOM}:log:${root}.c:${new Date(env.now).toISOString()}:${'b'.repeat(16)}`, { id: 'x', author: alice.uuid, username: 'alice', at: env.now, update: encode(update) });
      const yb = new Y.Doc();
      Y.applyUpdate(yb, Y.encodeStateAsUpdate(ya));
      const known = Y.encodeStateVector(yb);
      C.reply(yb, thread, 'answer', 'bob');
      await expect(send(env, bob, `${root}.c`, Y.encodeStateAsUpdate(yb, known))).resolves.toBeTruthy();
      expect(await texts()).toEqual(['mine', 'reply', 'from elsewhere', 'answer']);
    });

    it('lets people reply next to duplicate copies of a message that older versions left', async () => {
      await commit(env, alice, `${root}.c`, (y) => {
        const first = messages(y).get(0).toJSON();
        messages(y).delete(0, 1);
        messages(y).insert(0, [{ ...first, text: 'one', edited: 2 }, { ...first, text: 'two', edited: 1 }]);
      });
      await expect(commit(env, bob, `${root}.c`, (y) => C.reply(y, thread, 'still here', 'bob'))).resolves.toBeTruthy();
      await expect(commit(env, alice, `${root}.c`, (y) => C.editMessage(y, thread, C.getThread(y, thread).messages[0].id, 'merged'))).resolves.toBeTruthy();
      expect(await texts()).toEqual(['merged', 'reply', 'still here']);
    });
  });

  it('wipes the history of pages deleted for good', async () => {
    const root = await created(env);
    await commit(env, alice, root, (y) => insertBlock(y, { text: 'secret' }));
    await expect(env.service().call(alice, { op: 'purge', room: ROOM, pages: [root] })).rejects.toMatchObject({ status: 409 });
    await commit(env, alice, 'tree', (y) => y.getMap('pages').delete(root));
    await env.service().call(alice, { op: 'purge', room: ROOM, pages: [root] });
    expect([...env.data.keys()].some((k) => k.includes(`:log:${root}:`) || k.endsWith(`cp:${root}`))).toBe(false);
  });
});

describe('app id from the worker token', () => {
  it('reads plain and packed app ids', async () => {
    const { appUid } = await import('../worker/service.js');
    const token = (claims) => `x.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.y`;
    expect(appUid(token({ app_uid: 'app-1234' }))).toBe('app-1234');
    expect(appUid(token({ au: 'hvDPQjncU0yfdCZWnaGiPw==' }))).toBe('app-86f0cf42-39dc-534c-9f74-26569da1a23f');
    expect(appUid(token({ au: 'hvDPQjncU0yfdCZWnaGiPw' }))).toBe('app-86f0cf42-39dc-534c-9f74-26569da1a23f');
    expect(appUid('garbage')).toBe(null);
  });
});
