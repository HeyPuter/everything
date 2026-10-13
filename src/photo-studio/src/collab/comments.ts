// Review comments: threads pinned to a point or a region of the canvas, with
// replies, @mentions and a resolved state. The model is plain data, shared by
// local documents (saved in .photo projects) and shared documents (a Yjs map,
// see shared-project.ts), and validated the same way in the room worker.

export type CommentAuthor = { id: string; name: string };
/** Document pixels; a region has a width and height. */
export type CommentAnchor = { x: number; y: number; width?: number; height?: number };
export type CommentMessage = {
  id: string;
  author: CommentAuthor;
  text: string;
  created: number;
  edited?: number;
  // Removed messages keep their record (soft delete) and show as removed.
  deleted?: boolean;
};
export type CommentThread = {
  id: string;
  anchor: CommentAnchor;
  // The layer selected when the comment was placed (context only).
  layer?: string;
  author: CommentAuthor;
  created: number;
  resolved?: { by: CommentAuthor; at: number } | null;
  deleted?: boolean;
  messages: CommentMessage[];
};

export const LIMITS = { threads: 500, messages: 100, text: 4000, name: 80 };

const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(v);
function validAuthor(a: unknown): a is CommentAuthor {
  const x = a as CommentAuthor;
  return !!x && typeof x === 'object' && id(x.id) && typeof x.name === 'string' && x.name.length <= LIMITS.name;
}
export function validAnchor(a: unknown): a is CommentAnchor {
  const x = a as CommentAnchor;
  if (!x || typeof x !== 'object' || !finite(x.x) || !finite(x.y) || Math.abs(x.x) > 1e6 || Math.abs(x.y) > 1e6) return false;
  if (x.width === undefined && x.height === undefined) return true;
  return finite(x.width) && finite(x.height) && x.width! > 0 && x.height! > 0 && x.width! <= 1e6 && x.height! <= 1e6;
}
export function validMessage(m: unknown): m is CommentMessage {
  const x = m as CommentMessage;
  return (
    !!x &&
    typeof x === 'object' &&
    id(x.id) &&
    validAuthor(x.author) &&
    typeof x.text === 'string' &&
    x.text.length <= LIMITS.text &&
    finite(x.created) &&
    (x.edited === undefined || finite(x.edited)) &&
    (x.deleted === undefined || typeof x.deleted === 'boolean')
  );
}
/** Throws on anything that is not a well-formed list of threads. */
export function validateComments(value: unknown): CommentThread[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > LIMITS.threads) throw new Error('Invalid comments.');
  const ids = new Set<string>();
  for (const t of value as CommentThread[]) {
    if (
      !t ||
      typeof t !== 'object' ||
      !id(t.id) ||
      ids.has(t.id) ||
      !validAnchor(t.anchor) ||
      (t.layer !== undefined && typeof t.layer !== 'string') ||
      !validAuthor(t.author) ||
      !finite(t.created) ||
      (t.deleted !== undefined && typeof t.deleted !== 'boolean') ||
      (t.resolved !== undefined && t.resolved !== null && !(validAuthor(t.resolved.by) && finite(t.resolved.at))) ||
      !Array.isArray(t.messages) ||
      t.messages.length > LIMITS.messages ||
      !t.messages.every(validMessage)
    )
      throw new Error('Invalid comment thread.');
    ids.add(t.id);
  }
  return value as CommentThread[];
}

export const newId = () => crypto.randomUUID();
export function newThread(anchor: CommentAnchor, author: CommentAuthor, text: string, layer?: string, now = Date.now()): CommentThread {
  return {
    id: newId(),
    anchor: normalizeAnchor(anchor),
    ...(layer ? { layer } : {}),
    author,
    created: now,
    resolved: null,
    messages: [{ id: newId(), author, text: clampText(text), created: now }],
  };
}
export const newMessage = (author: CommentAuthor, text: string, now = Date.now()): CommentMessage => ({ id: newId(), author, text: clampText(text), created: now });
export const clampText = (text: string) => text.slice(0, LIMITS.text);
export function normalizeAnchor(a: CommentAnchor): CommentAnchor {
  const x = Math.round(a.x),
    y = Math.round(a.y);
  if (!a.width || !a.height || Math.abs(a.width) < 4 || Math.abs(a.height) < 4) return { x, y };
  // Regions dragged up or left keep a positive size.
  const x0 = Math.round(Math.min(a.x, a.x + a.width)),
    y0 = Math.round(Math.min(a.y, a.y + a.height));
  return { x: x0, y: y0, width: Math.round(Math.abs(a.width)), height: Math.round(Math.abs(a.height)) };
}

