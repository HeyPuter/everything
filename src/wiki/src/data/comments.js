/**
 * Comments on a page live in the page's comments document ('<pageId>.c'),
 * which people who can comment (but not edit) are allowed to change:
 *
 *   threads: Y.Map<threadId, Y.Map{ block, quote, resolved, created, by, messages: Y.Array }>
 *   message: Y.Map{ id, by, text, at, edited, deleted }
 *
 * A thread with a block is anchored to that block (and the text that was
 * selected when it started); one without is about the whole page.
 *
 * Replies append to the array, so replies sent at once all stay. Editing
 * or deleting sets fields on the message, so it never moves or doubles.
 * Messages written before they were Y.Maps are plain objects; the first
 * edit swaps one for a Y.Map, and reads drop the copies that two edits at
 * once used to leave behind.
 */
import { Y, local } from './ydoc.js';
import { uid } from '../lib/ids.js';

const MAX_TEXT = 4000;

function threadsOf(doc) {
  return doc.getMap('threads');
}

const plainMessage = (x) => (x instanceof Y.Map ? x.toJSON() : x);

/** The version of a message to show when older edits left copies of it. */
function pick(copies) {
  return copies.find((c) => c.deleted) || copies.reduce((best, c) => ((c.edited || 0) >= (best.edited || 0) ? c : best));
}

/** Messages in order, one per id. */
function messagesOf(arr) {
  const byId = new Map();
  for (const x of arr instanceof Y.Array ? arr.toArray() : []) {
    const msg = plainMessage(x);
    if (!msg?.id) continue;
    if (!byId.has(msg.id)) byId.set(msg.id, []);
    byId.get(msg.id).push(msg);
  }
  return [...byId.values()].map(pick);
}

function messageValue(fields) {
  const m = new Y.Map();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) m.set(k, v);
  return m;
}

function plainThread(id, m) {
  return {
    id,
    block: m.get('block') ?? null,
    quote: m.get('quote') || '',
    resolved: !!m.get('resolved'),
    created: m.get('created') || 0,
    by: m.get('by') || null,
    messages: messagesOf(m.get('messages')).filter((x) => !x.deleted),
  };
}

export function listThreads(doc) {
  const out = [];
  for (const [id, m] of threadsOf(doc).entries()) if (m instanceof Y.Map) out.push(plainThread(id, m));
  return out.filter((t) => t.messages.length).sort((a, b) => a.created - b.created);
}

export function getThread(doc, id) {
  const m = threadsOf(doc).get(id);
  return m instanceof Y.Map ? plainThread(id, m) : null;
}

export function addThread(doc, { block = null, quote = '', text, by = null }) {
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (!clean) return null;
  const id = uid();
  local(doc, () => {
    const m = new Y.Map();
    const messages = new Y.Array();
    m.set('block', block);
    m.set('quote', String(quote || '').slice(0, 300));
    m.set('resolved', false);
    m.set('created', Date.now());
    m.set('by', by);
    m.set('messages', messages);
    messages.push([messageValue({ id: uid(), by, text: clean, at: Date.now() })]);
    threadsOf(doc).set(id, m);
  });
  return id;
}

export function reply(doc, threadId, text, by = null) {
  const m = threadsOf(doc).get(threadId);
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (!(m instanceof Y.Map) || !(m.get('messages') instanceof Y.Array) || !clean) return null;
  const id = uid();
  local(doc, () => {
    m.get('messages').push([messageValue({ id, by, text: clean, at: Date.now() })]);
    // Replying to a resolved thread opens it again.
    if (m.get('resolved')) m.set('resolved', false);
  });
  return id;
}

export function setResolved(doc, threadId, resolved) {
  const m = threadsOf(doc).get(threadId);
  if (!(m instanceof Y.Map)) return;
  local(doc, () => m.set('resolved', !!resolved));
}

/** Sets fields on a message (undefined removes one). */
function changeMessage(doc, threadId, messageId, fields) {
  const m = threadsOf(doc).get(threadId);
  if (!(m instanceof Y.Map)) return false;
  const arr = m.get('messages');
  if (!(arr instanceof Y.Array)) return false;
  const copies = arr
    .toArray()
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => plainMessage(x)?.id === messageId);
  if (!copies.length) return false;
  local(doc, () => {
    let maps = copies.filter(({ x }) => x instanceof Y.Map).map(({ x }) => x);
    const plain = copies.filter(({ x }) => !(x instanceof Y.Map));
    for (const { i } of [...plain].reverse()) arr.delete(i, 1);
    if (!maps.length) {
      const replacement = messageValue(pick(plain.map(({ x }) => x)));
      arr.insert(plain[0].i, [replacement]);
      maps = [replacement];
    }
    for (const map of maps) for (const [k, v] of Object.entries(fields)) v === undefined ? map.delete(k) : map.set(k, v);
  });
  return true;
}

export function editMessage(doc, threadId, messageId, text) {
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (!clean) return false;
  return changeMessage(doc, threadId, messageId, { text: clean, edited: Date.now() });
}

/** Deletes a message; a thread with no messages left disappears. */
export function deleteMessage(doc, threadId, messageId) {
  const ok = changeMessage(doc, threadId, messageId, { deleted: true, text: undefined, edited: undefined });
  const t = getThread(doc, threadId);
  if (ok && t && !t.messages.length) local(doc, () => threadsOf(doc).delete(threadId));
  return ok;
}

/** Open threads per block, for the markers in the margin. */
export function openByBlock(doc) {
  const counts = new Map();
  for (const t of listThreads(doc)) {
    if (t.resolved || !t.block) continue;
    counts.set(t.block, (counts.get(t.block) || 0) + 1);
  }
  return counts;
}

export function openCount(doc) {
  return listThreads(doc).filter((t) => !t.resolved).length;
}
