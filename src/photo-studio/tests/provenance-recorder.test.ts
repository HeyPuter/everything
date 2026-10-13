// The provenance recorder against real histories: plain linear and
// non-linear History, and SharedHistory showing projections of a shared
// document (with a stand-in for the room connection).
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentSession } from '../src/app/session';
import { SharedHistory } from '../src/collab/shared-history';
import { installRecorder, recordOf, trackingOf } from '../src/features/provenance/recorder';
import { newDocument, type PhotoDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { serialize, deserialize } from '../src/model/serialization';
import type { Editor } from '../src/editor';

type Hook = (e: Editor) => void;
const hooks: Hook[] = [];
const editor = {
  session: undefined as unknown as DocumentSession,
  sessions: [] as DocumentSession[],
  currentCommand: undefined as string | undefined,
  lastCommand: undefined as string | undefined,
  activeTool: undefined,
  tool: 'move',
  preferences: { provenancePrompts: true },
  onUpdate: (h: Hook) => void hooks.push(h),
};
const e = editor as unknown as Editor;
const update = () => hooks.forEach((h) => h(e));
beforeAll(() => installRecorder(e));

function session(doc: PhotoDocument = newDocument(20, 10, 'Test'), history?: (doc: PhotoDocument) => DocumentSession['history']) {
  const s = new DocumentSession(doc);
  if (history) s.history = history(doc);
  s.hasDocument = true;
  editor.sessions.push(s);
  editor.session = s;
  update();
  return s;
}
let n = 0;
/** One edit as a command would make it, then the editor's update. */
function edit(s: DocumentSession, label: string, coalesce = false) {
  s.history.execute(label, (d) => void ((d as { note?: number }).note = ++n), coalesce);
  update();
}
const steps = (s: DocumentSession) => recordOf(s).steps.map((x) => `${x.label}${(x.count ?? 1) > 1 ? ` x${x.count}` : ''}${x.undone ? ' (undone)' : ''}`);

/** The room side of a shared document: this person's steps, and the merged
 * state shown as a new document object (like `SharedBinding.project`). */
class Room {
  entries: { label: string; before: PhotoDocument; after: PhotoDocument }[] = [];
  redoEntries: Room['entries'] = [];
  canEdit = true;
  limit = 60;
  constructor(public history: SharedHistory) {
    history.binding = this as unknown as SharedHistory['binding'];
  }
  get undoCount() {
    return this.entries.length;
  }
  get redoCount() {
    return this.redoEntries.length;
  }
  labels() {
    return this.entries.map((x) => x.label);
  }
  redoLabels() {
    return this.redoEntries.map((x) => x.label).reverse();
  }
  topLabel() {
    return this.entries.at(-1)?.label;
  }
  documents() {
    return [...this.entries, ...this.redoEntries].flatMap((x) => [x.before, x.after]);
  }
  commit(before: PhotoDocument, after: PhotoDocument, label: string, merge: boolean) {
    const top = this.entries.at(-1);
    if (merge && top) top.after = after;
    else this.entries.push({ label, before, after });
    this.redoEntries = [];
  }
  /** Written: older steps beyond the limit are forgotten, then the merged state shows. */
  written() {
    while (this.entries.length > this.limit) this.entries.shift();
    this.project();
  }
  /** Show the shared state (with other people's changes merged in). */
  project(from = this.history.document, remote?: string) {
    this.history.show({ ...from, ...(remote ? { name: remote } : {}) });
    update();
  }
  undo() {
    const x = this.entries.pop();
    if (!x) return;
    this.redoEntries.push(x);
    this.project(x.before);
  }
  redo() {
    const x = this.redoEntries.pop();
    if (!x) return;
    this.entries.push(x);
    this.project(x.after);
  }
  clear() {}
  replace() {}
  boundary() {}
  refuse() {}
}
function shared() {
  let room!: Room;
  const s = session(newDocument(20, 10, 'Shared'), (doc) => {
    const h = new SharedHistory(doc);
    room = new Room(h);
    return h;
  });
  return { s, room };
}

describe('provenance recorder', () => {
  it('records each edit of a linear history once and marks replaced ones undone', () => {
    const s = session();
    edit(s, 'Brush Tool');
    edit(s, 'Brush Tool');
    edit(s, 'Invert');
    s.history.undo();
    update();
    s.history.redo();
    update();
    s.history.undo();
    update();
    edit(s, 'Blur');
    expect(steps(s)).toEqual(['Brush Tool x2', 'Invert (undone)', 'Blur']);
    // A coalesced edit replaces the latest step's result.
    edit(s, 'Blur', true);
    expect(steps(s)).toEqual(['Brush Tool x2', 'Invert (undone)', 'Blur']);
  });

  it('keeps the steps leading to the current state in non-linear history', () => {
    const s = session();
    s.history.nonLinear = () => true;
    edit(s, 'A');
    edit(s, 'B');
    s.history.goto(1);
    update();
    edit(s, 'C');
    expect(steps(s)).toEqual(['A', 'B (undone)', 'C']);
    // Back to B (still in the list) and on from there: A and B are kept, C is not.
    s.history.goto(2);
    update();
    edit(s, 'D');
    expect(steps(s)).toEqual(['A', 'B', 'C (undone)', 'D']);
  });

  it('keeps no document state alive (only the one it last saw)', () => {
    const s = session();
    s.history.limit = 3;
    for (let i = 0; i < 20; i++) edit(s, `Step ${i}`);
    const docs: unknown[] = [];
    const walk = (v: unknown, seen = new Set<unknown>()) => {
      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray((v as PhotoDocument).layers) && 'width' in (v as object)) return void docs.push(v);
      for (const x of v instanceof Map ? v.values() : v instanceof Set ? v.values() : Object.values(v)) walk(x, seen);
    };
    const t = trackingOf(s)!;
    walk({ ...t, last: undefined });
    expect(docs).toEqual([]);
    expect(t.last).toBe(s.doc);
    expect(steps(s)).toHaveLength(20);
  });

  it('records AI layers a document starts with', () => {
    const doc = newDocument(20, 10, 'Restored');
    const layer = newPixelLayer('AI Restore', doc);
    layer.generated = { kind: 'edit', prompt: 'restore the photo', model: 'example-model' };
    doc.layers = [layer];
    editor.currentCommand = 'restore.open';
    const s = session(doc);
    editor.currentCommand = undefined;
    expect(recordOf(s).ai).toEqual([expect.objectContaining({ command: 'restore.open', kind: 'edit', prompt: 'restore the photo', model: 'example-model', layer: 'AI Restore' })]);
  });

  it('carries the record of a duplicated document (read from its project) over to the copy', async () => {
    const s = session();
    edit(s, 'Invert');
    const loaded = await deserialize(await serialize(s.doc, s.assets));
    const doc = Object.assign(loaded.document, { id: 'copy', name: 'Copy' });
    const copy = session(doc);
    expect(steps(copy)).toEqual(['Invert']);
    expect(recordOf(copy)).not.toBe(recordOf(s));
  });
});

