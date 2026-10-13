// Where a document's comments live: in the document itself for local
// documents (saved in .photo projects, outside Undo), or in the shared Yjs
// document for shared ones (see shared-comments.ts). Both offer the same
// operations to the Comments panel, tool and overlay.
import { newMessage, newThread, clampText, normalizeAnchor, type CommentAnchor, type CommentAuthor, type CommentThread } from './comments';

export interface CommentStore {
  readonly shared: boolean;
  threads(): CommentThread[];
  me(): CommentAuthor;
  canComment(): boolean;
  add(anchor: CommentAnchor, text: string, layer?: string): CommentThread;
  reply(thread: string, text: string): void;
  edit(thread: string, message: string, text: string): void;
  /** Remove a message (or the whole thread when `message` is omitted). */
  remove(thread: string, message?: string): void;
  resolve(thread: string, resolved: boolean): void;
  move(thread: string, anchor: CommentAnchor): void;
  /** Changes since creation (for redraws and unsaved-change tracking). */
  version: number;
}

/** Comments of a local document. */
export class LocalComments implements CommentStore {
  readonly shared = false;
  version = 0;
  private list: CommentThread[];
  constructor(
    initial: CommentThread[] = [],
    private author: () => CommentAuthor,
    private changed: () => void = () => {},
  ) {
    this.list = structuredClone(initial);
  }
  threads() {
    return this.list;
  }
  me() {
    return this.author();
  }
  canComment() {
    return true;
  }
  private update(fn: (list: CommentThread[]) => CommentThread[]) {
    this.list = fn(this.list);
    this.version++;
    this.changed();
  }
  private thread(id: string, fn: (t: CommentThread) => CommentThread) {
    this.update((list) => list.map((t) => (t.id === id ? fn(structuredClone(t)) : t)));
  }
  add(anchor: CommentAnchor, text: string, layer?: string) {
    const t = newThread(anchor, this.me(), text, layer);
    this.update((list) => [...list, t]);
    return t;
  }
  reply(thread: string, text: string) {
    this.thread(thread, (t) => ({ ...t, messages: [...t.messages, newMessage(this.me(), text)] }));
  }
  edit(thread: string, message: string, text: string) {
    this.thread(thread, (t) => ({ ...t, messages: t.messages.map((m) => (m.id === message ? { ...m, text: clampText(text), edited: Date.now() } : m)) }));
  }
  remove(thread: string, message?: string) {
    // Local comments are removed outright; nobody else holds them.
    if (!message) return this.update((list) => list.filter((t) => t.id !== thread));
    this.thread(thread, (t) => ({ ...t, messages: t.messages.filter((m) => m.id !== message) }));
  }
  resolve(thread: string, resolved: boolean) {
    this.thread(thread, (t) => ({ ...t, resolved: resolved ? { by: this.me(), at: Date.now() } : null }));
  }
  move(thread: string, anchor: CommentAnchor) {
    this.thread(thread, (t) => ({ ...t, anchor: normalizeAnchor(anchor) }));
  }
}
