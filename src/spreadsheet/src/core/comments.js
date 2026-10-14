/**
 * Threaded comments (the .xlsx threadedComments part): a conversation on a cell (a first comment and its
 * replies, each with an author and a time) that can be resolved and reopened. They are not notes:
 * a note is one block of text on a cell (sheet.notes), a thread lives in sheet.comments, keyed by
 * cell as notes are, and a cell holds one or the other.
 *
 * A thread is { done, items: [{ id, author, time, text, userId?, providerId?, mentions? }] }: items[0] is the
 * comment that started it, the rest are replies in order. Ids are GUIDs in braces, as the file
 * format writes them; times are ISO strings in UTC. `mentions` are the people the comment @mentions
 * (see mentions.js). A thread may be assigned to someone (`assignee`: { name, user?, email? }), a task for
 * them that resolving the thread marks done; the assignment is kept in the app's own file and shared
 * workbooks, not in an .xlsx, whose threaded comments have no place for it.
 *
 * Every change goes through setThread, one undo step each (folded into a transaction when inside one).
 */
import { cellKey, parseKey } from './cell.js';
import { normalizeMentions, remapMentions, findMentions, isEmail, isUsername } from './mentions.js';

export const MAX_COMMENT_TEXT = 10000;
export const MAX_REPLIES = 100;

export const newCommentId = () => `{${(globalThis.crypto?.randomUUID?.() || fallbackUuid()).toUpperCase()}}`;
function fallbackUuid() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, hex);
}

const GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i;

