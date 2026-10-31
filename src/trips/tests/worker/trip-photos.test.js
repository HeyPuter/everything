// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K } from '../../worker/keys.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode('%PDF-1.7\n...');
const SHA = 'c'.repeat(64);
const ref = (space, k = 'trip') => ({ w: 'trips-abcdefghij', s: space, k });
const kvCalls = (h) => Object.entries(h.world.counters().byUser[USERS.alice.uuid]?.calls ?? {})
  .filter(([method]) => method.startsWith('kv.')).reduce((n, [, count]) => n + count, 0);

async function setup() {
  const h = await createHarness({ ownerVerified: false });
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [bob, carol] = await Promise.all(['bob', 'carol'].map((name) => h.client(name)));
  return { h, space, bob, carol };
}
async function put(client, space, fields, bytes = JPEG) {
  const fileId = id('f');
  await client.api.upload(ref(space), fileId, new Blob([bytes]));
  return { fileId, result: await client.in(space).call('file.put', { fileId, name: 'beach.jpg', mime: 'image/jpeg', sha256: SHA, kind: 'photo', ...fields }) };
}

describe('trip photos', () => {
  it('registers a shared photo with its capture time and place', async () => {
    const { h, space, bob } = await setup();
    const { fileId, result } = await put(bob, space, { taken: { date: '2027-05-02', time: '18:40' }, geo: { lat: 38.69, lng: -9.42 } });
    expect(result.ents[0]).toMatchObject({ t: 'file', kind: 'photo', taken: { date: '2027-05-02', time: '18:40' }, geo: { lat: 38.69, lng: -9.42 } });
    expect(h.kv()[K.entity(space, 'file', fileId)].kind).toBe('photo');
  });

  it('takes images only, and capture details only on photos', async () => {
    const { space, bob } = await setup();
    const fileId = id('f');
    await bob.api.upload(ref(space), fileId, new Blob([PDF]));
    await expectError(bob.in(space).call('file.put', { fileId, name: 'ticket.pdf', mime: 'application/pdf', sha256: SHA, kind: 'photo' }), 415, 'file_type');
    const other = id('f');
    await bob.api.upload(ref(space), other, new Blob([JPEG]));
    await expectError(bob.in(space).call('file.put', { fileId: other, name: 'a.jpg', mime: 'image/jpeg', sha256: SHA, kind: 'user', taken: { date: '2027-05-02' } }), 400, 'invalid_file');
    await expectError(put(bob, space, { taken: { date: '2027-13-02' } }), 400);
    await expectError(put(bob, space, { geo: { lat: 91, lng: 0 } }), 400);
  });

  it('needs files.upload', async () => {
    const { space, carol } = await setup();
    await expect(carol.api.upload(ref(space), id('f'), new Blob([JPEG]))).rejects.toMatchObject({ status: 403 });
  });

  it('is idempotent for the same upload', async () => {
    const { space, bob } = await setup();
    const { fileId, result } = await put(bob, space, {});
    const again = await bob.in(space).call('file.put', { fileId, name: 'beach.jpg', mime: 'image/jpeg', sha256: SHA, kind: 'photo' });
    expect(again.rev).toBe(result.rev);
  });

  it('costs the same as any other file registration', async () => {
    const { h, space, bob } = await setup();
    const user = id('f');
    await bob.api.upload(ref(space), user, new Blob([JPEG]));
    h.world.resetCounters();
    await bob.in(space).call('file.put', { fileId: user, name: 'a.jpg', mime: 'image/jpeg', sha256: SHA, kind: 'user' });
    const plain = kvCalls(h);
    const photo = id('f');
    await bob.api.upload(ref(space), photo, new Blob([JPEG]));
    h.world.resetCounters();
    await bob.in(space).call('file.put', { fileId: photo, name: 'b.jpg', mime: 'image/jpeg', sha256: SHA, kind: 'photo', taken: { date: '2027-05-02' } });
    expect(kvCalls(h)).toBeLessThanOrEqual(plain);
  });
});
