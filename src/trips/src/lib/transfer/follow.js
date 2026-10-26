// A member's side of a completed move: rejoin the trip in its new worker, swap the `me:spaces` entry, keep the edits
// the freeze refused so the new trip can re-apply them, and let the old owner delete the stub after the grace period.
import { graceEnd, movedRef } from './state.js';

const REFUSED = new Set(['space_moving', 'space_moved']);
const sameRef = (a, b) => a?.w === b?.w && a?.s === b?.s && a?.k === b?.k;

/**
 * `deps`: `call(worker, op, input)`, `spaces` (the personal `me:spaces` API), `stash` (`replayStash`), optional
 * `conflicts()` and `dropConflict(opId)` from the old space, `now()`.
 * Resolves to `{status: 'joined', ref, role, kept}` or `{status: 'no_seat', reason}`.
 */
export async function followMove({ from, movedTo, meta = {}, role = null }, deps) {
  const { call, spaces, stash, conflicts = () => [], dropConflict = async () => {}, now = Date.now } = deps;
  const ref = movedRef(movedTo, from.k);
  let joined;
  try {
    joined = await call(ref.w, 'transfer.join', { space: ref.s });
  } catch (error) {
    if (error?.code === 'seat_invalid') return { status: 'no_seat', reason: error.reason ?? 'invalid' };
    throw error;
  }
  await spaces.upsert({
    ref, role: joined.role, title: typeof meta.title === 'string' ? meta.title : '',
    ...(meta.start ? { start: meta.start } : {}), ...(meta.end ? { end: meta.end } : {}),
    ...(joined.handles ? { handles: joined.handles } : {}), ...(joined.files ? { files: joined.files } : {}),
  });
  const refused = conflicts().filter((item) => REFUSED.has(item.code) && item.op?.opId);
  await stash.add(ref, refused.map((item) => item.op), now());
  for (const item of refused) await Promise.resolve(dropConflict(item.op.opId)).catch(() => {});
  // The old owner keeps the stub in their trip list until it is deleted, so it stays reachable for that.
  if (role !== 'owner') await spaces.remove(from);
  else if (now() >= graceEnd(movedTo)) {
    await deleteStub(from, { call });
    await spaces.remove(from);
  }
  return { status: 'joined', ref, role: joined.role, kept: refused.length };
}

/** The old owner removes the stub of a moved trip; a stub that is already gone counts as removed. */
export async function deleteStub(from, { call }) {
  try { await call(from.w, 'space.delete', { space: from.s }); } catch (error) {
    if (error?.status !== 404) throw error;
  }
}

/** Re-applies edits stashed by `followMove` once the moved trip is open. Resolves to `{applied, failed}`. */
export async function replayInto(space, stash) {
  const value = await stash.get();
  if (!value || !sameRef(value.to, space.ref) || !Array.isArray(value.ops)) return { applied: 0, failed: 0 };
  let applied = 0;
  let failed = 0;
  for (const op of value.ops) {
    try { await space.apply([op]); applied += 1; } catch { failed += 1; }
  }
  await stash.remove();
  return { applied, failed };
}
