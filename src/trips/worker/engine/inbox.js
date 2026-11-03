// Direct-mode inboxes (`inbox/<uuid>/`): members write uploads there with their own session, which the worker's
// upload budgets only see at `file.put`. So the worker sweeps them on its own schedule, charges what it deletes to
// the member's daily upload bytes, and takes the folder away from members who may not upload or ran out.
import { isUuid } from '../../src/shared/ids.js';
import { LIMITS } from '../../src/shared/limits.js';
import { can } from '../../src/shared/perms.js';
import { K, P } from '../keys.js';
import { DAY, HOUR, kvBudget } from './limits.js';
import { active, loadRecords, loadSpace, permsOf, recordOf } from './space.js';
import { pool } from './store.js';

export const SWEEP_AGE = HOUR;
// A member can't register more than this a day, so an inbox never needs to hold more.
export const INBOX_BYTES = LIMITS.uploadBytesPerDay;
const SWEEP_EVERY = 10 * 60_000;
const SCHEDULED_FOLDERS = 20;

/** A missing path: nothing left to delete or unshare. */
export const fsGone = (error) => error?.code === 'subject_does_not_exist';
const modifiedMs = (value) => (Number(value) < 1e12 ? Number(value) * 1000 : Number(value));
const sizeOf = (item) => Number(item.size) || 0;

/** Unshares and deletes a member's inbox. Deleting the folder ends the share whatever the holder is called now. */
export async function dropInbox(w, sid, uuid, username) {
  if (username) await w.fs.unshare(P.inboxOf(sid, uuid), username).catch(() => {});
  try { await w.fs.delete(P.inboxOf(sid, uuid), { recursive: true }); } catch (error) { if (!fsGone(error)) throw error; }
}

/**
 * Deletes stale files, or everything once the folder holds more than `quota`. Members never need subfolders, so
 * those go too and count as a full quota. Returns the bytes deleted.
 */
async function sweepFolder(w, path, quota) {
  let items;
  try { items = await w.fs.readdir(path); } catch (error) { if (fsGone(error)) return 0; throw error; }
  const files = items.filter((item) => !item.is_dir);
  const dirs = items.filter((item) => item.is_dir);
  const total = files.reduce((sum, item) => sum + sizeOf(item), 0);
  const doomed = total > quota ? files : files.filter((item) => w.now() - modifiedMs(item.modified) > SWEEP_AGE);
  await pool([...doomed, ...dirs], 4, (item) => w.fs.delete(item.path, { recursive: true }).catch(() => {}));
  return doomed.reduce((sum, item) => sum + sizeOf(item), 0) + dirs.length * quota;
}

async function sweepMember(w, sid, s, uuid, owner) {
  const path = P.inboxOf(sid, uuid);
  // The owner fills only their own storage.
  if (uuid === owner) return void await sweepFolder(w, path, Infinity);
  const record = recordOf(s, uuid);
  if (!active(record) || !can(record.role, 'files.upload', permsOf(s))) {
    await dropInbox(w, sid, uuid, record?.username);
    if (active(record)) await w.kv.update(K.handles(sid, uuid), { inbox: null });
    return;
  }
  const bytes = await sweepFolder(w, path, INBOX_BYTES);
  if (!bytes) return;
  try {
    await kvBudget(w, sid, 'upb', uuid, { windowMs: DAY, limit: LIMITS.uploadBytesPerDay, amount: bytes });
  } catch (error) {
    if (error?.status !== 429) throw error;
    // Past the day's upload bytes: no inbox until the window ends.
    await dropInbox(w, sid, uuid, record.username);
    await w.kv.update(K.handles(sid, uuid), { inbox: null, inboxHold: (Math.floor(w.now() / DAY) + 1) * DAY });
  }
}

/** Sweeps one member's inbox. */
export async function sweepInbox(w, sid, uuid) {
  const s = await loadSpace(w, sid, { meta: true });
  await loadRecords(w, sid, [uuid]);
  await sweepMember(w, sid, s, uuid, (await w.owner()).uuid);
}

/** Sweeps up to `limit` inboxes of the space, a different slice each run when there are more. */
export async function sweepInboxes(w, sid, { limit = 60 } = {}) {
  let folders;
  try { folders = (await w.fs.readdir(P.inbox(sid))).filter((item) => item.is_dir); } catch (error) { if (fsGone(error)) return; throw error; }
  if (!folders.length) return;
  const start = folders.length > limit ? (Math.floor(w.now() / SWEEP_EVERY) * limit) % folders.length : 0;
  const chosen = [...folders.slice(start), ...folders.slice(0, start)].slice(0, limit).map((item) => item.path.split('/').pop());
  // Perms and roles must be current: a sweep right after a perms change revokes what it took away.
  const s = await loadSpace(w, sid, { meta: true, fresh: true });
  await loadRecords(w, sid, chosen.filter(isUuid), { fresh: true });
  const owner = (await w.owner()).uuid;
  await pool(chosen, 4, (uuid) => sweepMember(w, sid, s, uuid, owner).catch(() => {}));
}

/** Runs `sweepInboxes` at most once per 10 minutes per space and isolate, on anyone's request; never fails it. */
export async function sweepSoon(w, sid) {
  if (!w.limiter.take(`sweep:${sid}`, 1, SWEEP_EVERY)) return;
  await sweepInboxes(w, sid, { limit: SCHEDULED_FOLDERS }).catch(() => {});
}
