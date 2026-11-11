import { describe, it, expect } from 'vitest';
import { network, joinClient, shareNew, settle, rect, content, alice, bob, cam } from './collab-helpers.js';
import { memoryOutbox } from '../src/features/collab/outbox.js';
import { CollabSession } from '../src/features/collab/session.js';
import { call } from '../src/features/collab/api.js';
import { SERVER } from './collab-helpers.js';

async function pair() {
  const net = network();
  const { room, client: a } = await shareNew(net);
  const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
  const b = await joinClient(net, bob, room, { invite: token });
  return { net, room, a, b };
}

const layerOf = (doc) => doc.root.children[0];

describe('collaboration sync', () => {
  it('sends edits to other participants', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.transact('Add', () => a.doc.insert(rect('p1'), L));
    await settle(a, b);
    expect(b.doc.get('p1')?.parent).toBe(L);
    expect(b.doc.get(L).children).toEqual(['p1']);
    expect(content(a.doc)).toEqual(content(b.doc));
  });

  it('keeps both of two concurrent additions to one layer', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.transact('Add', () => a.doc.insert(rect('pa'), L));
    b.doc.transact('Add', () => b.doc.insert(rect('pb'), L));
    await settle(a, b);
    expect(new Set(a.doc.get(L).children)).toEqual(new Set(['pa', 'pb']));
    expect(content(a.doc)).toEqual(content(b.doc));
  });

  it('merges concurrent changes to different fields and picks one value for the same field', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.transact('Add', () => a.doc.insert(rect('p'), L));
    await settle(a, b);
    a.doc.transact('Fill', () => a.doc.update('p', { fill: { type: 'solid', color: '#00ff00' } }));
    b.doc.transact('Opacity', () => b.doc.update('p', { opacity: 0.5 }));
    a.doc.transact('Name', () => a.doc.update('p', { name: 'from a' }));
    b.doc.transact('Name', () => b.doc.update('p', { name: 'from b' }));
    await settle(a, b);
    const p = a.doc.get('p');
    expect(p.fill.color).toBe('#00ff00');
    expect(p.opacity).toBe(0.5);
    expect(['from a', 'from b']).toContain(p.name);
    expect(content(a.doc)).toEqual(content(b.doc));
  });

  it('removal wins over a concurrent edit, and children of a removed group survive', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.transact('Add', () => {
      a.doc.insert({ id: 'g', type: 'group', name: '', children: [], clip: false }, L);
      a.doc.insert(rect('x'), 'g');
      a.doc.insert(rect('y'), L);
    });
    await settle(a, b);
    // a deletes the group (and x); b edits y and draws z into the group.
    a.doc.transact('Delete', () => a.doc.remove('g'));
    b.doc.transact('Edit', () => {
      b.doc.update('x', { name: 'renamed' });
      b.doc.insert(rect('z'), 'g');
    });
    await settle(a, b);
    expect(a.doc.has('g')).toBe(false);
    expect(a.doc.has('x')).toBe(false);
    // z was drawn into the group after it was removed elsewhere: it moves up.
    expect(a.doc.get('z')?.parent).toBe(L);
    expect(a.doc.get(L).children).toContain('z');
    expect(content(a.doc)).toEqual(content(b.doc));
  });

  it('concurrent moves of one object into two containers leave it in exactly one', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.transact('Setup', () => {
      a.doc.insert({ id: 'g1', type: 'group', name: '', children: [], clip: false }, L);
      a.doc.insert({ id: 'g2', type: 'group', name: '', children: [], clip: false }, L);
      a.doc.insert(rect('x'), L);
    });
    await settle(a, b);
    a.doc.transact('Move', () => a.doc.move('x', 'g1'));
    b.doc.transact('Move', () => b.doc.move('x', 'g2'));
    await settle(a, b);
    const holders = [...a.doc.nodes.values()].filter((n) => n.children?.includes('x')).map((n) => n.id);
    expect(holders).toHaveLength(1);
    expect(a.doc.get('x').parent).toBe(holders[0]);
    expect(content(a.doc)).toEqual(content(b.doc));
  });

  it('reorders merge with concurrent additions', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.transact('Setup', () => ['p1', 'p2', 'p3'].forEach((id) => a.doc.insert(rect(id), L)));
    await settle(a, b);
    a.doc.transact('Front', () => a.doc.move('p1', L)); // to front
    b.doc.transact('Add', () => b.doc.insert(rect('p4'), L, 1));
    await settle(a, b);
    const kids = a.doc.get(L).children;
    // p1 went to the front; p4 was inserted next to p1, which moved.
    expect(kids.slice(0, 2)).toEqual(['p2', 'p3']);
    expect(kids).toContain('p4');
    expect(new Set(kids).size).toBe(4);
    expect(content(a.doc)).toEqual(content(b.doc));
  });

  it('converges under many interleaved random edits', async () => {
    const { a, b, net, room } = await pair();
    const c = await joinClient(net, cam, room, { invite: (await net.service.call(alice, { op: 'invite', room, role: 'editor' })).token });
    const clients = [a, b, c];
    const L = layerOf(a.doc);
    let n = 0;
    let seed = 7;
    const rand = (k) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % k);
    for (let step = 0; step < 60; step++) {
      const cl = clients[rand(3)];
      const doc = cl.doc;
      const leaves = [...doc.nodes.values()].filter((x) => x.type === 'path');
      const groups = [...doc.nodes.values()].filter((x) => x.type === 'group');
      const kind = rand(6);
      doc.transact('Random', () => {
        if (kind === 0 || !leaves.length) doc.insert(rect(`r${++n}`, rand(100), rand(100)), groups.length && rand(2) ? groups[0].id : L, rand(4));
        else if (kind === 1) doc.update(leaves[rand(leaves.length)].id, { opacity: rand(10) / 10 });
        else if (kind === 2) doc.remove(leaves[rand(leaves.length)].id);
        else if (kind === 3) doc.insert({ id: `g${++n}`, type: 'group', name: '', children: [], clip: false }, L);
        else if (kind === 4 && groups.length) doc.move(leaves[rand(leaves.length)].id, groups[rand(groups.length)].id);
        else if (kind === 5 && groups.length) doc.remove(groups[rand(groups.length)].id);
      });
      if (rand(4) === 0) await settle(cl);
    }
    await settle(...clients);
    expect(content(b.doc)).toEqual(content(a.doc));
    expect(content(c.doc)).toEqual(content(a.doc));
    // The tree is consistent: every listed child names its container, every node is listed once.
    const listed = new Map();
    for (const node of a.doc.nodes.values()) for (const k of node.children || []) {
      expect(a.doc.get(k)?.parent).toBe(node.id);
      listed.set(k, (listed.get(k) || 0) + 1);
    }
    for (const node of a.doc.nodes.values()) if (node.id !== 'root') expect(listed.get(node.id)).toBe(1);
  });

  it('keeps undo local: undoing your edit does not revert someone else\'s', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.transact('Add', () => a.doc.insert(rect('p'), L));
    await settle(a, b);
    a.doc.transact('Fill', () => a.doc.update('p', { fill: { type: 'solid', color: '#0000ff' } }));
    await settle(a, b);
    b.doc.transact('Opacity', () => b.doc.update('p', { opacity: 0.25 }));
    b.doc.transact('Add', () => b.doc.insert(rect('q'), L));
    await settle(a, b);
    expect(a.doc.get('p').opacity).toBe(0.25);
    // Remote edits are not in a's history.
    expect(a.doc.undoStack.map((r) => r.label)).toEqual(['Add', 'Fill']);
    a.doc.undo();
    expect(a.doc.get('p').fill.color).toBe('#ff0000');
    expect(a.doc.get('p').opacity).toBe(0.25);
    expect(a.doc.has('q')).toBe(true);
    await settle(a, b);
    expect(b.doc.get('p').fill.color).toBe('#ff0000');
    expect(b.doc.get('p').opacity).toBe(0.25);
    a.doc.redo();
    await settle(a, b);
    expect(b.doc.get('p').fill.color).toBe('#0000ff');
    expect(content(a.doc)).toEqual(content(b.doc));
  });

  it('undo of an addition keeps objects others added to the same layer', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.transact('Add', () => a.doc.insert(rect('mine'), L));
    await settle(a, b);
    b.doc.transact('Add', () => b.doc.insert(rect('theirs'), L));
    await settle(a, b);
    a.doc.undo();
    expect(a.doc.get(L).children).toEqual(['theirs']);
    await settle(a, b);
    expect(b.doc.get(L).children).toEqual(['theirs']);
    a.doc.redo();
    await settle(a, b);
    expect(new Set(b.doc.get(L).children)).toEqual(new Set(['mine', 'theirs']));
  });

  it('a field someone else changed later is not reverted by undo', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.transact('Add', () => a.doc.insert(rect('p'), L));
    a.doc.transact('Name', () => a.doc.update('p', { name: 'one' }));
    await settle(a, b);
    b.doc.transact('Name', () => b.doc.update('p', { name: 'two' }));
    await settle(a, b);
    a.doc.undo();
    expect(a.doc.get('p').name).toBe('two');
  });

  it('applies remote edits after an open local gesture commits', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.transact('Add', () => a.doc.insert(rect('p'), L));
    await settle(a, b);
    const tx = b.doc.begin('Drag');
    b.doc.update('p', { anchors: rect('p', 50, 50).anchors });
    a.doc.transact('Fill', () => a.doc.update('p', { fill: { type: 'solid', color: '#123456' } }));
    await settle(a);
    await b.session.sync();
    expect(b.doc.get('p').fill.color).toBe('#ff0000'); // deferred while dragging
    tx.commit();
    expect(b.doc.get('p').fill.color).toBe('#123456');
    expect(b.doc.get('p').anchors[0].x).toBe(50);
    await settle(a, b);
    expect(content(a.doc)).toEqual(content(b.doc));
  });

  it('keeps edits made offline and sends them when the connection returns', async () => {
    const { a, b, net } = await pair();
    const L = layerOf(a.doc);
    net.offline.add(bob.uuid);
    b.doc.transact('Add', () => b.doc.insert(rect('offline1'), L));
    b.doc.transact('Add', () => b.doc.insert(rect('offline2'), L));
    await b.session.sending;
    expect(b.session.status).toBe('offline');
    expect(b.session.pending.length).toBeGreaterThan(0);
    a.doc.transact('Add', () => a.doc.insert(rect('online'), L));
    await settle(a);
    net.offline.delete(bob.uuid);
    await b.session.sync();
    await settle(a, b);
    for (const doc of [a.doc, b.doc]) expect(new Set(doc.get(L).children)).toEqual(new Set(['offline1', 'offline2', 'online']));
    expect(b.session.pending).toHaveLength(0);
    expect(b.doc.dirty).toBe(false);
  });

  it('recovers unsent edits after a reload', async () => {
    const { a, net, room } = await pair();
    const outbox = memoryOutbox();
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const b = await joinClient(net, bob, room, { invite: token, outbox });
    const L = layerOf(b.doc);
    net.offline.add(bob.uuid);
    b.doc.transact('Add', () => b.doc.insert(rect('kept'), L));
    await b.session.sending;
    b.session.close({ leave: false });
    await b.session.persisting;
    net.offline.delete(bob.uuid);
    const again = await joinClient(net, bob, room, { outbox });
    expect(again.doc.has('kept')).toBe(true);
    await settle(again, a);
    expect(a.doc.has('kept')).toBe(true);
  });

  it('a lost acknowledgement does not apply an edit twice', async () => {
    const { a, b, net } = await pair();
    const L = layerOf(a.doc);
    net.lostAck = true;
    b.doc.transact('Add', () => b.doc.insert(rect('once'), L));
    await b.session.sending;
    net.offline.clear();
    await settle(a, b);
    expect(a.doc.get(L).children.filter((c) => c === 'once')).toHaveLength(1);
    expect(b.session.pending).toHaveLength(0);
    const seqs = [...net.puter.kv.data.keys()].filter((k) => k.includes(':log:'));
    expect(seqs).toHaveLength(1);
  });

  it('an edit made right after a lost acknowledgement is not folded into the batch the server already took', async () => {
    const { a, b, net } = await pair();
    const L = layerOf(a.doc);
    net.lostAck = true;
    b.doc.transact('Add', () => b.doc.insert(rect('first'), L));
    await b.session.sending;
    b.doc.transact('Add', () => b.doc.insert(rect('second'), L));
    await settle(a, b);
    for (const doc of [a.doc, b.doc]) expect(new Set(doc.get(L).children)).toEqual(new Set(['first', 'second']));
    expect(b.session.pending).toHaveLength(0);
  });

  it('opens the device copy when the connection is down before a credential could be loaded', async () => {
    const { a, room } = await pair();
    // This device kept a copy from an earlier session.
    const outbox = memoryOutbox();
    const key = `${SERVER}|${room}|${bob.uuid}`;
    await outbox.put(key, { seq: 0, state: { nodes: Object.fromEntries(a.doc.nodes), assets: {}, comments: null }, pending: [], role: 'editor' });
    // After a reload the credential has to be read from Puter storage first, and the network is down.
    const offline = () => Promise.reject(new TypeError('Failed to fetch'));
    const puter = { authToken: 'session-token', kv: { get: offline, set: offline }, fs: { write: offline }, workers: { exec: offline } };
    const session = new CollabSession({ transport: { call: (input) => call(puter, SERVER, input) }, server: SERVER, room, user: bob, outbox, timers: false });
    const data = await session.join();
    expect(session.status).toBe('offline');
    expect(Object.keys(data.nodes)).toEqual([...a.doc.nodes.keys()]);
  });

  it('new participants load a checkpoint plus later edits', async () => {
    const { a, net, room } = await pair();
    const L = layerOf(a.doc);
    for (let i = 0; i < 205; i++) {
      a.doc.transact('Add', () => a.doc.insert(rect(`n${i}`), L));
      await a.session.sending;
      await new Promise((r) => setTimeout(r, 0));
      // Each enqueue merges into the previous unsent batch; force separate batches.
      a.session.pending.forEach((p) => (p.sent = true));
    }
    await settle(a);
    const cp = await net.puter.kv.get(`vs:${room}:cp`);
    expect(cp.seq).toBeGreaterThanOrEqual(200);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'viewer' });
    const c = await joinClient(net, cam, room, { invite: token });
    expect(c.doc.get(L).children).toHaveLength(205);
    expect(content(c.doc)).toEqual(content(a.doc));
  });

  it('syncs images with the edit that places them', async () => {
    const { a, b } = await pair();
    const L = layerOf(a.doc);
    a.doc.assets.set('img1', { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
    a.doc.transact('Place', () => a.doc.insert({ id: 'i1', type: 'image', asset: 'img1', width: 10, height: 10, transform: [1, 0, 0, 1, 0, 0] }, L));
    await settle(a, b);
    expect(b.doc.assets.get('img1')?.data).toBe('data:image/png;base64,AAAA');
  });
});
