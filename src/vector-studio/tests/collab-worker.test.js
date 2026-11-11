import { describe, it, expect } from 'vitest';
import { network, joinClient, shareNew, settle, rect, content, alice, bob, cam } from './collab-helpers.js';
import { DocService } from '../worker/service.js';
import { authenticate } from '../worker/auth.js';
import { hash, keyPair, sign, shareLink, parseShareLink, workerURL } from '../src/features/collab/protocol.js';
import { tokenClaims } from '../src/features/collab/auth.js';
import { listOps, applyListOps, validateBatch, safeBatch } from '../src/features/collab/ops.js';

const fails = async (p, status) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err, 'expected a refusal').toBeTruthy();
  if (status) expect(err.status).toBe(status);
  return err;
};

describe('collaboration worker access', () => {
  it('only the server owner creates documents', async () => {
    const net = network();
    await fails(net.service.call(bob, { op: 'create', room: 'r1', name: 'x', state: { nodes: { root: { id: 'root', type: 'root', children: [] } } } }), 403);
  });

  it('admits people with an invitation, by username, or as members; refuses others', async () => {
    const net = network();
    const { room } = await shareNew(net);
    await fails(net.service.call(bob, { op: 'join', room }), 403);
    await fails(net.service.call(bob, { op: 'join', room, invite: 'not-a-token' }), 403);
    await fails(net.service.call(bob, { op: 'sync', room, since: 0 }), 403);
    await net.service.call(alice, { op: 'invite-user', room, username: '@Bob', role: 'commenter' });
    const joined = await net.service.call(bob, { op: 'join', room });
    expect(joined.role).toBe('commenter');
    // A member keeps access without the invitation.
    expect((await net.service.call(bob, { op: 'join', room })).role).toBe('commenter');
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'viewer' });
    expect((await net.service.call(cam, { op: 'join', room, invite: token })).role).toBe('viewer');
  });

  it('only the owner manages access', async () => {
    const net = network();
    const { room } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    await net.service.call(bob, { op: 'join', room, invite: token });
    await fails(net.service.call(bob, { op: 'invite', room, role: 'editor' }), 403);
    await fails(net.service.call(bob, { op: 'role', room, uuid: alice.uuid, role: 'viewer' }), 403);
    await fails(net.service.call(alice, { op: 'role', room, uuid: alice.uuid, role: 'viewer' }), 400);
    await fails(net.service.call(alice, { op: 'invite', room, role: 'owner' }), 400);
  });

  it('expired and withdrawn invitations stop working', async () => {
    const net = network();
    const { room } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    await net.service.call(alice, { op: 'revoke-invites', room });
    await fails(net.service.call(bob, { op: 'join', room, invite: token }), 403);
    const later = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const service = new DocService(net.puter, { now: () => Date.now() + 31 * 86400000 });
    await fails(service.call(bob, { op: 'join', room, invite: later.token }), 403);
  });

  it('enforces roles on edits: viewers refused, commenters only comment', async () => {
    const net = network();
    const { room } = await shareNew(net);
    const v = await net.service.call(alice, { op: 'invite', room, role: 'viewer' });
    const c = await net.service.call(alice, { op: 'invite', room, role: 'commenter' });
    await net.service.call(cam, { op: 'join', room, invite: v.token });
    await net.service.call(bob, { op: 'join', room, invite: c.token });
    const edit = { id: 'b1', nodes: [{ id: 'p', put: rect('p') }] };
    await fails(net.service.call(cam, { op: 'commit', room, batch: edit }), 403);
    await fails(net.service.call(bob, { op: 'commit', room, batch: edit }), 403);
    await fails(net.service.call(cam, { op: 'commit', room, batch: { id: 'b2', comments: [] } }), 403);
    const ok = await net.service.call(bob, { op: 'commit', room, batch: { id: 'b3', comments: [{ t: 'th', create: { author: { id: bob.uuid, name: 'bob' }, anchor: { x: 0, y: 0 }, created: 1 } }] } });
    expect(ok.seq).toBe(1);
  });

  it('removing someone and stopping sharing end access', async () => {
    const net = network();
    const { room, client: a } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const b = await joinClient(net, bob, room, { invite: token });
    await net.service.call(alice, { op: 'role', room, uuid: bob.uuid, role: 'removed' });
    const ended = [];
    b.session.on('ended', (e) => ended.push(e));
    await b.session.sync();
    expect(ended[0]?.kind).toBe('removed');
    await fails(net.service.call(bob, { op: 'join', room, invite: token }), 403);
    await net.service.call(alice, { op: 'stop', room });
    await fails(net.service.call(alice, { op: 'sync', room, since: 0 }), 410);
    expect(a.session.closed).toBe(false);
  });

  it('a role change reaches the participant on the next sync', async () => {
    const net = network();
    const { room } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const b = await joinClient(net, bob, room, { invite: token });
    const roles = [];
    b.session.on('role', (r) => roles.push(r));
    await net.service.call(alice, { op: 'role', room, uuid: bob.uuid, role: 'viewer' });
    await b.session.sync();
    expect(roles).toEqual(['viewer']);
    expect(b.session.canEdit).toBe(false);
  });

  it('rejects malformed batches', () => {
    expect(() => validateBatch({ id: 'x', nodes: [{ id: 'root', del: true }] })).toThrow(/root/);
    expect(() => validateBatch({ id: 'x', nodes: [{ id: 'a', set: { children: [] } }] })).toThrow();
    expect(() => validateBatch({ id: 'x', nodes: [{ id: 'bad id!', del: true }] })).toThrow();
    expect(() => validateBatch({ id: 'x', nodes: [{ id: 'a', put: { type: 'path' }, del: true }] })).toThrow();
    expect(validateBatch({ id: 'x', nodes: [{ id: 'a', set: { name: 'n' }, kids: [['+', 'b', null, null]] }] })).toBeTruthy();
  });

  it('refuses document settings that would break everyone\'s copy', async () => {
    const net = network();
    const { room, client: a } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const b = await joinClient(net, bob, room, { invite: token });
    const bad = [
      { id: 'root', set: { type: 'group' } },
      { id: 'root', set: { artboards: 'junk' } },
      { id: 'root', set: { artboards: [] } },
      { id: 'root', set: { artboards: [{ x: 0, y: 0, w: 0, h: 10 }] } },
      { id: 'root', set: { grid: null } },
      { id: 'root', set: { parent: 'l1' } },
      { id: 'root', unset: ['swatches'] },
      { id: 'root', put: { type: 'root', children: [] } },
      { id: 'p', put: { ...rect('p'), type: 'root' } },
    ];
    let n = 0;
    for (const op of bad) await fails(net.service.call(bob, { op: 'commit', room, batch: { id: `bad${n++}`, nodes: [op] } }), 400);
    // Ordinary document settings still go through.
    const ok = await net.service.call(bob, { op: 'commit', room, batch: { id: 'ok', nodes: [{ id: 'root', set: { units: 'mm', artboards: [{ id: 'a1', name: 'A', x: 0, y: 0, w: 50, h: 50 }] } }] } });
    expect(ok.seq).toBe(1);
    await settle(a, b);
    expect(a.doc.root.units).toBe('mm');
    expect(content(a.doc)).toEqual(content(b.doc));
  });

  it('clients leave out harmful changes an older server let through, all alike', async () => {
    const net = network();
    const { room, client: a } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const b = await joinClient(net, bob, room, { invite: token });
    // An older server stored this without checking it.
    const seq = await net.puter.kv.incr(`vs:${room}:seq`);
    const batch = { id: 'old', nodes: [{ id: 'root', set: { artboards: 'junk', units: 'in' } }, { id: 'root', set: { name: 'Renamed' } }, { id: 'p', put: { ...rect('p'), parent: a.doc.layers()[0].id } }] };
    await net.puter.kv.set(`vs:${room}:log:${seq}`, { seq, batch, by: { uuid: bob.uuid, username: 'bob' }, time: Date.now() });
    expect(safeBatch(batch).nodes.map((op) => op.id)).toEqual(['root', 'p']);
    await settle(a, b);
    expect(Array.isArray(a.doc.root.artboards)).toBe(true);
    expect(a.doc.root.name).toBe('Renamed');
    expect(a.doc.has('p')).toBe(true);
    expect(content(a.doc)).toEqual(content(b.doc));
    // A newcomer gets the same document from the server.
    const c = await joinClient(net, alice, room);
    expect(content(c.doc)).toEqual(content(a.doc));
  });

  it('presence returns the roster with a ticket signed by the room key', async () => {
    const net = network();
    const { room } = await shareNew(net);
    const join = await net.service.call(alice, { op: 'join', room });
    const keys = await keyPair();
    const res = await net.service.call(alice, { op: 'presence', room, session: 's1', publicKey: keys.publicKey, state: { cursor: { x: 1, y: 2 }, selection: ['a', 'bad id!'], view: { x: 0, y: 0, w: 10, h: 10 } } });
    expect(res.roster).toHaveLength(1);
    expect(res.roster[0].state).toEqual({ cursor: { x: 1, y: 2 }, selection: ['a'], view: { x: 0, y: 0, w: 10, h: 10 } });
    const { verify } = await import('../src/features/collab/protocol.js');
    expect(await verify(join.publicKey, res.ticket, res.signature)).toBe(true);
    await fails(net.service.call(bob, { op: 'presence', room, session: 's1', publicKey: keys.publicKey }), 403);
  });
});

