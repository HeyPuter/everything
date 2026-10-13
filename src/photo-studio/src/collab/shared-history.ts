// History of a shared document. The editor keeps working with immutable
// document snapshots; this history writes each step into the shared Yjs
// document and shows the merged result. Undo and Redo apply to this
// person's own steps only (a Yjs UndoManager tracking local edits): undoing
// a step restores what it changed unless someone changed the same property
// or tile since, and never removes other people's work. The History panel
// lists this person's steps; other people's edits appear without steps.
import * as Y from 'yjs';
import { History, type HistoryMark } from '../history/history';
import type { PhotoDocument } from '../model/document';
import type { Assets } from '../model/assets';
import { validateDocument } from '../model/serialization';
import { ORIGIN } from './shared-project';
import type { RoomClient } from './client';

// One step of this person's history. `items` counts the Undo items it wrote
// into the shared document (more than one when a paused run continued the
// step); without any it changed only this person's selection, which is
// restored on Undo.
type Entry = { label: string; before: PhotoDocument; after: PhotoDocument; items: number; written: boolean };

export class SharedHistory extends History {
  binding!: SharedBinding;
  // Recent documents, so their tiles survive cleanup (Undo may need them).
  private recent: PhotoDocument[] = [];
  private first: PhotoDocument;
  private marks = 0;
  private markedAt = 0;
  constructor(doc: PhotoDocument) {
    super(doc);
    this.first = doc;
  }
  /** Show a document (a projection of the shared state). */
  show(doc: PhotoDocument) {
    this.remember(this.document);
    this.document = doc;
  }
  private remember(doc: PhotoDocument) {
    if (this.recent.at(-1) !== doc) this.recent.push(doc);
    if (this.recent.length > 30) this.recent.shift();
  }
  override execute(label: string, edit: (doc: PhotoDocument) => void, coalesce = false) {
    if (!this.binding.canEdit) {
      this.binding.refuse();
      return;
    }
    const before = this.document,
      after = structuredClone(before);
    edit(after);
    this.normalize?.(after, before);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.remember(before);
    this.document = after;
    const merge = this.marks > 0 ? this.binding.undoCount > this.markedAt : coalesce && this.binding.topLabel() === label;
    this.binding.commit(before, after, label, merge, this.limit);
  }
  override undo() {
    this.binding.undo();
  }
  override redo() {
    this.binding.redo();
  }
  override goto(index: number) {
    const target = Math.max(0, Math.min(this.position + this.binding.redoCount, Math.floor(index)));
    while (this.position > target && this.canUndo) this.undo();
    while (this.position < target && this.canRedo) this.redo();
  }
  override reset(doc: PhotoDocument) {
    if (doc !== this.document && this.binding.canEdit) this.binding.replace(this.document, doc);
    this.remember(this.document);
    this.document = doc;
    this.binding.clear();
  }
  override mark(): HistoryMark {
    if (!this.marks++) this.markedAt = this.binding.undoCount;
    this.binding.boundary();
    return { state: { label: '', doc: this.document }, existing: new Set(), open: true };
  }
  override resume(label: string): HistoryMark {
    // Continue this person's latest step (nothing undone since): later edits merge into it.
    if (this.marks || !this.binding.undoCount || this.binding.redoCount || this.binding.topLabel() !== label) return this.mark();
    this.marks++;
    this.markedAt = this.binding.undoCount - 1;
    return { state: { label: '', doc: this.document }, existing: new Set(), open: true };
  }
  override squash(mark: HistoryMark, label: string) {
    if (!mark.open) return false;
    mark.open = false;
    this.marks = Math.max(0, this.marks - 1);
    const kept = this.binding.undoCount > this.markedAt;
    if (!this.marks) this.binding.boundary(kept ? label : undefined);
    return kept;
  }
  override trim() {}
  override get canUndo() {
    return this.binding.undoCount > 0;
  }
  override get canRedo() {
    return this.binding.redoCount > 0;
  }
  override get documents() {
    return [this.document, this.first, ...this.recent, ...this.binding.documents()];
  }
  override get oldest() {
    return this.first;
  }
  override get position() {
    return this.binding.undoCount;
  }
  override get labels() {
    return this.binding.labels();
  }
  override get redoLabels() {
    return this.binding.redoLabels();
  }
}