function normalizeTime(time) {
  if (typeof time !== 'string' || !time) return null;
  const ms = Date.parse(time);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeItem(item) {
  if (!item || typeof item.text !== 'string') return null;
  const out = {
    id: typeof item.id === 'string' && GUID.test(item.id) ? item.id.toUpperCase() : newCommentId(),
    author: typeof item.author === 'string' && item.author.trim() ? item.author.trim().slice(0, 255) : 'Unknown',
    time: normalizeTime(item.time),
    text: item.text.slice(0, MAX_COMMENT_TEXT),
  };
  if (typeof item.userId === 'string' && item.userId) out.userId = item.userId.slice(0, 255);
  if (typeof item.providerId === 'string' && item.providerId) out.providerId = item.providerId.slice(0, 64);
  const mentions = normalizeMentions(item.mentions, out.text);
  if (mentions.length) out.mentions = mentions;
  return out;
}

/** Whom a thread is assigned to, as the model keeps it, or null. */
export function normalizeAssignee(a) {
  if (!a || typeof a !== 'object' || typeof a.name !== 'string' || !a.name.trim()) return null;
  const out = { name: a.name.trim().slice(0, 255) };
  if (isUsername(a.user)) out.user = a.user;
  if (isEmail(a.email)) out.email = a.email.toLowerCase();
  return out.user || out.email ? out : null;
}

/** A thread as the model keeps it, or null when it holds no comment. */
export function normalizeThread(thread) {
  if (!thread || !Array.isArray(thread.items)) return null;
  const items = thread.items.slice(0, MAX_REPLIES + 1).map(normalizeItem).filter(Boolean);
  if (!items.length) return null;
  const seen = new Set();
  for (const item of items) { if (seen.has(item.id)) item.id = newCommentId(); seen.add(item.id); }
  const assignee = normalizeAssignee(thread.assignee);
  return { done: thread.done === true, items, ...(assignee ? { assignee } : {}) };
}

/** A sheet's threads from their stored form ({ "r,c": thread }), keyed by cell. */
export function readComments(stored) {
  const map = new Map();
  if (!stored || typeof stored !== 'object') return map;
  for (const [key, thread] of Object.entries(stored)) {
    if (!/^\d+,\d+$/.test(key)) continue;
    const t = normalizeThread(thread);
    if (t) map.set(key, t);
  }
  return map;
}

const cloneItem = (i) => (i.mentions ? { ...i, mentions: i.mentions.map((m) => ({ ...m })) } : { ...i });
const cloneThread = (t) => ({ done: !!t.done, items: t.items.map(cloneItem), ...(t.assignee ? { assignee: { ...t.assignee } } : {}) });
/** An item with ids of its own, its mentions' too: two comments in one file must not share an id. */
const freshItem = (i) => ({ ...cloneItem(i), id: newCommentId(), ...(i.mentions ? { mentions: i.mentions.map((m) => ({ ...m, id: newCommentId() })) } : {}) });

/** The stored form of a sheet's threads, or undefined when it has none. */
export function commentsJSON(map) {
  if (!map?.size) return undefined;
  return Object.fromEntries([...map].map(([key, t]) => [key, cloneThread(t)]));
}

/** A copy of a sheet's threads with new ids, for a copied sheet: two threads must not share an id in one file. */
export function freshCommentIds(stored) {
  const map = readComments(stored);
  for (const t of map.values()) t.items = t.items.map(freshItem);
  return map;
}

/* ---------- Reading ---------- */

const commentsOf = (wb, sheetId) => wb.sheet(sheetId)?.comments || null;

export function getThread(wb, sheetId, r, c) {
  return commentsOf(wb, sheetId)?.get(cellKey(r, c)) || null;
}

/** The cells holding threads on a sheet, row by row and left to right, as Next Comment visits them. */
export function threadCells(wb, sheetId) {
  const map = commentsOf(wb, sheetId);
  if (!map?.size) return [];
  return [...map.keys()].map(parseKey).sort((a, b) => a.r - b.r || a.c - b.c);
}

/** The thread after (or before, with step -1) a cell, wrapping round the sheet; null when there is none. */
export function adjacentThread(wb, sheetId, r, c, step = 1) {
  const cells = threadCells(wb, sheetId);
  if (!cells.length) return null;
  if (step > 0) return cells.find((p) => p.r > r || (p.r === r && p.c > c)) || cells[0];
  return [...cells].reverse().find((p) => p.r < r || (p.r === r && p.c < c)) || cells[cells.length - 1];
}

/* ---------- Writing ---------- */

/**
 * Put a thread on a cell (null removes the one there). Undoable. A protected sheet or cell refuses, as
 * it does a note. Returns whether the cell now holds what was asked.
 */
export function setThread(wb, sheetId, r, c, thread, label = null) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return false;
  if (wb.lockedAt(sheetId, r, c)) return false;
  const key = cellKey(r, c);
  const next = thread ? normalizeThread(thread) : null;
  const prev = sheet.comments.get(key) || null;
  if (!prev && !next) return true;
  const apply = (t) => {
    const live = wb.sheet(sheetId);
    if (!live) return;
    if (t) live.comments.set(key, cloneThread(t)); else live.comments.delete(key);
    wb._growTo(live, r + 1, c + 1);
    wb._changed('cells', live.id);
  };
  apply(next);
  wb._push({ label: label || (next ? (prev ? 'Edit comment' : 'New comment') : 'Delete comment'), undo: () => apply(prev), redo: () => apply(next) });
  return true;
}

const stamp = (author, text, now, mentions) => {
  const item = { id: newCommentId(), author: author || 'You', time: (now || new Date()).toISOString(), text: String(text ?? '') };
  const found = normalizeMentions(mentions, item.text);
  if (found.length) item.mentions = found;
  return item;
};

/**
 * Start a thread on a cell; a cell with a thread already gets a reply instead. Empty text adds nothing.
 * `mentions` are the people the text @mentions (findMentions). Returns whether the comment was added.
 */
export function addComment(wb, sheetId, r, c, text, author, now = null, { mentions = null } = {}) {
  if (!String(text ?? '').trim()) return false;
  const existing = getThread(wb, sheetId, r, c);
  if (existing) return replyToThread(wb, sheetId, r, c, text, author, now, { mentions });
  return setThread(wb, sheetId, r, c, { done: false, items: [stamp(author, text, now, mentions)] }, 'New comment');
}

/** Add a reply at the end of a cell's thread. Replying to a resolved thread reopens it. */
export function replyToThread(wb, sheetId, r, c, text, author, now = null, { mentions = null } = {}) {
  const t = getThread(wb, sheetId, r, c);
  if (!t || !String(text ?? '').trim() || t.items.length > MAX_REPLIES) return false;
  return setThread(wb, sheetId, r, c, { ...t, done: false, items: [...t.items, stamp(author, text, now, mentions)] }, 'Reply to comment');
}