describe('request authentication', () => {
  function token(uuid, exp = Math.floor(Date.now() / 1000) + 3600) {
    return `h.${btoa(JSON.stringify({ t: 't', uu: btoa(String.fromCharCode(...uuid.replaceAll('-', '').match(/../g).map((x) => parseInt(x, 16)))), exp }))}.s`;
  }

  it('accepts a signed request from the identity file owner and refuses tampering', async () => {
    const keys = await keyPair();
    const files = new Map([['/bob/AppData/id.json', JSON.stringify({ version: 1, publicKey: keys.publicKey })]]);
    const puter = {
      fs: {
        stat: async (path) => ({ path, is_shared: false, owner: { username: 'bob' }, is_dir: false, size: 100 }),
        read: async (path) => new Blob([files.get(path)]),
      },
    };
    const t = token(bob.uuid);
    expect(tokenClaims(t)).toMatchObject({ type: 'access-token', user_uid: bob.uuid });
    const input = { op: 'sync', room: 'r', since: 0 };
    const signature = await sign(keys.privateKey, ['https://vs.puter.work', '/bob/AppData/id.json', await hash(JSON.stringify(input))]);
    const request = (body = input, proof = { version: 1, path: '/bob/AppData/id.json', signature }) => ({ url: 'https://vs.puter.work/api', headers: new Map([['puter-auth', t], ['x-vector-studio-proof', JSON.stringify(proof)]]) });
    expect(await authenticate(request(), puter, input)).toEqual({ uuid: bob.uuid, username: 'bob' });
    await fails(authenticate(request(), puter, { ...input, since: 5 }), 401);
    // A key file the caller does not own (Puter reports is_shared: null) proves nothing.
    const other = '/mallory/AppData/id.json';
    files.set(other, files.get('/bob/AppData/id.json'));
    const otherSig = await sign(keys.privateKey, ['https://vs.puter.work', other, await hash(JSON.stringify(input))]);
    const shared = { ...puter, fs: { ...puter.fs, stat: async () => ({ is_shared: null, owner: { username: 'mallory' }, size: 1 }) } };
    await fails(authenticate(request(input, { version: 1, path: other, signature: otherSig }), shared, input), 401);
  });
});

describe('protocol helpers', () => {
  it('builds and parses share links', () => {
    const link = shareLink('https://vs-abc.puter.work', 'room1', 'tok', 'https://app.example/vector/');
    expect(parseShareLink(link, 'https://app.example/')).toEqual({ server: 'https://vs-abc.puter.work', room: 'room1', invite: 'tok' });
    expect(parseShareLink('https://app.example/#doc=x', 'https://app.example/')).toBe(null);
    expect(() => workerURL('https://evil.example.com')).toThrow();
  });

  it('list ops turn one children list into another', () => {
    const cases = [
      [['a', 'b', 'c'], ['c', 'a', 'b']],
      [['a', 'b', 'c'], ['a', 'x', 'c']],
      [[], ['a', 'b']],
      [['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a']],
    ];
    for (const [a, b] of cases) expect(applyListOps(a, listOps(a, b))).toEqual(b);
  });
});
