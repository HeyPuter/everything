import { openDb, reqOf, txDone } from '../storage/db.js';
import { AuthError, PERMS, authorize } from '../storage/auth.js';

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 10000;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;

export class FunctionError extends Error {
  constructor(message, code = 'InvalidRequest', status = 400) {
    super(message);
    this.name = 'FunctionError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Register or update a function. Source is plain JS that must assign to
 * `exports.handler` or declare `async function handler(event)`.
 * Execution uses a constrained AsyncFunction sandbox (no DOM, no network
 * fetch polyfill injected). This is for local demos — not a secure multi-tenant
 * production isolator.
 */
export async function putFunction(key, name, source, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  description = '',
} = {}) {
  authorize(key, PERMS.MANAGE_FUNCTION);
  validateName(name);
  if (typeof source !== 'string' || !source.trim()) {
    throw new FunctionError('Function source is required', 'InvalidArgument');
  }
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new FunctionError('Source too large', 'EntityTooLarge');
  }
  const timeout = clampTimeout(timeoutMs);
  // Ensure a handler binding exists without executing it (avoids deploy-time
  // timeouts on intentionally slow handlers).
  assertHasHandler(source);
  compileHandler(source);

  const record = {
    name,
    source,
    timeoutMs: timeout,
    description: String(description || ''),
    updatedAt: new Date().toISOString(),
    ownerKeyId: key.accessKeyId,
  };
  const db = await openDb();
  const tx = db.transaction('functions', 'readwrite');
  const existing = await reqOf(tx.objectStore('functions').get(name));
  record.createdAt = existing?.createdAt || record.updatedAt;
  tx.objectStore('functions').put(record);
  await txDone(tx);
  return publicFn(record);
}

export async function deleteFunction(key, name) {
  authorize(key, PERMS.MANAGE_FUNCTION);
  const db = await openDb();
  const tx = db.transaction('functions', 'readwrite');
  const existing = await reqOf(tx.objectStore('functions').get(name));
  if (!existing) {
    await txDone(tx);
    throw new FunctionError('Function not found', 'ResourceNotFoundException', 404);
  }
  tx.objectStore('functions').delete(name);
  await txDone(tx);
}

export async function listFunctions(key) {
  authorize(key, PERMS.MANAGE_FUNCTION);
  const db = await openDb();
  const tx = db.transaction('functions', 'readonly');
  const rows = await reqOf(tx.objectStore('functions').getAll());
  await txDone(tx);
  return rows.map(publicFn).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getFunction(key, name) {
  authorize(key, PERMS.MANAGE_FUNCTION);
  const record = await loadFn(name);
  return { ...publicFn(record), source: record.source };
}

/**
 * Invoke a function with a JSON-serializable event. Enforces timeout and
 * result size. Writes a structured log entry.
 */
export async function invokeFunction(key, name, event = {}, { requestId = null } = {}) {
  authorize(key, PERMS.INVOKE_FUNCTION);
  const record = await loadFn(name);
  const id = requestId || crypto.randomUUID();
  const started = Date.now();
  let status = 'ok';
  let result = null;
  let error = null;

  try {
    const handler = compileHandler(record.source);
    result = await withTimeout(Promise.resolve(handler(structuredClone(event))), record.timeoutMs);
    const encoded = JSON.stringify(result);
    if (encoded && encoded.length > MAX_RESULT_BYTES) {
      throw new FunctionError('Result too large', 'PayloadTooLarge', 413);
    }
  } catch (err) {
    status = err?.code === 'Timeout' ? 'timeout' : 'error';
    error = { message: String(err?.message || err), code: err?.code || 'RuntimeError' };
  }

  const durationMs = Date.now() - started;
  await writeLog({
    functionName: name,
    requestId: id,
    status,
    durationMs,
    error,
    at: new Date().toISOString(),
  });

  if (status !== 'ok') {
    const e = new FunctionError(error.message, error.code, status === 'timeout' ? 408 : 500);
    e.requestId = id;
    e.durationMs = durationMs;
    throw e;
  }
  return { requestId: id, statusCode: 200, durationMs, payload: result };
}

export async function listLogs(key, functionName, { limit = 50 } = {}) {
  authorize(key, PERMS.MANAGE_FUNCTION);
  const db = await openDb();
  const tx = db.transaction('logs', 'readonly');
  const idx = tx.objectStore('logs').index('byFn');
  const rows = await reqOf(idx.getAll(functionName));
  await txDone(tx);
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

async function loadFn(name) {
  const db = await openDb();
  const tx = db.transaction('functions', 'readonly');
  const record = await reqOf(tx.objectStore('functions').get(name));
  await txDone(tx);
  if (!record) throw new FunctionError('Function not found', 'ResourceNotFoundException', 404);
  return record;
}

async function writeLog(entry) {
  const db = await openDb();
  const tx = db.transaction('logs', 'readwrite');
  tx.objectStore('logs').add(entry);
  await txDone(tx);
}

function assertHasHandler(source) {
  try {
    const check = new Function(
      'exports',
      `${source}\n;` +
        `const h = (exports && exports.handler)` +
        `  || (typeof handler !== 'undefined' ? handler : null);` +
        `if (typeof h !== 'function') throw new Error('handler function not found');`,
    );
    check({});
  } catch (err) {
    throw new FunctionError(String(err?.message || err), 'InvalidArgument');
  }
}

function compileHandler(source) {
  // AsyncFunction with no ambient privileges beyond what the engine provides.
  // Intentionally does not expose fetch/document; callers should treat this as
  // a demo sandbox, not a hardened multi-tenant isolator.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runner = new AsyncFunction(
    'event',
    'exports',
    `${source}\n;` +
      `const h = (typeof exports !== 'undefined' && exports && exports.handler)` +
      `  || (typeof handler !== 'undefined' ? handler : null);` +
      `if (typeof h !== 'function') throw new Error('handler function not found');` +
      `return await h(event);`,
  );
  return (event) => runner(event, {});
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new FunctionError(`Timed out after ${ms}ms`, 'Timeout', 408);
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function validateName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9-_]{1,64}$/.test(name)) {
    throw new FunctionError('Invalid function name', 'InvalidArgument');
  }
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(n)));
}

function publicFn(record) {
  return {
    name: record.name,
    description: record.description,
    timeoutMs: record.timeoutMs,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export { AuthError };