/** The comment last added to a cell's thread (what addComment or replyToThread just wrote), or null. */
export function lastThreadItem(wb, sheetId, r, c) {
  return getThread(wb, sheetId, r, c)?.items.at(-1) || null;
}

/**
 * Change the text of one comment in a thread (the first or a reply). Empty text is refused: delete it instead.
 * Its mentions follow the text: one still there keeps its person, one deleted goes, and `picked` people (chosen
 * while editing) are found as new mentions.
 */
export function editThreadItem(wb, sheetId, r, c, id, text, { picked = [] } = {}) {
  const t = getThread(wb, sheetId, r, c);
  if (!t || !String(text ?? '').trim()) return false;
  const at = t.items.findIndex((i) => i.id === id);
  if (at < 0 || (t.items[at].text === text && !picked.length)) return false;
  const kept = remapMentions(t.items[at].mentions, String(text));
  const mentions = normalizeMentions([...kept, ...findMentions(String(text), picked)], String(text));
  const items = t.items.map((i, n) => {
    if (n !== at) return i;
    const { mentions: _old, ...rest } = i;
    return { ...rest, text: String(text), ...(mentions.length ? { mentions } : {}) };
  });
  return setThread(wb, sheetId, r, c, { ...t, items }, 'Edit comment');
}

/** Delete one comment: a reply leaves the thread, the first comment takes the whole thread with it. */
export function deleteThreadItem(wb, sheetId, r, c, id) {
  const t = getThread(wb, sheetId, r, c);
  if (!t) return false;
  const at = t.items.findIndex((i) => i.id === id);
  if (at < 0) return false;
  if (at === 0) return setThread(wb, sheetId, r, c, null, 'Delete thread');
  return setThread(wb, sheetId, r, c, { ...t, items: t.items.filter((_, n) => n !== at) }, 'Delete reply');
}

/** Assign a cell's thread to someone ({ name, user?, email? }), or take the assignment away (null). Undoable. */
export function setThreadAssignee(wb, sheetId, r, c, person) {
  const t = getThread(wb, sheetId, r, c);
  if (!t) return false;
  const next = normalizeAssignee(person);
  const same = (a, b) => (a?.user || a?.email || null) === (b?.user || b?.email || null);
  if (same(t.assignee, next)) return false;
  const { assignee: _old, ...rest } = t;
  return setThread(wb, sheetId, r, c, { ...rest, ...(next ? { assignee: next } : {}) }, next ? 'Assign thread' : 'Unassign thread');
}

export function setThreadResolved(wb, sheetId, r, c, done) {
  const t = getThread(wb, sheetId, r, c);
  if (!t || t.done === !!done) return false;
  return setThread(wb, sheetId, r, c, { ...t, done: !!done }, done ? 'Resolve thread' : 'Reopen thread');
}

/** Delete every thread whose cell `inside(r, c)` accepts; returns how many went. */
export function deleteThreadsWhere(wb, sheetId, inside) {
  const map = commentsOf(wb, sheetId);
  if (!map?.size) return 0;
  let n = 0;
  for (const key of [...map.keys()]) {
    const { r, c } = parseKey(key);
    if (inside(r, c) && setThread(wb, sheetId, r, c, null)) n++;
  }
  return n;
}

/* ---------- Threads travelling with their cells ---------- */

/**
 * A sheet's threads re-keyed for a structural step (rows or columns inserted, deleted or moved): `to(r, c)`
 * says where the cell went, or null when it is gone. The structural step's own snapshot undoes it.
 */
export function remapComments(map, to) {
  if (!map?.size) return map || new Map();
  const out = new Map();
  for (const [key, thread] of map) {
    const { r, c } = parseKey(key);
    const p = to(r, c);
    if (p) out.set(cellKey(p.r, p.c), thread);
  }
  return out;
}

/**
 * Threads inside `range` follow a reordering of its rows (axis 'row') or columns ('col'): `moved` maps an old
 * index to its new one. An index missing from it is a line that went (a removed duplicate): its threads go.
 * Undoable, as part of the caller's transaction.
 */
