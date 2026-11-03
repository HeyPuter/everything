import { invariant } from '../shared/errors.js';
import { validateSpaceRef } from '../shared/protocol.js';
import { isDate } from '../shared/dates.js';
import { LIMITS } from '../shared/limits.js';
import { plainObject } from '../shared/schema/dsl.js';

const roles = new Set(['owner', 'editor', 'viewer']);
const MAX_REFERENCES = 100_000;
const MAX_UNIQUE_SPACES = 10_000;
const assertActive = (signal) => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };

async function abortable(request, signal) {
  assertActive(signal);
  if (!signal) return request();
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { assertActive(signal); return request(); }), aborted]);
  } finally { signal.removeEventListener('abort', cancel); }
}

// Returned roles are display metadata; every write still needs worker authorization.
export async function loadHeads(refs, { api, concurrency = 2, signal } = {}) {
  invariant(Array.isArray(refs) && refs.length <= MAX_REFERENCES, 'invalid_space_refs');
  invariant(typeof api?.request === 'function' && Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 4, 'invalid_heads_options');
  assertActive(signal);
  const groups = new Map();
  const ordered = [];
  for (const ref of refs) {
    validateSpaceRef(ref);
    const group = groups.get(ref.w) ?? new Map();
    if (group.has(ref.s)) { invariant(group.get(ref.s).k === ref.k, 'conflicting_space_ref'); continue; }
    const copy = { ...ref };
    group.set(ref.s, copy); groups.set(ref.w, group); ordered.push(copy);
    invariant(group.size <= LIMITS.spaces && ordered.length <= MAX_UNIQUE_SPACES, 'invalid_space_refs');
  }
  const queue = [...groups];
  const found = new Map();
  const missing = new Set();
  const errors = [];
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      assertActive(signal);
      const [name, spaces] = queue[next++];
      try {
        const result = await abortable(() => api.request(name, JSON.stringify({ op: 'heads', spaces: [...spaces.keys()] })), signal);
        assertActive(signal);
        invariant(result?.ok === true && plainObject(result.heads), 'invalid_heads_response', 502);
        const accepted = [];
        const absent = [];
        for (const [id, ref] of spaces) {
          const key = `${name}:${id}`;
          if (!Object.hasOwn(result.heads, id)) { absent.push(key); continue; }
          const head = result.heads[id];
          invariant(plainObject(head) && Number.isSafeInteger(head.rev) && head.rev >= 0
            && typeof head.title === 'string' && head.title.length <= LIMITS.nameChars && head.title.trim()
            && roles.has(head.role) && (head.start == null || isDate(head.start)) && (head.end == null || isDate(head.end)), 'invalid_heads_response', 502);
          accepted.push([key, { ref, rev: head.rev, title: head.title, start: head.start ?? null, end: head.end ?? null, role: head.role }]);
        }
        for (const [key, head] of accepted) found.set(key, head);
        for (const key of absent) missing.add(key);
      } catch (error) {
        assertActive(signal);
        errors.push({ worker: name, status: Number.isInteger(error?.status) && error.status >= 0 && error.status <= 599 ? error.status : 0,
          code: typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : 'heads_unavailable' });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  assertActive(signal);
  return {
    heads: ordered.flatMap((ref) => found.has(`${ref.w}:${ref.s}`) ? [found.get(`${ref.w}:${ref.s}`)] : []),
    missing: ordered.filter((ref) => missing.has(`${ref.w}:${ref.s}`)),
    errors,
  };
}
