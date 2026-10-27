import {
  authenticate,
  createAccessKey,
  deleteAccessKey,
  ensureBootstrapAdmin,
  listAccessKeys,
} from './auth.js';
import {
  createBucket,
  deleteBucket,
  deleteObject,
  getObject,
  listBuckets,
  listObjects,
  putObject,
} from './objects.js';
import {
  deleteFunction,
  getFunction,
  invokeFunction,
  listFunctions,
  listLogs,
  putFunction,
} from '../compute/functions.js';

/**
 * Session-bound client. Every mutating call requires a live credential.
 */
export function createClient() {
  let creds = null;
  let key = null;

  async function ensure() {
    if (!key) throw Object.assign(new Error('Sign in with an access key first'), { code: 'NotSignedIn', status: 401 });
    return key;
  }

  return {
    async bootstrap() {
      const admin = await ensureBootstrapAdmin();
      return {
        accessKeyId: admin.accessKeyId,
        secretAccessKey: admin.secretAccessKey,
        label: admin.label,
      };
    },

    async signIn(accessKeyId, secretAccessKey) {
      key = await authenticate(accessKeyId, secretAccessKey);
      creds = { accessKeyId, secretAccessKey };
      return { accessKeyId: key.accessKeyId, permissions: key.permissions, label: key.label };
    },

    signOut() {
      key = null;
      creds = null;
    },

    get signedIn() {
      return !!key;
    },

    get identity() {
      return key
        ? { accessKeyId: key.accessKeyId, permissions: key.permissions, label: key.label }
        : null;
    },

    // Keys
    async createKey(opts) {
      await ensure();
      return createAccessKey(opts);
    },
    async listKeys() {
      await ensure();
      return listAccessKeys();
    },
    async deleteKey(id) {
      await ensure();
      return deleteAccessKey(id);
    },

    // Buckets / objects
    async createBucket(name) {
      return createBucket(await ensure(), name);
    },
    async deleteBucket(name) {
      return deleteBucket(await ensure(), name);
    },
    async listBuckets() {
      return listBuckets(await ensure());
    },
    async putObject(bucket, objectKey, body, opts) {
      return putObject(await ensure(), bucket, objectKey, body, opts);
    },
    async getObject(bucket, objectKey) {
      return getObject(await ensure(), bucket, objectKey);
    },
    async deleteObject(bucket, objectKey) {
      return deleteObject(await ensure(), bucket, objectKey);
    },
    async listObjects(bucket, opts) {
      return listObjects(await ensure(), bucket, opts);
    },

    // Functions
    async putFunction(name, source, opts) {
      return putFunction(await ensure(), name, source, opts);
    },
    async deleteFunction(name) {
      return deleteFunction(await ensure(), name);
    },
    async listFunctions() {
      return listFunctions(await ensure());
    },
    async getFunction(name) {
      return getFunction(await ensure(), name);
    },
    async invokeFunction(name, event) {
      return invokeFunction(await ensure(), name, event);
    },
    async listLogs(name, opts) {
      return listLogs(await ensure(), name, opts);
    },

    /** Snapshot for session restore (never store secrets in plain UI state beyond this). */
    exportSession() {
      return creds ? { ...creds } : null;
    },
  };
}
