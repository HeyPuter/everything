import { openDb, reqOf, txDone } from './db.js';
import { AuthError, PERMS, authorize } from './auth.js';

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024; // 16 MiB per object in v0

export class StorageError extends Error {
  constructor(message, code = 'InvalidRequest', status = 400) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.status = status;
  }
}

export async function createBucket(key, name) {
  authorize(key, PERMS.CREATE_BUCKET);
  validateBucketName(name);
  const db = await openDb();
  const tx = db.transaction('buckets', 'readwrite');
  const store = tx.objectStore('buckets');
  const existing = await reqOf(store.get(name));
  if (existing) {
    await txDone(tx);
    throw new StorageError('Bucket already exists', 'BucketAlreadyExists', 409);
  }
  const bucket = {
    name,
    createdAt: new Date().toISOString(),
    ownerKeyId: key.accessKeyId,
  };
  store.put(bucket);
  await txDone(tx);
  return bucket;
}

export async function deleteBucket(key, name) {
  authorize(key, PERMS.DELETE_BUCKET);
  const db = await openDb();
  const objects = await listObjectRecords(name);
  if (objects.length) {
    throw new StorageError('Bucket is not empty', 'BucketNotEmpty', 409);
  }
  const tx = db.transaction('buckets', 'readwrite');
  const existing = await reqOf(tx.objectStore('buckets').get(name));
  if (!existing) {
    await txDone(tx);
    throw new StorageError('No such bucket', 'NoSuchBucket', 404);
  }
  tx.objectStore('buckets').delete(name);
  await txDone(tx);
}

export async function listBuckets(key) {
  authorize(key, PERMS.LIST_BUCKETS);
  const db = await openDb();
  const tx = db.transaction('buckets', 'readonly');
  const buckets = await reqOf(tx.objectStore('buckets').getAll());
  await txDone(tx);
  return buckets.sort((a, b) => a.name.localeCompare(b.name));
}

export async function putObject(key, bucket, objectKey, body, {
  contentType = 'application/octet-stream',
  metadata = {},
} = {}) {
  authorize(key, PERMS.PUT_OBJECT);
  await requireBucket(bucket);
  validateObjectKey(objectKey);
  const bytes = toUint8Array(body);
  if (bytes.byteLength > MAX_OBJECT_BYTES) {
    throw new StorageError(`Object exceeds ${MAX_OBJECT_BYTES} byte limit`, 'EntityTooLarge', 400);
  }
  const record = {
    bucket,
    key: objectKey,
    contentType,
    metadata: { ...metadata },
    size: bytes.byteLength,
    etag: await etagOf(bytes),
    body: bytes.slice().buffer,
    lastModified: new Date().toISOString(),
    ownerKeyId: key.accessKeyId,
  };
  const db = await openDb();
  const tx = db.transaction('objects', 'readwrite');
  tx.objectStore('objects').put(record);
  await txDone(tx);
  return {
    bucket,
    key: objectKey,
    etag: record.etag,
    size: record.size,
    contentType: record.contentType,
    lastModified: record.lastModified,
  };
}

export async function getObject(key, bucket, objectKey) {
  authorize(key, PERMS.GET_OBJECT);
  await requireBucket(bucket);
  const db = await openDb();
  const tx = db.transaction('objects', 'readonly');
  const record = await reqOf(tx.objectStore('objects').get([bucket, objectKey]));
  await txDone(tx);
  if (!record) throw new StorageError('The specified key does not exist', 'NoSuchKey', 404);
  return {
    bucket: record.bucket,
    key: record.key,
    contentType: record.contentType,
    metadata: record.metadata || {},
    size: record.size,
    etag: record.etag,
    lastModified: record.lastModified,
    body: new Uint8Array(record.body),
  };
}

export async function deleteObject(key, bucket, objectKey) {
  authorize(key, PERMS.DELETE_OBJECT);
  await requireBucket(bucket);
  const db = await openDb();
  const tx = db.transaction('objects', 'readwrite');
  const existing = await reqOf(tx.objectStore('objects').get([bucket, objectKey]));
  if (!existing) {
    await txDone(tx);
    throw new StorageError('The specified key does not exist', 'NoSuchKey', 404);
  }
  tx.objectStore('objects').delete([bucket, objectKey]);
  await txDone(tx);
}

export async function listObjects(key, bucket, {
  prefix = '',
  maxKeys = 1000,
  continuationToken = null,
} = {}) {
  authorize(key, PERMS.LIST_OBJECTS);
  await requireBucket(bucket);
  const all = await listObjectRecords(bucket);
  let filtered = all
    .filter((o) => o.key.startsWith(prefix))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (continuationToken) {
    const idx = filtered.findIndex((o) => o.key === continuationToken);
    filtered = idx >= 0 ? filtered.slice(idx + 1) : filtered;
  }
  const limit = Math.min(Math.max(1, maxKeys | 0), 1000);
  const page = filtered.slice(0, limit);
  const truncated = filtered.length > limit;
  return {
    bucket,
    prefix,
    maxKeys: limit,
    isTruncated: truncated,
    nextContinuationToken: truncated ? page[page.length - 1].key : null,
    contents: page.map(({ key: k, size, etag, lastModified, contentType }) => ({
      key: k,
      size,
      etag,
      lastModified,
      contentType,
    })),
  };
}

async function requireBucket(name) {
  const db = await openDb();
  const tx = db.transaction('buckets', 'readonly');
  const bucket = await reqOf(tx.objectStore('buckets').get(name));
  await txDone(tx);
  if (!bucket) throw new StorageError('No such bucket', 'NoSuchBucket', 404);
  return bucket;
}

async function listObjectRecords(bucket) {
  const db = await openDb();
  const tx = db.transaction('objects', 'readonly');
  const idx = tx.objectStore('objects').index('byBucket');
  const rows = await reqOf(idx.getAll(bucket));
  await txDone(tx);
  return rows;
}

function validateBucketName(name) {
  if (typeof name !== 'string' || !BUCKET_RE.test(name) || name.includes('..')) {
    throw new StorageError('Invalid bucket name', 'InvalidBucketName', 400);
  }
}

function validateObjectKey(objectKey) {
  if (typeof objectKey !== 'string' || !objectKey.length || objectKey.length > 1024) {
    throw new StorageError('Invalid object key', 'InvalidArgument', 400);
  }
  if (objectKey.includes('\0')) {
    throw new StorageError('Invalid object key', 'InvalidArgument', 400);
  }
}

function toUint8Array(body) {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  throw new StorageError('Unsupported body type', 'InvalidArgument', 400);
}

async function etagOf(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export { AuthError, MAX_OBJECT_BYTES };
