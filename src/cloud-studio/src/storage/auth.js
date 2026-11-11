import { openDb, reqOf, txDone } from './db.js';

/** Permissions a key may hold. */
export const PERMS = Object.freeze({
  LIST_BUCKETS: 's3:ListAllMyBuckets',
  CREATE_BUCKET: 's3:CreateBucket',
  DELETE_BUCKET: 's3:DeleteBucket',
  LIST_OBJECTS: 's3:ListBucket',
  GET_OBJECT: 's3:GetObject',
  PUT_OBJECT: 's3:PutObject',
  DELETE_OBJECT: 's3:DeleteObject',
  INVOKE_FUNCTION: 'lambda:InvokeFunction',
  MANAGE_FUNCTION: 'lambda:ManageFunction',
  ADMIN: '*',
});

const ALL_PERMS = Object.values(PERMS).filter((p) => p !== PERMS.ADMIN);

export class AuthError extends Error {
  constructor(message, code = 'AccessDenied') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = 403;
  }
}

export async function ensureBootstrapAdmin() {
  const db = await openDb();
  const tx = db.transaction('keys', 'readwrite');
  const store = tx.objectStore('keys');
  const existing = await reqOf(store.getAll());
  if (existing.length) {
    await txDone(tx);
    return existing.find((k) => k.permissions?.includes(PERMS.ADMIN)) || existing[0];
  }
  const key = {
    accessKeyId: 'CSKADMIN',
    secretAccessKey: randomSecret(),
    permissions: [PERMS.ADMIN],
    createdAt: new Date().toISOString(),
    label: 'bootstrap-admin',
  };
  store.put(key);
  await txDone(tx);
  return key;
}

export async function createAccessKey({ label = '', permissions = ALL_PERMS } = {}) {
  const db = await openDb();
  const key = {
    accessKeyId: 'CSK' + randomId(12).toUpperCase(),
    secretAccessKey: randomSecret(),
    permissions: normalizePerms(permissions),
    createdAt: new Date().toISOString(),
    label,
  };
  const tx = db.transaction('keys', 'readwrite');
  tx.objectStore('keys').put(key);
  await txDone(tx);
  return key;
}

export async function listAccessKeys() {
  const db = await openDb();
  const tx = db.transaction('keys', 'readonly');
  const keys = await reqOf(tx.objectStore('keys').getAll());
  await txDone(tx);
  return keys.map(({ secretAccessKey, ...pub }) => pub);
}

export async function deleteAccessKey(accessKeyId) {
  const db = await openDb();
  const tx = db.transaction('keys', 'readwrite');
  tx.objectStore('keys').delete(accessKeyId);
  await txDone(tx);
}

export async function authenticate(accessKeyId, secretAccessKey) {
  if (!accessKeyId || !secretAccessKey) {
    throw new AuthError('Missing credentials', 'InvalidAccessKeyId');
  }
  const db = await openDb();
  const tx = db.transaction('keys', 'readonly');
  const key = await reqOf(tx.objectStore('keys').get(accessKeyId));
  await txDone(tx);
  if (!key || key.secretAccessKey !== secretAccessKey) {
    throw new AuthError('The access key or secret is wrong', 'SignatureDoesNotMatch');
  }
  return key;
}

export function authorize(key, permission) {
  if (!key) throw new AuthError('Not authenticated', 'AccessDenied');
  const perms = key.permissions || [];
  if (perms.includes(PERMS.ADMIN) || perms.includes(permission) || perms.includes('*')) {
    return true;
  }
  throw new AuthError(`Not allowed to ${permission}`, 'AccessDenied');
}

function normalizePerms(permissions) {
  if (!Array.isArray(permissions) || !permissions.length) return [...ALL_PERMS];
  if (permissions.includes(PERMS.ADMIN) || permissions.includes('*')) return [PERMS.ADMIN];
  return [...new Set(permissions)];
}

function randomSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomId(n) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
