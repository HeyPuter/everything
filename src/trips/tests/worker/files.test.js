// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sniff, typeFor } from '../../worker/engine/files.js';
import { K, P } from '../../worker/keys.js';
import { USERS, createHarness, expectError, id } from './harness.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode('%PDF-1.7\n...');
const SHA = 'a'.repeat(64);

async function setup(options = {}) {
  const h = await createHarness(options);
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => h.client(name)));
  return { h, space, alice, bob, carol };
}

const upload = (client, space, fileId, body) => client.raw('PUT', `/files/${space}/${fileId}`, { body, signed: `PUT /files/${space}/${fileId}` });
const download = (client, space, fileId) => client.raw('GET', `/files/${space}/${fileId}`, { signed: `GET /files/${space}/${fileId}` });

describe('file types', () => {
  it('sniffs magic bytes and refuses markup', () => {
    expect(sniff(PNG)).toBe('png');
    expect(sniff(PDF)).toBe('pdf');
    expect(sniff(new TextEncoder().encode('a,b\n1,2'))).toBe('text');
    expect(sniff(new TextEncoder().encode('  <svg onload=alert(1)>'))).toBe('markup');
    expect(sniff(new Uint8Array([0, 1, 2]))).toBe('binary');
    expect(() => typeFor('x.svg', 'image/svg+xml', 'user')).toThrow();
    expect(() => typeFor('x.html', 'text/html', 'user')).toThrow();
    expect(() => typeFor('x.png', 'image/jpeg', 'user')).toThrow();
    expect(() => typeFor('route.gz', 'application/gzip', 'track')).toThrow();
    expect(typeFor('route.geojson.gz', 'application/gzip', 'track').sniff).toBe('gzip');
    expect(() => typeFor('route.geojson.gz', 'application/gzip', 'user')).toThrow();
  });
});

