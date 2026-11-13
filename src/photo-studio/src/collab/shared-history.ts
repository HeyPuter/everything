// History of a shared document. The editor keeps working with immutable
// document snapshots; this history writes each step into the shared Yjs
// document and shows the merged result. Undo and Redo apply to this
// person's own steps only (a Yjs UndoManager tracking local edits): undoing
// a step restores what it changed unless someone changed the same property
// or tile since, and never removes other people's work. The History panel
// lists this person's steps; other people's edits appear without steps.
import * as Y from 'yjs';
import { History, type HistoryMark, type HistoryPosition } from '../history/history';
import type { PhotoDocument } from '../model/document';
import type { Assets } from '../model/assets';
import { ORIGIN } from './shared-project';
import type { RoomClient } from './client';
import { CollabError } from './api';

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
  override get refusal() {
    return this.binding.canEdit ? undefined : this.binding.refusal();
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
  override holdPosition(index: number): HistoryPosition {
    return this.binding.holdPosition(index);
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
  private navigationHolds = 0;
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
    this.undoManager = new Y.UndoManager([p.doc, p.layers], { trackedOrigins: new Set([ORIGIN.local]), captureTimeout: 2 ** 31, deleteFilter: (item) => this.mayRemove(item) });
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
  refusal() {
    return this.closed ? 'This document is no longer shared.' : this.client.canComment ? 'You can comment on this shared document but not change it.' : 'You can view this shared document but not change it.';
  }
  refuse() {
    this.o.onMessage?.(this.refusal());
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
  holdPosition(index: number): HistoryPosition {
    const all = [...this.entries, ...[...this.redoEntries].reverse()];
    const position = Math.max(0, Math.min(all.length, Math.floor(index)));
    const target = all[position ? position - 1 : 0];
    this.navigationHolds++;
    let held = true;
    return {
      restore: () => {
        const current = [...this.entries, ...[...this.redoEntries].reverse()];
        const at = target ? current.indexOf(target) : 0;
        if (at < 0) throw new Error('That history state is no longer available.');
        this.history.goto(at + (position ? 1 : 0));
      },
      release: () => {
        if (!held) return;
        held = false;
        this.navigationHolds--;
        this.trimEntries(this.history.limit);
      },
    };
  }
  private trimEntries(limit: number) {
    if (this.navigationHolds) return;
    while (this.entries.length > Math.max(1, limit) && this.entries[0].written) {
      const old = this.entries.shift()!;
      this.undoManager.undoStack.splice(0, old.items);
    }
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
      this.trimEntries(limit);
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
        // Each Undo item is applied on its own; items others have since
        // replaced change nothing and are dropped, so the count follows.
        let moved = 0;
        for (let i = 0; i < entry.items; i++) if (this.step('undo')) moved++;
        entry.items = moved;
        if (!moved) this.usedUp(entry, this.redoEntries, 'undo');
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
        // Each Undo item is applied on its own; items others have since
        // replaced change nothing and are dropped, so the count follows.
        let moved = 0;
        for (let i = 0; i < entry.items; i++) if (this.step('redo')) moved++;
        entry.items = moved;
        if (!moved) this.usedUp(entry, this.entries, 'redo');
      }
      this.project(true, entry.after);
    });
  }
  /** Undo or redo exactly the top Yjs stack item. A Yjs UndoManager skips
   * items that no longer change anything (others changed the same
   * properties since) and goes on to earlier ones; history entries and
   * stack items must stay one for one, so the rest of the stack is set
   * aside meanwhile. Returns whether the item changed the document. */
  private step(kind: 'undo' | 'redo') {
    const um = this.undoManager;
    const stack = kind === 'undo' ? um.undoStack : um.redoStack;
    if (!stack.length) return false;
    const rest = stack.splice(0, stack.length - 1);
    this.touched.clear();
    this.popping = stack[0];
    um.stopCapturing();
    try {
      return (kind === 'undo' ? um.undo() : um.redo()) !== null;
    } finally {
      this.popping = undefined;
      stack.unshift(...rest);
      um.stopCapturing();
    }
  }
  // Layers this person added that others have changed since: undoing the
  // addition keeps them (with everything in them), so Undo never removes
  // other people's work. Worked out once per Undo or Redo.
  private touched = new Map<Y.Map<unknown>, boolean>();
  private popping?: { insertions: Parameters<typeof Y.isDeleted>[0] };
  private mayRemove(item: Y.Item) {
    const layers = this.client.project.layers as unknown as Y.AbstractType<unknown>;
    let entry: Y.AbstractType<unknown> | null = null;
    for (let at: Y.Item | null = item; at; at = at.parent instanceof Y.AbstractType ? at.parent._item : null) {
      if (at.parent === layers) {
        // Only when this step added the layer; its other edits undo as usual.
        if (this.popping && Y.isDeleted(this.popping.insertions, at.id)) entry = at.content instanceof Y.ContentType ? at.content.type : null;
        break;
      }
    }
    if (!(entry instanceof Y.Map)) return true;
    let others = this.touched.get(entry);
    if (others === undefined) {
      const me = this.client.ydoc.clientID;
      const foreign = (map: Y.Map<unknown>): boolean => {
        for (const it of map._map.values()) {
          if (it.deleted) continue;
          if (it.id.client !== me) return true;
          const v = it.content instanceof Y.ContentType ? it.content.type : null;
          if (v instanceof Y.Map && foreign(v)) return true;
        }
        return false;
      };
      others = foreign(entry);
      this.touched.set(entry, others);
    }
    return !others;
  }
  /** A step whose changes others have all replaced: Yjs dropped its stack
   * item, so its history entry goes too. */
  private usedUp(entry: Entry, list: Entry[], kind: 'undo' | 'redo') {
    const at = list.lastIndexOf(entry);
    if (at >= 0) list.splice(at, 1);
    this.o.onMessage?.(`Nothing to ${kind} in “${entry.label}”: other people have changed it since.`);
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
      // Validated (and repaired where a merge left it invalid) by the projection.
      result = this.client.project.project({ selection: local.selection, selectionMask: local.selectionMask, quickMask: local.quickMask, imageAssets: local.imageAssets, hdrPreview: local.hdrPreview });
    } catch (error) {
      this.o.onMessage?.(`The shared document contains a change this browser cannot show: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.reportDropped(result.dropped);
    this.client.o.tiles.prune();
    this.shown = result.document;
    h.show(result.document);
    this.o.onDocument?.(result.document);
    const missing = this.client.project.missing(this.assets);
    if (!result.complete || missing.tiles.size || missing.assets.size) void this.fetch(missing);
  }
  private dropped = '';
  /** Say once what a merge left invalid and this browser does not show. */
  reportDropped(dropped: string[]) {
    const text = dropped.join(', ');
    if (text && text !== this.dropped) this.o.onMessage?.(`Changes made at the same time could not all be combined: the shared document is shown without ${text}.`);
    this.dropped = text;
  }
  private async fetch(missing: ReturnType<RoomClient['project']['missing']>) {
    if (this.fetching) return;
    this.fetching = true;
    try {
      let arrived = await this.client.fetchTiles(missing.tiles);
      for (const [id, ref] of missing.assets) {
        await this.client.fetchAsset(id, ref);
        arrived++;
      }
      // Nothing came (content not uploaded yet, or never): wait before asking
      // again instead of asking in a loop.
      if (!arrived) throw new Error('Not available yet.');
      this.fetchDelay = 500;
      this.fetching = false;
      this.client.project.invalidate();
      this.schedule(0);
    } catch {
      this.fetching = false;
      // Not uploaded yet, or offline: try again a little later.
      this.retryLater();
    }
  }
  /** Try downloading missing content again after a while. */
  retryLater() {
    this.fetchDelay = Math.min(15_000, this.fetchDelay * 2);
    setTimeout(() => !this.closed && this.project(false), this.fetchDelay);
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
  let unavailable = false;
  for (let round = 0; ; round++) {
    const missing = client.project.missing(assets);
    if (result.complete && !missing.tiles.size && !missing.assets.size) break;
    progress(`Downloading ${missing.tiles.size} tile${missing.tiles.size === 1 ? '' : 's'}…`);
    let arrived = await client.fetchTiles(missing.tiles);
    for (const [id, ref] of missing.assets)
      try {
        await client.fetchAsset(id, ref);
        arrived++;
      } catch (error) {
        if (error instanceof CollabError && error.network) throw error;
      }
    client.project.invalidate();
    result = client.project.project({ selection: null });
    // Content someone referred to but has not uploaded (or never will): the
    // document opens without it rather than not at all, and fills in later.
    if (!arrived || round >= 8) {
      unavailable = !result.complete || client.project.missing(assets).tiles.size > 0 || client.project.missing(assets).assets.size > 0;
      break;
    }
  }
  const binding = new SharedBinding(client, assets, result.document, o);
  binding.reportDropped(result.dropped);
  if (unavailable) {
    o.onMessage?.('Some of the shared document is not available yet. It is shown without it and fills in when it arrives.');
    binding.retryLater();
  }
  return binding;
}