export function permuteComments(wb, sheetId, range, axis, moved) {
  const map = commentsOf(wb, sheetId);
  if (!map?.size) return;
  const moves = [];
  for (const [key, thread] of map) {
    const { r, c } = parseKey(key);
    if (r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2) continue;
    const i = axis === 'row' ? r : c;
    const j = moved instanceof Map ? moved.get(i) : moved(i);
    if (j === i) continue;
    moves.push({ r, c, thread, to: j == null ? null : axis === 'row' ? { r: j, c } : { r, c: j } });
  }
  for (const m of moves) setThread(wb, sheetId, m.r, m.c, null, 'Move comment');
  for (const m of moves) if (m.to) setThread(wb, sheetId, m.to.r, m.to.c, m.thread, 'Move comment');
}

/**
 * Threads in the block `src` of one sheet move by (dr, dc), onto `toSheetId` (the same sheet for a drag, maybe
 * another for a cut and paste); threads already where the block lands give way. Undoable.
 */
export function carryComments(wb, fromSheetId, src, toSheetId, dr, dc) {
  const from = commentsOf(wb, fromSheetId), to = commentsOf(wb, toSheetId);
  if (!from || !to) return;
  const inSrc = (r, c) => r >= src.r1 && r <= src.r2 && c >= src.c1 && c <= src.c2;
  const inDst = (r, c) => r >= src.r1 + dr && r <= src.r2 + dr && c >= src.c1 + dc && c <= src.c2 + dc;
  const moving = [];
  for (const [key, thread] of from) { const { r, c } = parseKey(key); if (inSrc(r, c)) moving.push({ r, c, thread }); }
  const covered = [];
  for (const key of to.keys()) {
    const { r, c } = parseKey(key);
    if (inDst(r, c) && !(fromSheetId === toSheetId && inSrc(r, c))) covered.push({ r, c });
  }
  if (!moving.length && !covered.length) return;
  for (const { r, c } of covered) setThread(wb, toSheetId, r, c, null, 'Move comment');
  for (const { r, c } of moving) setThread(wb, fromSheetId, r, c, null, 'Move comment');
  for (const { r, c, thread } of moving) setThread(wb, toSheetId, r + dr, c + dc, thread, 'Move comment');
}

/* ---------- The note older readers see ---------- */

/**
 * The plain note written beside a thread in a file, so a reader that knows only notes still shows the
 * conversation: a marker line, then the comment and each reply, the way the format's readers expect.
 */
export function legacyCommentText(thread) {
  const [first, ...replies] = thread.items;
  let text = '[Threaded comment]\n\nThis note shows a threaded comment to apps that read only notes. Changes made to the note may be lost when the file is next opened where threaded comments are supported.\n\n';
  text += `Comment:\n    ${first.text}`;
  for (const reply of replies) text += `\nReply:\n    ${reply.text}`;
  return text;
}

/** Initials for an author's badge: the first letters of the first and last words. */
export function authorInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0] || '';
  const last = words.length > 1 ? [...words[words.length - 1]][0] || '' : '';
  return (first + last).toUpperCase();
}

/* ---------- Copy and paste ---------- */

/** The threads of copied cells, laid out like them (rows × cols of the lines copied), or null when there are none. */
export function copyThreads(wb, sheetId, rows, cols) {
  const map = commentsOf(wb, sheetId);
  if (!map?.size) return null;
  const grid = rows.map((r) => cols.map((c) => map.get(cellKey(r, c)) || null));
  return grid.some((row) => row.some(Boolean)) ? grid.map((row) => row.map((t) => t && cloneThread(t))) : null;
}

/**
 * Paste copied threads with their cells at (r0, c0): each pasted cell takes the copied cell's thread, with ids
 * of its own, or loses the one it had, as Paste All does. A cell that now holds a note keeps the note.
 */
export function pasteThreads(wb, sheetId, threads, r0, c0) {
  if (!threads) return;
  const sheet = wb.sheet(sheetId);
  if (!sheet) return;
  threads.forEach((row, i) => row.forEach((t, j) => {
    const r = r0 + i, c = c0 + j;
    if (t && sheet.notes.has(cellKey(r, c))) return;
    const copy = t && { done: t.done, items: t.items.map(freshItem), ...(t.assignee ? { assignee: { ...t.assignee } } : {}) };
    if (copy || sheet.comments.has(cellKey(r, c))) setThread(wb, sheetId, r, c, copy, 'Paste');
  }));
}