describe('proxied files', () => {
  it('uploads, registers and downloads through the worker for members only', async () => {
    const { h, space, alice, bob, carol } = await setup({ ownerVerified: false });
    const fileId = id('f');
    const put = await upload(bob, space, fileId, PNG);
    expect(put.status).toBe(200);
    expect(h.kv()[K.pending(space)][fileId]).toMatchObject({ uuid: USERS.bob.uuid, size: PNG.length, sniff: 'png' });
    const registered = await bob.in(space).call('file.put', { fileId, name: 'pic.png', mime: 'image/png', sha256: SHA, kind: 'user' });
    expect(registered.ents[0]).toMatchObject({ t: 'file', id: fileId, size: PNG.length, loc: { mode: 'proxied', uid: expect.stringMatching(UUID) }, by: USERS.bob.uuid });
    expect(registered.ents[0].loc.uid).toBe((await alice.puter.fs.stat(`${P.file(space, fileId)}/data`)).uid);
    expect(h.kv()[K.pending(space)][fileId]).toBeUndefined();
    expect(h.kv()[K.count(space)].bytes).toBe(PNG.length);
    const got = await download(carol, space, fileId);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    expect((await download(await h.client('dave'), space, fileId)).status).toBe(403);
    expect((await upload(carol, space, id('f'), PNG)).status).toBe(403);
    expect((await bob.raw('GET', `/files/${space}/${fileId}`, { signed: `PUT /files/${space}/${fileId}` })).status).toBe(401);
    expect(alice).toBeTruthy();
  });

  it('rejects markup, wrong declared types, oversize bodies and stolen uploads', async () => {
    const { h, space, bob, alice } = await setup({ ownerVerified: false });
    expect((await upload(bob, space, id('f'), new TextEncoder().encode('<html><script>x</script>'))).status).toBe(415);
    const fileId = id('f');
    await upload(bob, space, fileId, PNG);
    await expectError(bob.in(space).call('file.put', { fileId, name: 'doc.pdf', mime: 'application/pdf', sha256: SHA, kind: 'user' }), 415, 'file_type');
    await expectError(alice.in(space).call('file.put', { fileId, name: 'pic.png', mime: 'image/png', sha256: SHA, kind: 'user' }), 404, 'upload_missing');
    expect((await upload(alice, space, fileId, PNG)).status).toBe(409);
    const big = await bob.raw('PUT', `/files/${space}/${id('f')}`, { body: new Uint8Array(10), signed: `PUT /files/${space}/x`, headers: { 'content-length': String(60 * 1024 * 1024) } });
    expect([401, 413]).toContain(big.status);
    const oversized = id('f');
    const response = await bob.raw('PUT', `/files/${space}/${oversized}`, { body: new Uint8Array(50 * 1024 * 1024 + 1), signed: `PUT /files/${space}/${oversized}` });
    expect(response.status).toBe(413);
    expect(h).toBeTruthy();
  });

  it('enforces daily upload budgets and the space quota', async () => {
    const { h, space, bob, alice } = await setup({ ownerVerified: false });
    const day = Math.floor(h.now() / 86_400_000);
    await alice.puter.kv.set(K.rl(space, 'up', USERS.bob.uuid, day), 200);
    expect((await upload(bob, space, id('f'), PNG)).status).toBe(429);
    h.advance(86_400_000);
    await alice.puter.kv.update(K.count(space), { bytes: 2 * 1024 ** 3 });
    expect((await upload(bob, space, id('f'), PNG)).status).toBe(413);
  });

  it('meters proxied downloads per member per day', async () => {
    const { h, space, bob, carol, alice } = await setup({ ownerVerified: false });
    const fileId = id('f');
    await upload(bob, space, fileId, PNG);
    await bob.in(space).call('file.put', { fileId, name: 'pic.png', mime: 'image/png', sha256: SHA, kind: 'user' });
    await alice.puter.kv.set(K.rl(space, 'dlb', USERS.carol.uuid, Math.floor(h.now() / 86_400_000)), 2 * 1024 ** 3);
    expect((await download(carol, space, fileId)).status).toBe(429);
    expect((await download(bob, space, fileId)).status).toBe(200);
  });

  it('counts unregistered uploads against the space quota', async () => {
    const { space, bob, alice } = await setup({ ownerVerified: false });
    await alice.puter.kv.set(K.pending(space), { z000000000000001: { uuid: USERS.bob.uuid, size: 2 * 1024 ** 3, at: 1, sniff: 'png' } });
    expect((await upload(bob, space, id('f'), PNG)).status).toBe(413);
  });

  it('never sweeps the bytes of a registered file whose pending entry survived', async () => {
    const { h, space, alice, bob, carol } = await setup({ ownerVerified: false });
    const fileId = id('f');
    await upload(bob, space, fileId, PNG);
    await bob.in(space).call('file.put', { fileId, name: 'pic.png', mime: 'image/png', sha256: SHA, kind: 'user' });
    await alice.puter.kv.update(K.pending(space), { [fileId]: { uuid: USERS.bob.uuid, size: PNG.length, at: h.now(), sniff: 'png' } });
    h.advance(2 * 3_600_000);
    await alice.in(space).call('open');
    await h.settle();
    expect(h.kv()[K.pending(space)][fileId]).toBeUndefined();
    expect((await download(carol, space, fileId)).status).toBe(200);
  });

  it('trashes, restores and purges with files.delete', async () => {
    const { h, space, bob, carol } = await setup({ ownerVerified: false });
    const fileId = id('f');
    await upload(bob, space, fileId, PDF);
    await bob.in(space).call('file.put', { fileId, name: 'ticket.pdf', mime: 'application/pdf', sha256: SHA, kind: 'user' });
    await expectError(carol.in(space).call('file.del', { fileId }), 403, 'forbidden');
    await expectError(bob.in(space).call('file.del', { fileId, purge: true }), 409, 'not_trashed');
    expect((await bob.in(space).call('file.del', { fileId })).ents[0].trashed).toBe(h.now());
    expect((await bob.in(space).call('file.del', { fileId, restore: true })).ents[0].trashed).toBeUndefined();
    await bob.in(space).call('file.del', { fileId });
    const purged = await bob.in(space).call('file.del', { fileId, purge: true });
    expect(purged.del).toEqual([{ t: 'file', id: fileId, v: expect.any(String) }]);
    expect(h.kv()[K.count(space)].bytes).toBe(0);
    await expect(bob.puter.fs.stat(`/alice/AppData/trips/${P.file(space, fileId)}/data`)).rejects.toBeTruthy();
    await expectError(bob.in(space).call('commit', { ops: [{ opId: id('o'), t: 'file', id: fileId, set: { star: true } }] }), 409, 'gone');
  });
});

