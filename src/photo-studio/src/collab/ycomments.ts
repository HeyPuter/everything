// Comment threads in a shared document: a Yjs map of threads, each a map of
// registers (anchor, resolved state, removal) and a map of messages keyed by
// ID, so concurrent replies, edits and resolutions merge. A message's removal
// is its own register beside it (`#removed:<id>`), so an owner removing a
// message and its author editing it at the same time both take effect;
// messages written before that carry `deleted` in the message itself, which is
// still read. Comment changes never enter Undo. Used by browsers and by the
// room worker, which checks each commit with checkCommentChange.
import * as Y from 'yjs';
import type { CommentMessage, CommentThread } from './comments';

export const commentsOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('comments');

const REMOVED = '#removed:';

export function readThreads(doc: Y.Doc): CommentThread[] {
  const out: CommentThread[] = [];
  for (const [id, t] of commentsOf(doc)) {
    if (!(t instanceof Y.Map)) continue;
    const msgs = t.get('msgs');
    let messages: CommentMessage[] = [];
    if (msgs instanceof Y.Map) {
      const removed = new Set<string>();
      for (const [k, v] of msgs as Y.Map<unknown>) {
        if (k.startsWith(REMOVED)) {
          if (v === true) removed.add(k.slice(REMOVED.length));
        } else if (v && typeof v === 'object') messages.push(v as CommentMessage);
      }
      messages = messages.map((m) => (removed.has(m.id) && m.deleted !== true ? { ...m, deleted: true } : m));
    }
    messages.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
    const thread = {
      id,
      anchor: t.get('anchor'),
      author: t.get('author'),
      created: t.get('created'),
      resolved: t.get('resolved') ?? null,
      messages,
    } as CommentThread;
    const layer = t.get('layer');
    if (typeof layer === 'string') thread.layer = layer;
    if (t.get('deleted') === true) thread.deleted = true;
    out.push(thread);
  }
  return out.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
}

export function writeThread(doc: Y.Doc, t: CommentThread) {
  const m = new Y.Map<unknown>();
  commentsOf(doc).set(t.id, m);
  m.set('anchor', structuredClone(t.anchor));
  m.set('author', structuredClone(t.author));
  m.set('created', t.created);
  m.set('resolved', t.resolved ? structuredClone(t.resolved) : null);
  if (t.layer) m.set('layer', t.layer);
  if (t.deleted) m.set('deleted', true);
  const msgs = new Y.Map<unknown>();
  m.set('msgs', msgs);
  for (const msg of t.messages) {
    msgs.set(msg.id, content(msg));
    if (msg.deleted) msgs.set(REMOVED + msg.id, true);
  }
}
/** A message without its removal (kept in its own register). */
function content(m: CommentMessage): CommentMessage {
  const { deleted: _, ...rest } = structuredClone(m);
  return rest;
}

function thread(doc: Y.Doc, id: string) {
  const t = commentsOf(doc).get(id);
  if (!(t instanceof Y.Map)) throw new Error('This comment no longer exists.');
  return t;
}
export function setThreadField(doc: Y.Doc, id: string, key: 'anchor' | 'resolved' | 'deleted', value: unknown) {
  thread(doc, id).set(key, value === undefined ? null : structuredClone(value));
}
function messages(doc: Y.Doc, id: string) {
  const msgs = thread(doc, id).get('msgs');
  if (!(msgs instanceof Y.Map)) throw new Error('This comment no longer exists.');
  return msgs as Y.Map<unknown>;
}
/** Add or edit a message (its text); removal is `removeMessage`. */
export function putMessage(doc: Y.Doc, id: string, message: CommentMessage) {
  const msgs = messages(doc, id);
  const old = msgs.get(message.id) as CommentMessage | undefined;
  // A message from before removal had its own register keeps its marker.
  msgs.set(message.id, old?.deleted ? { ...content(message), deleted: true } : content(message));
}
/** Mark a message removed (its record stays). */
export function removeMessage(doc: Y.Doc, id: string, message: string) {
  messages(doc, id).set(REMOVED + message, true);
}