describe('provenance recorder in shared documents', () => {
  it('records a step once although the merged state shows after it, and never records remote changes', () => {
    const { s, room } = shared();
    edit(s, 'Brush Tool');
    room.written();
    room.project(undefined, 'Renamed by someone else');
    room.project(undefined, 'Again');
    edit(s, 'Invert');
    room.written();
    expect(steps(s)).toEqual(['Brush Tool', 'Invert']);
    // A merged (coalesced) edit replaces the latest step's result.
    edit(s, 'Invert', true);
    room.written();
    expect(steps(s)).toEqual(['Brush Tool', 'Invert']);
  });

  it('follows Undo and Redo through projections', () => {
    const { s, room } = shared();
    edit(s, 'A');
    room.written();
    edit(s, 'B');
    room.written();
    s.history.undo();
    s.history.redo();
    s.history.undo();
    expect(steps(s)).toEqual(['A', 'B']);
    edit(s, 'C');
    room.written();
    expect(steps(s)).toEqual(['A', 'B (undone)', 'C']);
  });

  it('does not take forgotten old steps for Undo', () => {
    const { s, room } = shared();
    room.limit = 2;
    for (const label of ['A', 'B', 'C', 'D']) {
      edit(s, label);
      room.written();
    }
    expect(steps(s)).toEqual(['A', 'B', 'C', 'D']);
  });
});
