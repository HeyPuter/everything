// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K, P } from '../../worker/keys.js';
import { thumbPath } from '../../worker/ops/trip/file.js';
import { fileLinkPatch, fileLinks, linkKey } from '../../src/shared/file-links.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WEBP = new Uint8Array([...new TextEncoder().encode('RIFF'), 8, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 '), 1, 2]);
const PDF = new TextEncoder().encode('%PDF-1.7\n...');
const SHA = 'b'.repeat(64);

async function setup() {
  const h = await createHarness({ ownerVerified: false });
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => h.client(name)));
  return { h, space, alice, bob, carol };
}
const ref = (space) => ({ w: 'trips-abcdefghij', s: space, k: 'trip' });

async function stored(client, space, bytes = PNG, name = 'pic.png', mime = 'image/png') {
  const fileId = id('f');
  await client.api.upload(ref(space), fileId, new Blob([bytes]));
  await client.in(space).call('file.put', { fileId, name, mime, sha256: SHA, kind: 'user' });
  return fileId;
}

describe('file transfer through the worker client', () => {
  it('uploads with progress, registers and downloads the same bytes', async () => {
    const { space, bob, carol } = await setup();
    const fileId = id('f');
    const seen = [];
    await bob.api.upload(ref(space), fileId, new Blob([PDF]), { onProgress: (event) => seen.push(event) });
    expect(seen.at(-1)).toEqual({ loaded: PDF.length, total: PDF.length });
    await bob.in(space).call('file.put', { fileId, name: 'ticket.pdf', mime: 'application/pdf', sha256: SHA, kind: 'user' });
    const progress = [];
    const blob = await carol.api.download(ref(space), fileId, { onProgress: (event) => progress.push(event) });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF);
    expect(progress.at(-1)).toEqual({ loaded: PDF.length, total: PDF.length });
    await expect(carol.api.upload(ref(space), id('f'), new Blob([PDF]))).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('thumbnails', () => {
  it('stores a thumbnail for an image and stamps a new thumb id', async () => {
    const { h, space, alice, bob, carol } = await setup();
    const fileId = await stored(bob, space);
    const first = await bob.api.upload(ref(space), fileId, new Blob([WEBP]), { thumb: true });
    expect(first.ents[0]).toMatchObject({ t: 'file', id: fileId, thumb: expect.stringMatching(/^[0-9a-z]{16}$/) });
    expect(h.kv()[K.entity(space, 'file', fileId)].thumb).toBe(first.ents[0].thumb);
    const again = await bob.api.upload(ref(space), fileId, new Blob([PNG]), { thumb: true });
    expect(again.ents[0].thumb).not.toBe(first.ents[0].thumb);
    const blob = await carol.api.download(ref(space), fileId, { thumb: true });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG);
    expect(new Uint8Array(await (await alice.puter.fs.read(thumbPath(space, fileId))).arrayBuffer())).toEqual(PNG);
  });

  it('needs files.edit, an image file and an image body within the cap', async () => {
    const { space, bob, carol } = await setup();
    const image = await stored(bob, space);
    const pdf = await stored(bob, space, PDF, 'ticket.pdf', 'application/pdf');
    await expectError(carol.api.upload(ref(space), image, new Blob([WEBP]), { thumb: true }), 403, 'forbidden');
    await expectError(bob.api.upload(ref(space), pdf, new Blob([WEBP]), { thumb: true }), 415, 'thumb_unsupported');
    await expectError(bob.api.upload(ref(space), image, new Blob([PDF]), { thumb: true }), 415, 'file_type');
    await expectError(bob.api.upload(ref(space), image, new Blob([new TextEncoder().encode('<svg onload=alert(1)>')]), { thumb: true }), 415, 'file_type');
    await expectError(bob.api.upload(ref(space), image, new Blob([WEBP, new Uint8Array(256 * 1024)]), { thumb: true }), 413);
    await expectError(bob.api.upload(ref(space), id('f'), new Blob([WEBP]), { thumb: true }), 404, 'not_found');
    await expectError(carol.api.download(ref(space), image, { thumb: true }), 404, 'not_found');
  });

  it('refuses non-members and meters thumbnail downloads', async () => {
    const { h, space, alice, bob, carol } = await setup();
    const fileId = await stored(bob, space);
    await bob.api.upload(ref(space), fileId, new Blob([WEBP]), { thumb: true });
    await expectError((await h.client('dave')).api.download(ref(space), fileId, { thumb: true }), 403);
    await alice.puter.kv.set(K.rl(space, 'dlb', USERS.carol.uuid, Math.floor(h.now() / 86_400_000)), 2 * 1024 ** 3);
    await expectError(carol.api.download(ref(space), fileId, { thumb: true }), 429, 'rate_limited');
  });

  it('removes the thumbnail with the file on purge', async () => {
    const { space, alice, bob } = await setup();
    const fileId = await stored(bob, space);
    await bob.api.upload(ref(space), fileId, new Blob([WEBP]), { thumb: true });
    expect((await alice.puter.fs.stat(`${P.file(space, fileId)}/.thumb`)).size).toBe(WEBP.length);
    await bob.in(space).call('file.del', { fileId });
    await bob.in(space).call('file.del', { fileId, purge: true });
    await expect(alice.puter.fs.stat(`${P.file(space, fileId)}/.thumb`)).rejects.toBeTruthy();
    await expectError(bob.api.upload(ref(space), fileId, new Blob([WEBP]), { thumb: true }), 404, 'not_found');
  });
});

describe('file links', () => {
  const patch = (client, space, fileId, set) => client.in(space).call('commit', { ops: [{ opId: id('o'), t: 'file', id: fileId, set }] });

  it('lets files.edit link a file to trip entities and the cover', async () => {
    const { h, space, bob } = await setup();
    const fileId = await stored(bob, space);
    const links = [{ t: 'res', id: id('r') }, { t: 'exp', id: id('e') }, { t: 'place', id: id('p') }, { t: 'visit', id: id('v') }, { t: 'note', id: id('n') }, { t: 'meta', id: 'meta' }];
    await patch(bob, space, fileId, { links, star: true, desc: 'Boarding pass' });
    expect(h.kv()[K.entity(space, 'file', fileId)]).toMatchObject({ links, star: true, desc: 'Boarding pass' });
  });

  it('refuses viewers, unknown targets, duplicates and worker-only fields', async () => {
    const { space, bob, carol } = await setup();
    const fileId = await stored(bob, space);
    const target = { t: 'res', id: id('r') };
    await expectError(patch(carol, space, fileId, { star: true }), 403, 'forbidden');
    await expectError(patch(bob, space, fileId, { links: [{ t: 'day', id: id('d') }] }), 400, 'invalid_links');
    await expectError(patch(bob, space, fileId, { links: [{ t: 'meta', id: id('m') }] }), 400);
    await expectError(patch(bob, space, fileId, { links: [target, target] }), 400, 'invalid_links');
    await expectError(patch(bob, space, fileId, { thumb: id('t') }), 403, 'forbidden');
    await expectError(patch(bob, space, fileId, { trashed: 1 }), 403, 'forbidden');
  });

  it('keeps both links when two members link the same file at once (one path per link)', async () => {
    const { h, space, alice, bob } = await setup();
    const fileId = await stored(bob, space);
    const a = { t: 'res', id: id('r') };
    const b = { t: 'exp', id: id('e') };
    await Promise.all([
      patch(alice, space, fileId, { [`linked.${linkKey(a)}`]: true }),
      patch(bob, space, fileId, { [`linked.${linkKey(b)}`]: true }),
    ]);
    expect(fileLinks(h.kv()[K.entity(space, 'file', fileId)])).toEqual(expect.arrayContaining([a, b]));
    // The old whole-list form drops one of two concurrent writes.
    const c = { t: 'note', id: id('n') };
    const d = { t: 'place', id: id('p') };
    await Promise.all([patch(alice, space, fileId, { links: [c] }), patch(bob, space, fileId, { links: [d] })]);
    const after = h.kv()[K.entity(space, 'file', fileId)];
    expect(after.links).toHaveLength(1);
    expect(fileLinks(after)).toEqual(expect.arrayContaining([a, b]));
  });

  it('reads the old list with the paths and unlinks from either form', async () => {
    const { h, space, bob } = await setup();
    const fileId = await stored(bob, space);
    const old = { t: 'res', id: id('r') };
    const added = { t: 'exp', id: id('e') };
    await patch(bob, space, fileId, { links: [old] });
    let entity = h.kv()[K.entity(space, 'file', fileId)];
    await patch(bob, space, fileId, fileLinkPatch(entity, { add: [old, added] }).set);
    entity = h.kv()[K.entity(space, 'file', fileId)];
    expect(fileLinks(entity)).toEqual([old, added]);
    const removal = fileLinkPatch(entity, { remove: [old, added] });
    await bob.in(space).call('commit', { ops: [{ opId: id('o'), t: 'file', id: fileId, ...removal }] });
    entity = h.kv()[K.entity(space, 'file', fileId)];
    expect(fileLinks(entity)).toEqual([]);
    expect(entity.links).toBeUndefined();
  });

  it('checks link paths like list entries', async () => {
    const { space, bob, carol } = await setup();
    const fileId = await stored(bob, space);
    await expectError(patch(carol, space, fileId, { [`linked.res_${id('r')}`]: true }), 403, 'forbidden');
    await expectError(patch(bob, space, fileId, { [`linked.day_${id('d')}`]: true }), 400, 'invalid_links');
    await expectError(patch(bob, space, fileId, { [`linked.meta_${id('m')}`]: true }), 400);
    await expectError(patch(bob, space, fileId, { 'linked.res_nope': true }), 400);
    await expectError(patch(bob, space, fileId, { [`linked.res_${id('r')}`]: false }), 400);
  });

  it('lets collection files link only to saved places and the cover', async () => {
    const h = await createHarness({ ownerVerified: false });
    const alice = await h.client('alice');
    const { space } = await alice.call('space.create', { kind: 'collection', meta: { name: 'Food' } });
    const fileId = await stored(alice, space);
    await patch(alice, space, fileId, { [`linked.saved_${id('s')}`]: true, 'linked.meta_meta': true });
    expect(fileLinks(h.kv()[K.entity(space, 'file', fileId)])).toHaveLength(2);
    await expectError(patch(alice, space, fileId, { [`linked.place_${id('p')}`]: true }), 400, 'invalid_links');
  });

  it('replays a retried link patch without a second change', async () => {
    const { h, space, bob } = await setup();
    const fileId = await stored(bob, space);
    const op = { opId: id('o'), t: 'file', id: fileId, set: { links: [{ t: 'exp', id: id('e') }] } };
    const first = await bob.in(space).call('commit', { ops: [op] });
    const again = await bob.in(space).call('commit', { ops: [op] });
    expect(again.done[op.opId]).toBe(first.done[op.opId]);
    expect(h.kv()[K.rev(space)]).toBe(first.rev);
  });
});

describe('thumbnail costs', () => {
  const calls = (h) => h.world.counters().byUser[USERS.alice.uuid]?.calls ?? {};
  const kvOther = (used, skip) => Object.entries(used).filter(([method]) => method.startsWith('kv.') && method !== skip).reduce((n, [, count]) => n + count, 0);

  it('a thumbnail read costs one budget incr and one FS read once membership is cached', async () => {
    const { h, space, bob, carol } = await setup();
    const fileId = await stored(bob, space);
    await bob.api.upload(ref(space), fileId, new Blob([WEBP]), { thumb: true });
    await carol.api.download(ref(space), fileId, { thumb: true });
    h.world.resetCounters();
    await carol.api.download(ref(space), fileId, { thumb: true });
    const used = calls(h);
    expect(used['kv.incr']).toBe(1);
    expect(used['fs.read']).toBe(1);
    expect(kvOther(used, 'kv.incr')).toBeLessThanOrEqual(1);
  });

  it('storing a thumbnail costs one FS write, one byte-budget incr and one worker change', async () => {
    const { h, space, bob } = await setup();
    const fileId = await stored(bob, space);
    await bob.api.upload(ref(space), fileId, new Blob([WEBP]), { thumb: true });
    h.world.resetCounters();
    await bob.api.upload(ref(space), fileId, new Blob([PNG]), { thumb: true });
    const used = calls(h);
    expect(used['fs.write']).toBe(1);
    expect(used['kv.incr']).toBeLessThanOrEqual(2);
    expect(used['kv.get']).toBeLessThanOrEqual(3);
  });
});