describe('direct files', () => {
  it('moves a validated inbox upload into files/ where members read it by path', async () => {
    const { h, space, bob, carol } = await setup();
    const fileId = id('f');
    const inbox = `/alice/AppData/trips/${P.inboxOf(space, USERS.bob.uuid)}`;
    await bob.puter.fs.write(`${inbox}/upload-1.pdf`, new Blob([PDF]));
    const result = await bob.in(space).call('file.put', { fileId, inboxName: 'upload-1.pdf', name: 'Ticket.pdf', mime: 'application/pdf', sha256: SHA, kind: 'user' });
    expect(result.ents[0]).toMatchObject({ loc: { mode: 'direct', uid: expect.stringMatching(UUID) }, size: PDF.length, name: 'Ticket.pdf' });
    const stored = `/alice/AppData/trips/${P.file(space, fileId)}/Ticket.pdf`;
    expect(new Uint8Array(await (await carol.puter.fs.read({ uid: result.ents[0].loc.uid })).arrayBuffer())).toEqual(PDF);
    expect(new Uint8Array(await (await carol.puter.fs.read(stored)).arrayBuffer())).toEqual(PDF);
    await expect(carol.puter.fs.write(stored, 'overwrite')).rejects.toMatchObject({ status: 403 });
    await expect(bob.puter.fs.stat(`${inbox}/upload-1.pdf`)).rejects.toBeTruthy();
    expect(new Uint8Array(await (await download(carol, space, fileId)).arrayBuffer())).toEqual(PDF);
    expect(h).toBeTruthy();
  });

  it('deletes rejected inbox uploads', async () => {
    const { space, bob } = await setup();
    const inbox = `/alice/AppData/trips/${P.inboxOf(space, USERS.bob.uuid)}`;
    await bob.puter.fs.write(`${inbox}/evil.pdf`, '<html><script>alert(1)</script></html>');
    await expectError(bob.in(space).call('file.put', { fileId: id('f'), inboxName: 'evil.pdf', name: 'evil.pdf', mime: 'application/pdf', sha256: SHA, kind: 'user' }), 415, 'file_type');
    await expect(bob.puter.fs.stat(`${inbox}/evil.pdf`)).rejects.toBeTruthy();
    await expectError(bob.in(space).call('file.put', { fileId: id('f'), inboxName: '../x', name: 'x.pdf', mime: 'application/pdf', sha256: SHA, kind: 'user' }), 400);
  });

  it('re-checks the moved copy so an inbox rewrite during file.put is refused', async () => {
    const { h, space, bob } = await setup();
    const fileId = id('f');
    const inbox = `/alice/AppData/trips/${P.inboxOf(space, USERS.bob.uuid)}`;
    await bob.puter.fs.write(`${inbox}/race.pdf`, new Blob([PDF]));
    const fs = h.workers[0].fs;
    const move = fs.move;
    fs.move = async (from, to) => { await bob.puter.fs.write(`${inbox}/race.pdf`, '<html><script>x</script></html>'); return move.call(fs, from, to); };
    try {
      await expectError(bob.in(space).call('file.put', { fileId, inboxName: 'race.pdf', name: 'race.pdf', mime: 'application/pdf', sha256: SHA, kind: 'user' }), 415, 'file_type');
    } finally { fs.move = move; }
    await expect(bob.puter.fs.stat(`/alice/AppData/trips/${P.file(space, fileId)}`)).rejects.toBeTruthy();
    expect(h.kv()[K.entity(space, 'file', fileId)]).toBeUndefined();
  });

  it('bounds unregistered proxied uploads', async () => {
    const { space, bob, alice } = await setup({ ownerVerified: false });
    await alice.puter.kv.set(K.pending(space), Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`z${String(i).padStart(15, '0')}`, { uuid: USERS.alice.uuid, size: 1, at: 1, sniff: 'png' }])));
    expect((await upload(bob, space, id('f'), PNG)).status).toBe(429);
  });

  it('does not purge a file restored after the snapshot was built', async () => {
    const { h, space, alice, bob } = await setup();
    const fileId = id('f');
    const inbox = `/alice/AppData/trips/${P.inboxOf(space, USERS.bob.uuid)}`;
    await bob.puter.fs.write(`${inbox}/keep.pdf`, new Blob([PDF]));
    await bob.in(space).call('file.put', { fileId, inboxName: 'keep.pdf', name: 'keep.pdf', mime: 'application/pdf', sha256: SHA, kind: 'user' });
    await bob.in(space).call('file.del', { fileId });
    await bob.api.snapshot({ w: 'trips-abcdefghij', s: space, k: 'trip' });
    h.advance(31 * 86_400_000);
    await bob.in(space).call('file.del', { fileId, restore: true });
    await alice.in(space).call('open');
    await h.settle();
    expect(h.kv()[K.entity(space, 'file', fileId)]).toMatchObject({ name: 'keep.pdf' });
    expect(h.kv()[K.entity(space, 'file', fileId)].deleted).toBeUndefined();
  });

  it('sweeps stale uploads, inboxes and 30-day trash on the owner open', async () => {
    const { h, space, alice, bob } = await setup();
    const inbox = `/alice/AppData/trips/${P.inboxOf(space, USERS.bob.uuid)}`;
    await bob.puter.fs.write(`${inbox}/old.pdf`, new Blob([PDF]));
    const kept = id('f');
    await bob.puter.fs.write(`${inbox}/keep.pdf`, new Blob([PDF]));
    await bob.in(space).call('file.put', { fileId: kept, inboxName: 'keep.pdf', name: 'keep.pdf', mime: 'application/pdf', sha256: SHA, kind: 'user' });
    await bob.in(space).call('file.del', { fileId: kept });
    h.advance(31 * 86_400_000);
    await alice.in(space).call('open');
    await h.settle();
    await expect(bob.puter.fs.stat(`${inbox}/old.pdf`)).rejects.toBeTruthy();
    expect(h.kv()[K.entity(space, 'file', kept)]).toMatchObject({ deleted: true });
  });
});