/** Names mentioned with @name (letters, digits, dot, dash, underscore). */
export function mentions(text: string): string[] {
  return [...new Set([...text.matchAll(/(^|[^\w@])@([A-Za-z0-9._-]{1,64})/g)].map((m) => m[2]!.replace(/[.]+$/, '')))];
}

export type CommentFilter = 'open' | 'resolved' | 'mine' | 'all';
/** Threads matching a filter; "mine" are those this person started, replied
 * to or is mentioned in. */
export function filterThreads(threads: CommentThread[], filter: CommentFilter, me?: CommentAuthor): CommentThread[] {
  const live = threads.filter((t) => !t.deleted);
  if (filter === 'open') return live.filter((t) => !t.resolved);
  if (filter === 'resolved') return live.filter((t) => !!t.resolved);
  if (filter === 'mine') {
    const name = me?.name.toLowerCase();
    return live.filter((t) => t.author.id === me?.id || t.messages.some((m) => m.author.id === me?.id || (!!name && !m.deleted && mentions(m.text).some((x) => x.toLowerCase() === name))));
  }
  return live;
}

/** Anchor point of a thread's pin (a region's top-left corner). */
export const pinPoint = (t: CommentThread) => ({ x: t.anchor.x, y: t.anchor.y });
export const isRegion = (a: CommentAnchor) => !!a.width && !!a.height;

/**
 * Checks a change of the threads by one person, as the worker does for every
 * commit: new threads and messages must be theirs, only an author may edit or
 * remove their message, nothing is removed outright, and limits hold. Owners
 * may remove (soft delete) anyone's thread or message. Returns a reason when
 * the change is refused.
 */
export function checkCommentChange(before: CommentThread[], after: CommentThread[], user: { uuid: string }, role: string): string | null {
  const old = new Map(before.map((t) => [t.id, t]));
  const owner = role === 'owner';
  if (after.length > Math.max(LIMITS.threads, before.length)) return 'Too many comment threads.';
  const next = new Set(after.map((t) => t.id));
  for (const t of before) if (!next.has(t.id)) return 'Comments cannot be removed outright.';
  for (const t of after) {
    try {
      validateComments([t]);
    } catch {
      return 'Invalid comment thread.';
    }
    const prev = old.get(t.id);
    if (!prev) {
      if (t.author.id !== user.uuid || t.messages.some((m) => m.author.id !== user.uuid)) return 'A new comment must be your own.';
      if (t.deleted) return 'Invalid comment thread.';
      continue;
    }
    if (t.author.id !== prev.author.id || t.author.name !== prev.author.name || t.created !== prev.created) return 'Comment authors cannot change.';
    if (t.deleted !== prev.deleted && !(t.deleted && (owner || prev.author.id === user.uuid))) return 'Only the author can remove a comment.';
    if (t.messages.length > Math.max(LIMITS.messages, prev.messages.length)) return 'Too many replies.';
    const msgs = new Map(prev.messages.map((m) => [m.id, m]));
    const kept = new Set(t.messages.map((m) => m.id));
    for (const m of prev.messages) if (!kept.has(m.id)) return 'Comments cannot be removed outright.';
    for (const m of t.messages) {
      const p = msgs.get(m.id);
      if (!p) {
        if (m.author.id !== user.uuid || m.deleted) return 'A new reply must be your own.';
        continue;
      }
      if (m.author.id !== p.author.id || m.author.name !== p.author.name || m.created !== p.created) return 'Comment authors cannot change.';
      const changedText = m.text !== p.text || m.edited !== p.edited;
      if (changedText && p.author.id !== user.uuid) return 'Only the author can edit a comment.';
      if (m.deleted !== p.deleted && !(m.deleted && (owner || p.author.id === user.uuid))) return 'Only the author can remove a comment.';
    }
    if (JSON.stringify(t.resolved ?? null) !== JSON.stringify(prev.resolved ?? null) && t.resolved && t.resolved.by.id !== user.uuid) return 'Resolve comments in your own name.';
  }
  return null;
}
