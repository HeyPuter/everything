// Several simulated people on one shared document, against the real room
// worker service with an in-memory Puter: joining, merging, conflicts, the
// offline outbox, server-side roles, comments, Undo and peer links.
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { findLayer, layer, newDocument, type PhotoDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { readRGBA, writeRect, TILE } from '../src/model/tiles';
import { Assets } from '../src/model/assets';
import { MemoryStore } from '../src/persistence/local-store';
import { RoomClient, type OutboxStores } from '../src/collab/client';
import { call } from '../src/collab/api';
import { openBinding, type SharedBinding } from '../src/collab/shared-history';
import { SharedComments } from '../src/collab/shared-comments';
import { TileIndex } from '../src/collab/tile-index';
import { ORIGIN } from '../src/collab/shared-project';
import { writeThread } from '../src/collab/ycomments';
import { newThread } from '../src/collab/comments';
import { commenter, editor, environment, owner, until, viewer, wait, type User } from './collab-helpers';

const SERVER = 'https://photo-test.puter.work';
type Env = ReturnType<typeof environment>;
type Person = { user: User; client: RoomClient; binding: SharedBinding; assets: Assets; store: MemoryStore<OutboxStores> };
const open: RoomClient[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

function painted(assets: Assets) {
  const doc = newDocument(600, 400, 'Shared');
  const bg = newPixelLayer('Background', doc);
  const data = new Uint8ClampedArray(300 * 300 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([200, 100, 50, 255], i);
  bg.pixels = writeRect(assets.tiles, bg.pixels!, 0, 0, { width: 300, height: 300, data });
  const top = newPixelLayer('Top', doc);
  doc.layers = [bg, top, layer('solid', 'Fill', 600, 400)];
  return doc;
}
async function connect(env: Env, user: User, room: string, opts: { token?: string; ydoc?: Y.Doc; assets?: Assets; store?: MemoryStore<OutboxStores>; peers?: boolean; poll?: number } = {}): Promise<Person> {
  const assets = opts.assets ?? new Assets();
  const store = opts.store ?? new MemoryStore<OutboxStores>();
  const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token: opts.token, tiles: new TileIndex(assets.tiles), assets, store, ydoc: opts.ydoc, poll: opts.poll ?? 40, noPeers: !opts.peers });
  open.push(client);
  await client.join();
  const binding = await openBinding(client, assets);
  return { user, client, binding, assets, store };
}
async function share(env: Env, opts: { peers?: boolean } = {}) {
  const assets = new Assets();
  const doc = painted(assets);
  const ydoc = new Y.Doc();
  const sdk = env.sdk(owner);
  const room = await RoomClient.create({ puter: sdk, server: SERVER, tiles: new TileIndex(assets.tiles), assets, doc, comments: [], ydoc });
  const a = await connect(env, owner, room, { ydoc, assets, peers: opts.peers });
  return { room, a, doc };
}
async function invite(env: Env, room: string, role: string, review = false) {
  return (await call<{ token: string }>(env.sdk(owner), SERVER, { op: 'invite', room, role, review })).token;
}
function edit(p: Person, label: string, fn: (d: PhotoDocument) => void) {
  p.binding.history.execute(label, fn);
}
function paintOn(p: Person, id: string, x: number, y: number, w: number, h: number, value: number) {
  edit(p, 'Brush', (d) => {
    const l = findLayer(d.layers, id)!;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) data.set([value, value, value, 255], i);
    l.pixels = writeRect(p.assets.tiles, l.pixels!, x, y, { width: w, height: h, data });
  });
}
const pixel = (p: Person, id: string, x: number, y: number) => {
  const l = findLayer(p.binding.history.document.layers, id)!;
  return readRGBA(p.assets.tiles, l.pixels!, { x, y, width: 1, height: 1 }).data[0];
};
async function settle(...ps: Person[]) {
  for (const p of ps) {
    await p.binding.idle();
    await p.client.settled();
  }
  for (const p of ps) await p.client.sync();
  await wait(5);
  for (const p of ps) {
    p.binding.project(true);
    await until(async () => {
      await p.binding.idle();
      return p.client.project.missing(p.assets).tiles.size === 0;
    }, 3000, 'tiles');
    p.binding.project(true);
  }
}
const idOf = (p: Person, name: string) => p.binding.history.document.layers.find((l) => l.name === name)!.id;

