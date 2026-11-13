/**
 * Client-side comment state. The worker sends comment snapshots, each with
 * its original revision (seq); the newest snapshot of a comment wins.
 * Recovery may deliver an older revision at a newer sync cursor. Comments being sent show at once as pending.
 */

/** Merge snapshots into a Map(id -> comment); returns true when anything changed. */
export function applyChanges(map, changes) {
  let changed = false;
  for (const c of changes || []) {
    if (!c || typeof c.id !== 'string') continue;
    const cur = map.get(c.id);
    if (cur && !cur.pending && (cur.seq || 0) >= (c.seq || 0)) continue;
    map.set(c.id, c);
    changed = true;
  }
  return changed;
}

const byTime = (a, b) => (a.t ?? 0) - (b.t ?? 0) || (a.created || 0) - (b.created || 0) || (a.id < b.id ? -1 : 1);
const byCreated = (a, b) => (a.created || 0) - (b.created || 0) || (a.id < b.id ? -1 : 1);

/**
 * Threads of one version: top-level comments by time, each with its replies
 * oldest first. A deleted comment with live replies stays as a placeholder;
 * otherwise deleted comments are left out. showResolved false hides
 * resolved threads.
 */
export function threadsFor(map, version, { showResolved = true } = {}) {
  const all = [...map.values()].filter((c) => c.version === version);
  const replies = new Map();
  for (const c of all) {
    if (!c.parent || c.deleted) continue;
    if (!replies.has(c.parent)) replies.set(c.parent, []);
    replies.get(c.parent).push(c);
  }
  return all
    .filter((c) => !c.parent)
    .filter((c) => !c.deleted || replies.has(c.id))
    .filter((c) => showResolved || !c.resolved)
    .sort(byTime)
    .map((c) => ({ ...c, replies: (replies.get(c.id) || []).sort(byCreated) }));
}

/** Counts for a version: open and resolved threads. */
export function threadCounts(map, version) {
  let open = 0;
  let resolved = 0;
  for (const t of threadsFor(map, version)) {
    if (t.deleted) continue;
    if (t.resolved) resolved++;
    else open++;
  }
  return { open, resolved, total: open + resolved };
}

/** The thread (top-level comment) a comment belongs to. */
export function threadOf(map, id) {
  const c = map.get(id);
  if (!c) return null;
  return c.parent ? map.get(c.parent) || null : c;
}

/** A local stand-in for a comment being sent. */
export function pendingComment({ id, version, parent = null, text, t = null, end = null }, me, now = Date.now()) {
  return { id, version, parent, text, t, end, author: { uuid: me.uuid, username: me.username }, created: now, edited: null, resolved: false, deleted: false, seq: 0, pending: true };
}

/** Who may edit or delete a comment: its author, and the owner (delete only). */
export function canEditComment(comment, me) {
  return Boolean(comment && me && !comment.deleted && comment.author?.uuid === me.uuid);
}

export function canDeleteComment(comment, me, role) {
  return Boolean(comment && me && !comment.deleted && (comment.author?.uuid === me.uuid || role === 'owner'));
}

/** "just now", "5 min ago", "3 h ago", else a date. */
export function relativeTime(ts, now = Date.now()) {
  const d = Math.max(0, now - ts);
  if (d < 45_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ts).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}
