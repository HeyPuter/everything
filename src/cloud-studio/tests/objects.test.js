import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../src/storage/db.js';
import { ensureBootstrapAdmin, createAccessKey, authenticate, PERMS } from '../src/storage/auth.js';
import {
  createBucket,
  deleteBucket,
  listBuckets,
  putObject,
  getObject,
  deleteObject,
  listObjects,
  StorageError,
} from '../src/storage/objects.js';

async function admin() {
  const boot = await ensureBootstrapAdmin();
  return authenticate(boot.accessKeyId, boot.secretAccessKey);
}

describe('object storage', () => {
  beforeEach(async () => {
    await resetDb();
    await ensureBootstrapAdmin();
  });

  it('creates, lists, and rejects duplicate buckets', async () => {
    const key = await admin();
    await createBucket(key, 'demo-bucket');
    const listed = await listBuckets(key);
    expect(listed.some((b) => b.name === 'demo-bucket')).toBe(true);
    await expect(createBucket(key, 'demo-bucket')).rejects.toMatchObject({
      code: 'BucketAlreadyExists',
    });
  });

  it('puts, gets, lists, and deletes objects with etags', async () => {
    const key = await admin();
    await createBucket(key, 'files');
    const put = await putObject(key, 'files', 'notes/hello.txt', 'hello cloud', {
      contentType: 'text/plain',
      metadata: { source: 'test' },
    });
    expect(put.size).toBe(11);
    expect(put.etag).toMatch(/^[a-f0-9]{64}$/);

    const got = await getObject(key, 'files', 'notes/hello.txt');
    expect(new TextDecoder().decode(got.body)).toBe('hello cloud');
    expect(got.metadata.source).toBe('test');

    const listed = await listObjects(key, 'files', { prefix: 'notes/' });
    expect(listed.contents).toHaveLength(1);
    expect(listed.contents[0].key).toBe('notes/hello.txt');

    await deleteObject(key, 'files', 'notes/hello.txt');
    await expect(getObject(key, 'files', 'notes/hello.txt')).rejects.toMatchObject({
      code: 'NoSuchKey',
    });
  });

  it('refuses to delete a non-empty bucket and rejects bad names', async () => {
    const key = await admin();
    await createBucket(key, 'keep-me');
    await putObject(key, 'keep-me', 'a.bin', new Uint8Array([1, 2, 3]));
    await expect(deleteBucket(key, 'keep-me')).rejects.toMatchObject({ code: 'BucketNotEmpty' });
    await expect(createBucket(key, 'BAD_NAME')).rejects.toBeInstanceOf(StorageError);
  });

  it('enforces authorization on restricted keys', async () => {
    const adminKey = await admin();
    const restricted = await createAccessKey({
      permissions: [PERMS.LIST_BUCKETS, PERMS.LIST_OBJECTS, PERMS.GET_OBJECT],
    });
    const reader = await authenticate(restricted.accessKeyId, restricted.secretAccessKey);
    await createBucket(adminKey, 'private-data');
    await putObject(adminKey, 'private-data', 'secret.txt', 'nope');

    await expect(createBucket(reader, 'hacker')).rejects.toMatchObject({ code: 'AccessDenied' });
    await expect(putObject(reader, 'private-data', 'x', 'y')).rejects.toMatchObject({
      code: 'AccessDenied',
    });
    const got = await getObject(reader, 'private-data', 'secret.txt');
    expect(new TextDecoder().decode(got.body)).toBe('nope');
  });

  it('paginates listObjects with continuation tokens', async () => {
    const key = await admin();
    await createBucket(key, 'paged');
    for (const name of ['a', 'b', 'c', 'd']) {
      await putObject(key, 'paged', name, name);
    }
    const page1 = await listObjects(key, 'paged', { maxKeys: 2 });
    expect(page1.contents.map((c) => c.key)).toEqual(['a', 'b']);
    expect(page1.isTruncated).toBe(true);
    const page2 = await listObjects(key, 'paged', {
      maxKeys: 2,
      continuationToken: page1.nextContinuationToken,
    });
    expect(page2.contents.map((c) => c.key)).toEqual(['c', 'd']);
    expect(page2.isTruncated).toBe(false);
  });
});