describe('shared documents with several people', () => {
  it('gives a joiner the full document, tiles included', async () => {
    const env = environment();
    const { room, a } = await share(env);
    const b = await connect(env, editor, room, { token: await invite(env, room, 'editor') });
    expect(b.client.role).toBe('editor');
    expect(b.binding.history.document.layers.map((l) => l.name)).toEqual(['Background', 'Top', 'Fill']);
    expect(pixel(b, idOf(b, 'Background'), 10, 10)).toBe(200);
    expect(b.binding.history.document.name).toBe('Shared');
    expect(a.client.role).toBe('owner');
  });

  it('merges concurrent edits of different layers and paints on one layer per tile', async () => {
    const env = environment();
    const { room, a } = await share(env);
    const token = await invite(env, room, 'editor');
    const b = await connect(env, editor, room, { token });
    const top = idOf(a, 'Top');
    edit(a, 'Opacity', (d) => (findLayer(d.layers, idOf(a, 'Fill'))!.opacity = 0.25));
    edit(b, 'Rename', (d) => (findLayer(d.layers, idOf(b, 'Background'))!.name = 'Base'));
    paintOn(a, top, 0, 0, 40, 40, 11);
    paintOn(b, top, TILE * 2 - 30, 0, 20, 20, 22);
    // The same tile from both: one wins, the same everywhere.
    paintOn(a, top, TILE + 4, TILE + 4, 10, 10, 33);
    paintOn(b, top, TILE + 4, TILE + 4, 10, 10, 44);
    await settle(a, b);
    for (const p of [a, b]) {
      const d = p.binding.history.document;
      expect(d.layers.map((l) => l.name)).toEqual(['Base', 'Top', 'Fill']);
      expect(d.layers[2].opacity).toBe(0.25);
      expect(pixel(p, top, 5, 5)).toBe(11);
      expect(pixel(p, top, TILE * 2 - 20, 5)).toBe(22);
    }
    expect(pixel(a, top, TILE + 6, TILE + 6)).toBe(pixel(b, top, TILE + 6, TILE + 6));
    expect([33, 44]).toContain(pixel(a, top, TILE + 6, TILE + 6));
  });

  it('three people converge on layer order, additions and deletions', async () => {
    const env = environment();
    const { room, a } = await share(env);
    const token = await invite(env, room, 'editor');
    const b = await connect(env, editor, room, { token });
    const c = await connect(env, { uuid: '55555555-5555-4555-8555-555555555555', username: 'eve' }, room, { token });
    edit(a, 'Move', (d) => d.layers.unshift(d.layers.pop()!));
    edit(b, 'Delete', (d) => (d.layers = d.layers.filter((l) => l.name !== 'Top')));
    edit(c, 'New Layer', (d) => d.layers.push(layer('solid', 'Added', 10, 10)));
    await settle(a, b, c);
    const names = a.binding.history.document.layers.map((l) => l.name);
    expect(names).toEqual(['Fill', 'Background', 'Added']);
    expect(b.binding.history.document.layers.map((l) => l.name)).toEqual(names);
    expect(c.binding.history.document.layers.map((l) => l.name)).toEqual(names);
  });

  it('keeps changes made offline in the outbox and sends them when back online, even after a reload', async () => {
    const env = environment();
    const { room, a } = await share(env);
    const token = await invite(env, room, 'editor');
    const b = await connect(env, editor, room, { token });
    env.offlineUsers.add(editor.uuid);
    edit(b, 'Rename', (d) => (d.layers[0].name = 'Offline name'));
    paintOn(b, idOf(b, 'Top'), 0, 0, 30, 30, 77);
    await b.binding.idle();
    await until(() => b.client.status.state === 'offline', 2000, 'offline status');
    expect(b.client.status.pending).toBeGreaterThan(0);
    // The tab closes before the connection returns; its outbox stays in storage.
    b.client.close();
    env.offlineUsers.delete(editor.uuid);
    const again = await connect(env, editor, room, { store: b.store });
    await again.client.settled();
    await settle(a, again);
    expect(a.binding.history.document.layers[0].name).toBe('Offline name');
    expect(pixel(a, idOf(a, 'Top'), 5, 5)).toBe(77);
    expect(again.client.status.pending).toBe(0);
    expect((await b.store.all('outbox')).length).toBe(0);
  });

  it('enforces roles in the worker: viewers cannot commit, commenters can only comment', async () => {
    const env = environment();
    const { room, a } = await share(env);
    const v = await connect(env, viewer, room, { token: await invite(env, room, 'viewer', true) });
    const cm = await connect(env, commenter, room, { token: await invite(env, room, 'commenter', true) });
    // The editor's own history refuses edits for these roles...
    edit(v, 'Rename', (d) => (d.layers[0].name = 'Nope'));
    expect(v.binding.history.document.layers[0].name).toBe('Background');
    // ...and the worker refuses changes written past it.
    const refusedV: string[] = [];
    v.client.o.onRefused = (m) => refusedV.push(m);
    v.client.ydoc.transact(() => v.client.project.layers.get(idOf(v, 'Background'))!.set('p:name', 'Forged'), ORIGIN.local);
    await until(() => refusedV.length > 0, 3000, 'viewer refusal');
    expect(refusedV[0]).toMatch(/view/i);
    const refusedC: string[] = [];
    cm.client.o.onRefused = (m) => refusedC.push(m);
    cm.client.ydoc.transact(() => cm.client.project.layers.get(idOf(cm, 'Background'))!.set('p:name', 'Forged'), ORIGIN.local);
    await until(() => refusedC.length > 0, 3000, 'commenter refusal');
    expect(refusedC[0]).toMatch(/comment/i);
    await settle(a);
    expect(a.binding.history.document.layers[0].name).toBe('Background');
    // After a refusal the editor opens the shared state again (a fresh copy).
    cm.client.close();
    const cm2 = await connect(env, commenter, room);
    cm2.client.o.onRefused = (m) => refusedC.push(m);
    expect(cm2.binding.history.document.layers[0].name).toBe('Background');
    // A commenter's own comment is accepted; one forged in someone else's name is not.
    const comments = new SharedComments(cm2.client);
    comments.add({ x: 10, y: 20 }, 'Looks good @alice');
    await cm2.client.settled();
    await settle(a);
    expect(new SharedComments(a.client).threads().map((t) => t.messages[0].text)).toEqual(['Looks good @alice']);
    cm2.client.ydoc.transact(() => writeThread(cm2.client.ydoc, newThread({ x: 1, y: 1 }, { id: owner.uuid, name: 'alice' }, 'forged')), ORIGIN.comments);
    await until(() => refusedC.length > 1, 3000, 'forged comment refusal');
    expect(refusedC[1]).toMatch(/own/i);
    // Viewers cannot even upload tiles.
    await expect(call(env.sdk(viewer), SERVER, { op: 'asset.put', room, assets: [] })).rejects.toThrow(/view/i);
  });

  it('syncs comment threads, replies and resolution between people', async () => {
    const env = environment();
    const { room, a } = await share(env);
    const b = await connect(env, editor, room, { token: await invite(env, room, 'editor') });
    const ca = new SharedComments(a.client),
      cb = new SharedComments(b.client);
    const t = ca.add({ x: 40, y: 50, width: 100, height: 60 }, 'Brighten this region');
    await settle(a, b);
    expect(cb.threads().map((x) => x.messages[0].text)).toEqual(['Brighten this region']);
    cb.reply(t.id, 'Done, @alice');
    cb.resolve(t.id, true);
    // Concurrent reply from the owner.
    ca.reply(t.id, 'Thanks');
    await settle(a, b);
    for (const c of [ca, cb]) {
      const thread = c.threads()[0];
      expect(thread.messages.map((m) => m.text).sort()).toEqual(['Brighten this region', 'Done, @alice', 'Thanks']);
      expect(thread.resolved?.by.name).toBe('bob');
      expect(thread.anchor).toEqual({ x: 40, y: 50, width: 100, height: 60 });
    }
    ca.resolve(t.id, false);
    await settle(a, b);
    expect(cb.threads()[0].resolved).toBeNull();
    // Comments never enter Undo.
    expect(a.binding.history.canUndo).toBe(false);
  });

  it('undoes only this person’s own steps', async () => {
    const env = environment();
    const { room, a } = await share(env);
    const b = await connect(env, editor, room, { token: await invite(env, room, 'editor') });
    edit(a, 'Opacity', (d) => (d.layers[1].opacity = 0.5));
    await settle(a, b);
    edit(b, 'Hide Fill', (d) => (d.layers[2].visible = false));
    await settle(a, b);
    expect(a.binding.history.labels).toEqual(['Opacity']);
    a.binding.history.undo();
    await settle(a, b);
    for (const p of [a, b]) {
      expect(p.binding.history.document.layers[1].opacity).toBe(1);
      expect(p.binding.history.document.layers[2].visible).toBe(false);
    }
    expect(a.binding.history.redoLabels).toEqual(['Opacity']);
    a.binding.history.redo();
    await settle(a, b);
    expect(b.binding.history.document.layers[1].opacity).toBe(0.5);
    // Selection-only steps are this person's own and undo locally.
    edit(a, 'Select All', (d) => (d.selection = { x: 0, y: 0, width: 600, height: 400 }));
    expect(a.binding.history.labels).toEqual(['Opacity', 'Select All']);
    a.binding.history.undo();
    await a.binding.idle();
    expect(a.binding.history.document.selection).toBeNull();
    expect(a.binding.history.document.layers[1].opacity).toBe(0.5);
  });

  it('sends edits and presence over verified peer links', async () => {
    const env = environment();
    const { room, a } = await share(env, { peers: true });
    // Polling is slow here, so the edit must arrive over the peer link.
    const b = await connect(env, editor, room, { token: await invite(env, room, 'editor'), peers: true, poll: 60_000 });
    await a.client.checkIn();
    await until(() => (a.client.peers?.connectedSessions.length ?? 0) > 0 && (b.client.peers?.connectedSessions.length ?? 0) > 0, 3000, 'peer link');
    a.client.setPresence({ cursor: [12, 34], tool: 'brush', toolLabel: 'Brush Tool', layer: 'x', view: { x: 300, y: 200, zoom: 2 } });
    await until(() => [...b.client.people.values()].some((p) => p.cursor?.[0] === 12), 3000, 'presence');
    const person = [...b.client.people.values()][0];
    expect(person).toMatchObject({ username: 'alice', role: 'owner', tool: 'brush', view: { zoom: 2 } });
    edit(a, 'Rename', (d) => (d.layers[0].name = 'Over the link'));
    await a.binding.idle();
    await a.client.settled();
    await until(() => {
      b.binding.project(true);
      return b.binding.history.document.layers[0].name === 'Over the link';
    }, 3000, 'peer edit');
  });

  it('manages access: roles, removal, expiry, invitations by name and revocation', async () => {
    const env = environment();
    const { room } = await share(env);
    const sdk = env.sdk(owner);
    const b = await connect(env, editor, room, { token: await invite(env, room, 'editor') });
    let list = await call<{ members: { uuid: string; role: string }[]; invites: number }>(sdk, SERVER, { op: 'members', room });
    expect(list.members.map((m) => m.role).sort()).toEqual(['editor', 'owner']);
    expect(list.invites).toBe(1);
    // Editors cannot manage access.
    await expect(call(env.sdk(editor), SERVER, { op: 'invite', room, role: 'editor' })).rejects.toThrow(/owner/);
    await call(sdk, SERVER, { op: 'role', room, uuid: editor.uuid, role: 'viewer' });
    await b.client.sync();
    expect(b.client.role).toBe('viewer');
    await call(sdk, SERVER, { op: 'role', room, uuid: editor.uuid, role: 'editor', expires: env.now - 1 });
    await expect(b.client.sync()).rejects.toThrow(/expired/);
    await call(sdk, SERVER, { op: 'role', room, uuid: editor.uuid, role: 'removed' });
    await expect(b.client.sync()).rejects.toThrow(/access/);
    // An invitation by Puter username admits that person without a link token.
    await call(sdk, SERVER, { op: 'invite-user', room, username: 'cam', role: 'commenter' });
    const c = await connect(env, viewer, room);
    expect(c.client.role).toBe('commenter');
    // Expired and revoked link invitations no longer admit anyone.
    const token = await invite(env, room, 'viewer');
    env.now += 8 * 86_400_000;
    await expect(connect(env, { uuid: '66666666-6666-4666-8666-666666666666', username: 'fay' }, room, { token })).rejects.toThrow(/expired/);
    env.now -= 8 * 86_400_000;
    await call(sdk, SERVER, { op: 'revoke-invites', room });
    await expect(connect(env, { uuid: '77777777-7777-4777-8777-777777777777', username: 'gus' }, room, { token })).rejects.toThrow(/expired or was revoked/);
    list = await call(sdk, SERVER, { op: 'members', room });
    expect(list.invites).toBe(0);
    // Stopping sharing ends access for everyone.
    await call(sdk, SERVER, { op: 'stop', room });
    await expect(c.client.sync()).rejects.toThrow(/stopped sharing/);
  });

  it('refuses tiles that do not match their address and keeps a second worker instance consistent', async () => {
    const env = environment();
    const { room, a } = await share(env);
    await expect(call(env.sdk(owner), SERVER, { op: 'asset.put', room, assets: [{ hash: 'a'.repeat(64), data: 'eJwDAAAAAAE=' }] })).rejects.toThrow(/checksum/);
    // Another instance (its own loaded copy) sees commits made through the first.
    const other = env.instance();
    const b = await connect(env, editor, room, { token: await invite(env, room, 'editor') });
    env.route = (u) => (u.uuid === editor.uuid ? other : undefined);
    edit(b, 'Rename', (d) => (d.layers[0].name = 'Via instance two'));
    await settle(a, b);
    expect(a.binding.history.document.layers[0].name).toBe('Via instance two');
  });
});
