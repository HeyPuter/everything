// Comments of a shared document, stored in its Yjs document. Changes are
// written with their own origin, so they never enter Undo, and travel through
// the same outbox as edits; the worker checks authorship on every commit.
import { clampText, newMessage, newThread, normalizeAnchor, type CommentAnchor, type CommentAuthor, type CommentThread } from './comments';
import { commentsOf, putMessage, readThreads, setThreadField, writeThread } from './ycomments';
import { ORIGIN } from './shared-project';
import type { CommentStore } from './comment-store';
import type { RoomClient } from './client';

export class SharedComments implements CommentStore {
  readonly shared = true;
  version = 0;
  private cache?: CommentThread[];
  constructor(
    private client: RoomClient,
    private changed: () => void = () => {},
  ) {
    commentsOf(client.ydoc).observeDeep(() => {
      this.cache = undefined;
      this.version++;
      this.changed();
    });
  }
  private get doc() {
    return this.client.ydoc;
  }
  threads() {
    return (this.cache ??= readThreads(this.doc));
  }
  me(): CommentAuthor {
    const u = this.client.user;
    return { id: u?.uuid ?? 'unknown', name: u?.username ?? 'Unknown' };
  }
  canComment() {
    return this.client.canComment;
  }
  private write(fn: () => void) {
    if (!this.canComment()) throw new Error('You can view this shared document but not comment on it.');
    this.doc.transact(fn, ORIGIN.comments);
  }
  private find(id: string) {
    const t = this.threads().find((x) => x.id === id);
    if (!t) throw new Error('This comment no longer exists.');
    return t;
  }
  add(anchor: CommentAnchor, text: string, layer?: string) {
    const t = newThread(anchor, this.me(), text, layer);
    this.write(() => writeThread(this.doc, t));
    return t;
  }
  reply(thread: string, text: string) {
    this.write(() => putMessage(this.doc, thread, newMessage(this.me(), text)));
  }
  edit(thread: string, message: string, text: string) {
    const m = this.find(thread).messages.find((x) => x.id === message);
    if (!m) return;
    this.write(() => putMessage(this.doc, thread, { ...m, text: clampText(text), edited: Date.now() }));
  }
  remove(thread: string, message?: string) {
    // Shared comments are marked removed; their record stays (the worker refuses outright removal).
    if (!message) return this.write(() => setThreadField(this.doc, thread, 'deleted', true));
    const m = this.find(thread).messages.find((x) => x.id === message);
    if (m) this.write(() => putMessage(this.doc, thread, { ...m, deleted: true }));
  }
  resolve(thread: string, resolved: boolean) {
    this.write(() => setThreadField(this.doc, thread, 'resolved', resolved ? { by: this.me(), at: Date.now() } : null));
  }
  move(thread: string, anchor: CommentAnchor) {
    this.write(() => setThreadField(this.doc, thread, 'anchor', normalizeAnchor(anchor)));
  }
}