export type BindingOptions = {
  // The editor is in a gesture, dialog or transform: wait before showing remote changes.
  busy?: () => boolean;
  // The shown document changed (remote edits, undo, redo).
  onDocument?: (doc: PhotoDocument) => void;
  onMessage?: (text: string) => void;
};

/** Connects a SharedHistory to a RoomClient. */
export class SharedBinding {
  readonly history: SharedHistory;
  readonly undoManager: Y.UndoManager;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private entries: Entry[] = [];
  private redoEntries: Entry[] = [];
  private shown: PhotoDocument;
  private projectTimer?: ReturnType<typeof setTimeout>;
  private fetching = false;
  private fetchDelay = 500;
  closed = false;
  constructor(
    public client: RoomClient,
    public assets: Assets,
    initial: PhotoDocument,
    private o: BindingOptions = {},
  ) {
    const p = client.project;
    // Only this person's edits are tracked; merging is controlled with stopCapturing.
    this.undoManager = new Y.UndoManager([p.doc, p.layers], { trackedOrigins: new Set([ORIGIN.local]), captureTimeout: 2 ** 31 });
    this.history = new SharedHistory(initial);
    this.history.binding = this;
    this.shown = initial;
    const remote = client.o.onRemote;
    client.o.onRemote = () => {
      remote?.();
      this.schedule();
    };
  }
  get canEdit() {
    return this.client.canEdit && !this.closed;
  }
  refuse() {
    this.o.onMessage?.(this.closed ? 'This document is no longer shared.' : this.client.canComment ? 'You can comment on this shared document but not change it.' : 'You can view this shared document but not change it.');
  }
  get undoCount() {
    return this.entries.length;
  }
  get redoCount() {
    return this.redoEntries.length;
  }
  labels() {
    return this.entries.map((e) => e.label);
  }
  redoLabels() {
    return this.redoEntries.map((e) => e.label).reverse();
  }
  topLabel() {
    return this.entries.at(-1)?.label;
  }
  /** States the steps return to, kept so their tiles survive cleanup. */
  documents() {
    return [...this.entries, ...this.redoEntries].flatMap((e) => [e.before, e.after]);
  }
  /** Write one editor step into the shared document (in order, after its tiles are hashed). */
  commit(before: PhotoDocument, after: PhotoDocument, label: string, merge: boolean, limit = 60) {
    const top = this.entries.at(-1);
    let entry: Entry;
    if (merge && top) {
      entry = top;
      entry.after = after;
    } else {
      entry = { label, before, after, items: 0, written: false };
      this.entries.push(entry);
    }
    this.redoEntries = [];
    this.shown = after;
    const fresh = entry !== top;
    this.enqueue(async () => {
      const prepared = await this.client.project.prepare(after, this.assets);
      this.client.stage(prepared);
      if (fresh) this.undoManager.stopCapturing();
      const count = this.undoManager.undoStack.length;
      this.client.project.write(before, after, prepared, ORIGIN.local);
      // A step that changed nothing shared (only the selection) has no Undo item;
      // a continued step can gain one after a boundary.
      entry.items += Math.max(0, this.undoManager.undoStack.length - count);
      this.undoManager.clear(false, true);
      entry.written = true;
      // Older steps beyond the history limit are forgotten.
      while (this.entries.length > Math.max(1, limit) && this.entries[0].written) {
        const old = this.entries.shift()!;
        this.undoManager.undoStack.splice(0, old.items);
      }
    });
  }
  /** Replace the whole document (Revert and similar) without an Undo step. */
  replace(before: PhotoDocument, after: PhotoDocument) {
    this.shown = after;
    this.enqueue(async () => {
      const prepared = await this.client.project.prepare(after, this.assets);
      this.client.stage(prepared);
      this.client.project.write(before, after, prepared, ORIGIN.untracked);
    });
  }
  private enqueue(work: () => Promise<void>) {
    this.queued++;
    this.queue = this.queue
      .then(work)
      .catch((error) => this.o.onMessage?.(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        this.queued--;
        this.schedule(0);
      });
  }
  /** Following steps are separate; with a label, the top step is renamed. */
  boundary(label?: string) {
    if (label !== undefined && this.entries.length) this.entries.at(-1)!.label = label;
    this.enqueue(async () => this.undoManager.stopCapturing());
  }
  undo() {
    const entry = this.entries.pop();
    if (!entry) return;
    this.redoEntries.push(entry);
    this.run(() => {
      if (entry.items) {
        this.undoManager.stopCapturing();
        for (let i = 0; i < entry.items; i++) this.undoManager.undo();
        this.undoManager.stopCapturing();
      }
      this.project(true, entry.before);
    });
  }
  redo() {
    const entry = this.redoEntries.pop();
    if (!entry) return;
    this.entries.push(entry);
    this.run(() => {
      if (entry.items) {
        this.undoManager.stopCapturing();
        for (let i = 0; i < entry.items; i++) this.undoManager.redo();
        this.undoManager.stopCapturing();
      }
      this.project(true, entry.after);
    });
  }
  // Undo and Redo apply at once unless steps are still being written.
  private run(fn: () => void) {
    if (!this.queued) fn();
    else this.enqueue(async () => fn());
  }
  clear() {
    this.entries = [];
    this.redoEntries = [];
    this.enqueue(async () => this.undoManager.clear());
  }

