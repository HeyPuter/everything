import { DomainError } from '../src/shared/errors.js';

export const CORS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, puter-auth, x-trips-proof, x-puter-no-auth, if-none-match',
  'Access-Control-Expose-Headers': 'retry-after, content-disposition, content-length, etag',
  'Access-Control-Max-Age': '86400',
});

const MESSAGES = Object.freeze({
  auth_required: 'A signed request is required.',
  credential_rejected: 'The credential could not be verified.',
  proof_expired: 'The request was signed too long ago. Check the device clock.',
  restricted_credential_required: 'Send a restricted credential, never a session.',
  forbidden: 'You do not have permission for this.',
  not_member: 'You are not a member of this space.',
  not_found: 'Not found.',
  space_not_found: 'This space does not exist.',
  stale: 'Someone else changed this first.',
  gone: 'This was deleted.',
  rate_limited: 'Too many requests. Try again shortly.',
  owner_credit: 'The owner has run out of Puter credit.',
  busy: 'The server is busy. Try again shortly.',
  body_too_large: 'The request is too large.',
  internal: 'Something went wrong.',
});

export class HttpError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const fail = (code, status = 400, extra) => { throw new HttpError(code, status, extra); };
export const check = (condition, code = 'invalid', status = 400) => { if (!condition) fail(code, status); };

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

export function bytesResponse(body, { type = 'application/octet-stream', headers = {}, status = 200 } = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Maps any thrown value to `{code, message}` without internals. */
export function errorResponse(error) {
  let status = 500;
  let code = 'internal';
  const extra = {};
  const headers = {};
  if (error instanceof HttpError || error instanceof DomainError) {
    status = error.status;
    code = error.code;
    if (error instanceof DomainError && error.issues?.length) extra.issues = error.issues.slice(0, 20);
    if (error.extra) Object.assign(extra, error.extra);
  } else if (error?.status === 402 || error?.code === 'insufficient_funds') {
    status = 402; code = 'owner_credit';
  } else if (error?.status === 429 || error?.code === 'rate_limit_exceeded') {
    status = 503; code = 'busy';
  } else if (error?.code === 'value_too_large') {
    status = 413; code = 'entity_too_large';
  }
  if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
  if (typeof code !== 'string' || !CODE.test(code)) code = 'internal';
  if (status === 429 || status === 503) headers['Retry-After'] = String(extra.retryAfter ?? 5);
  return json({ code, message: MESSAGES[code] ?? code.replaceAll('_', ' '), ...extra }, status, headers);
}

/** Reads a request body up to `limit` bytes. */
export async function readBody(request, limit) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) fail('body_too_large', 413);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { void reader.cancel().catch(() => {}); fail('body_too_large', 413); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export function wrap(handler) {
  return async (event) => {
    try { return await handler(event); } catch (error) { return errorResponse(error); }
  };
}
