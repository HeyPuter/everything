import { invariant } from '../../shared/errors.js';
import { KINDS, validateSpaceRef } from '../../shared/protocol.js';
import { plainObject } from '../../shared/schema/dsl.js';
import { filesEntry } from '../../lib/store/personal.js';

const ROLES = Object.freeze(['owner', 'editor', 'viewer']);
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** `join.preview` answers are owner-written display data: clamp and allowlist. */
export function previewFrom(value) {
  invariant(plainObject(value) && KINDS.includes(value.kind) && ['editor', 'viewer'].includes(value.role), 'invalid_preview_response', 502);
  return { title: text(value.title, 200), owner: text(value.owner, 100), role: value.role, kind: value.kind, exp: Number.isSafeInteger(value.exp) && value.exp > 0 ? value.exp : null };
}

export async function previewInvite(api, { worker, space, token }) {
  return previewFrom(await api.request(worker, JSON.stringify({ op: 'join.preview', space, token })));
}

export function handlesFrom(value) {
  return plainObject(value) && typeof value.read === 'string' && typeof value.write === 'string' && value.read.length <= 256 && value.write.length <= 256
    ? { read: value.read, write: value.write } : undefined;
}

/**
 * Joins with a link token, then caches the trip in `me:spaces`. Membership exists once `join` answers, so a failed index
 * write (retried once) resolves with `indexed: false` instead of throwing.
 */
export async function joinWithToken({ api, spaces, worker, space, token, title = '' }) {
  const result = await api.request(worker, JSON.stringify({ op: 'join', space, token }));
  invariant(plainObject(result) && ROLES.includes(result.role) && KINDS.includes(result.kind) && (result.space === undefined || result.space === space), 'invalid_join_response', 502);
  const ref = validateSpaceRef({ w: worker, s: space, k: result.kind });
  const handles = handlesFrom(result.handles);
  const files = filesEntry(result.files);
  const entry = { ref, role: result.role, title, ...(handles ? { handles } : {}), ...(files ? { files } : {}) };
  let indexed = Boolean(spaces);
  for (let attempt = 0; spaces && attempt < 2; attempt++) {
    try { await spaces.upsert(entry); indexed = true; break; } catch (error) {
      if (error?.code === 'account_changed') throw error;
      indexed = false;
    }
  }
  return { ref, role: result.role, indexed, entry };
}