  /** Show the shared state soon (after remote edits). */
  schedule(delay = 30) {
    if (this.closed) return;
    clearTimeout(this.projectTimer);
    this.projectTimer = setTimeout(() => this.project(false), delay);
  }
  /** Project the shared state into the editor unless the person is in the
   * middle of something; `force` shows it at once (Undo and Redo), with the
   * selection of `selectionFrom`. */
  project(force: boolean, selectionFrom?: PhotoDocument) {
    if (this.closed) return;
    const h = this.history;
    if (!force && (this.queued || h.document !== this.shown || this.o.busy?.())) {
      // Unfinished local work (a stroke, a dialog, live text) keeps its own
      // document; remote edits show once it ends.
      this.schedule(250);
      return;
    }
    const local = selectionFrom ?? h.document;
    let result;
    try {
      result = this.client.project.project({ selection: local.selection, selectionMask: local.selectionMask });
      validateDocument(result.document);
    } catch (error) {
      this.o.onMessage?.(`The shared document contains a change this browser cannot show: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.client.o.tiles.prune();
    this.shown = result.document;
    h.show(result.document);
    this.o.onDocument?.(result.document);
    const missing = this.client.project.missing(this.assets);
    if (!result.complete || missing.tiles.size || missing.assets.size) void this.fetch(missing);
  }
  private async fetch(missing: ReturnType<RoomClient['project']['missing']>) {
    if (this.fetching) return;
    this.fetching = true;
    try {
      await this.client.fetchTiles(missing.tiles);
      for (const [id, ref] of missing.assets) await this.client.fetchAsset(id, ref);
      this.fetchDelay = 500;
      this.fetching = false;
      this.client.project.invalidate();
      this.schedule(0);
    } catch {
      this.fetching = false;
      // Not uploaded yet, or offline: try again a little later.
      this.fetchDelay = Math.min(15_000, this.fetchDelay * 2);
      setTimeout(() => !this.closed && this.project(false), this.fetchDelay);
    }
  }
  /** Resolves once queued steps are written into the shared document. */
  async idle() {
    let q;
    do {
      q = this.queue;
      await q;
    } while (q !== this.queue);
  }
  close() {
    this.closed = true;
    clearTimeout(this.projectTimer);
    this.undoManager.destroy();
  }
}

/** The shared state as a complete document, downloading the tiles and
 * assets it needs, then a binding that keeps it current. */
export async function openBinding(client: RoomClient, assets: Assets, o: BindingOptions = {}, progress: (text: string) => void = () => {}) {
  let result = client.project.project({ selection: null });
  for (let round = 0; ; round++) {
    const missing = client.project.missing(assets);
    if (result.complete && !missing.tiles.size && !missing.assets.size) break;
    if (round > 8) throw new Error('Some of the shared document could not be downloaded. Try again shortly.');
    progress(`Downloading ${missing.tiles.size} tile${missing.tiles.size === 1 ? '' : 's'}…`);
    await client.fetchTiles(missing.tiles);
    for (const [id, ref] of missing.assets) await client.fetchAsset(id, ref);
    client.project.invalidate();
    result = client.project.project({ selection: null });
  }
  validateDocument(result.document);
  return new SharedBinding(client, assets, result.document, o);
}
