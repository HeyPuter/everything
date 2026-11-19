import type { PhotoDocument } from '../model/document';
interface State {
  label: string;
  doc: PhotoDocument;
}
/** A position remembered by `History.mark`, for combining later edits. */
export type HistoryMark = { state: State; existing: Set<State>; open: boolean };
/** A history row retained while an asynchronous edit finishes. */
export type HistoryPosition = { restore(): void; release(): void };
/** Metadata snapshots share immutable asset IDs. Pixel data never enters history.
 * States form one list; `position` is the current one. Linear history drops the
 * states after the current one on a new edit; non-linear history keeps them and
 * appends the edit at the end of the list. */
export class History {
  private states: State[];
  private index = 0;
  // The state the document opened in (or was last reset to); it stays
  // available after older steps are dropped (History Brush source).
  opened: PhotoDocument;
  // Applied to every new state, e.g. to bake pending pixel-layer transforms.
  normalize?: (doc: PhotoDocument, before: PhotoDocument) => void;
  // Whether a new edit keeps the states after the current one.
  nonLinear?: () => boolean;
  constructor(
    public document: PhotoDocument,
    // Retained edits (states beyond the opened one).
    public limit = 60,
  ) {
    this.states = [{ label: '', doc: document }];
    this.opened = document;
  }
  /** Why edits are refused (a shared document the person may only view or
   * comment on), or undefined when they are recorded. */
  get refusal(): string | undefined {
    return undefined;
  }
  /** Record an edit. With `coalesce`, an edit repeating the label of the
   * latest step replaces that step's result (frame selection, for example),
   * and drops the step when it returns to the state before it. */
  execute(label: string, edit: (doc: PhotoDocument) => void, coalesce = false) {
    const before = this.document,
      after = cloneDocument(before);
    edit(after);
    this.normalize?.(after, before);
    if (sameJson(before, after)) return;
    const last = this.states.length - 1;
    const top = this.states[this.index];
    if (coalesce && this.index > 0 && this.index === last && top.label === label && top.doc === before) {
      if (sameJson(this.states[this.index - 1].doc, after)) {
        this.states.pop();
        this.index--;
        this.document = this.states[this.index].doc;
      } else {
        top.doc = after;
        this.document = after;
      }
      return;
    }
    if (!this.nonLinear?.()) this.states.length = this.index + 1;
    this.states.push({ label, doc: after });
    this.index = this.states.length - 1;
    this.trim();
    this.document = after;
  }
  // Open marks keep every state until their edits are combined.
  private holds = 0;
  /** Drop the oldest states beyond the limit. */
  trim() {
    if (this.holds) return;
    const limit = Math.max(1, Math.floor(this.limit));
    while (this.states.length - 1 > limit && this.index > 0) {
      this.states.shift();
      this.index--;
    }
  }
  undo() {
    if (!this.canUndo) return;
    this.index--;
    this.document = this.states[this.index].doc;
  }
  redo() {
    if (!this.canRedo) return;
    this.index++;
    this.document = this.states[this.index].doc;
  }
  reset(doc: PhotoDocument) {
    this.document = doc;
    this.opened = doc;
    this.states = [{ label: '', doc }];
    this.index = 0;
  }
  /** Remember the current state; `squash` later combines the edits recorded
   * since then into one step (a script run is undone at once). */
  mark(): HistoryMark {
    this.holds++;
    return { state: this.states[this.index], existing: new Set(this.states), open: true };
  }
  /** Like `mark`, but when the latest step is labelled `label` (and nothing
   * after it was undone), later edits join that step when squashed: a run
   * paused between its steps continues the undo step it left. */
  resume(label: string): HistoryMark {
    const top = this.states[this.index];
    if (this.index === 0 || this.index !== this.states.length - 1 || top.label !== label) return this.mark();
    this.holds++;
    return { state: this.states[this.index - 1], existing: new Set(this.states.filter((s) => s !== top)), open: true };
  }
  /** Close a mark without combining anything (its states stay as they are). */
  release(mark: HistoryMark) {
    if (!mark.open) return;
    mark.open = false;
    this.holds--;
    this.trim();
  }
  /** Replace the states recorded since `mark` with one step showing the
   * current document. Returns whether the edits left a step behind. */
  squash(mark: HistoryMark, label: string) {
    if (!mark.open) return false;
    mark.open = false;
    this.holds--;
    const start = this.states.indexOf(mark.state);
    const added = this.states.some((s) => !mark.existing.has(s));
    let kept = false;
    // A reset replaced the list, or nothing was recorded (undo/redo only).
    if (start >= 0 && added) {
      const doc = this.document;
      this.states = this.states.filter((s) => mark.existing.has(s));
      const at = this.states.indexOf(mark.state);
      if (doc === mark.state.doc) this.index = at;
      else {
        if (!this.nonLinear?.()) this.states.length = at + 1;
        this.states.push({ label, doc });
        this.index = this.states.length - 1;
        kept = true;
      }
      this.document = this.states[this.index].doc;
    }
    this.trim();
    return kept;
  }
  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.states.length - 1;
  }
  /** Every document state reachable through undo/redo, for asset cleanup. */
  get documents(): PhotoDocument[] {
    return [this.document, ...this.states.map((s) => s.doc)];
  }
  /** The oldest retained state (the opened document until history trims it). */
  get oldest(): PhotoDocument {
    return this.states[0].doc;
  }
  /** Keep the chosen state available without combining the intervening edits. */
  holdPosition(index: number): HistoryPosition {
    const target = this.states[Math.max(0, Math.min(this.states.length - 1, Math.floor(index)))];
    this.holds++;
    let held = true;
    return {
      restore: () => {
        const position = this.states.indexOf(target);
        if (position < 0) throw new Error('That history state is no longer available.');
        this.goto(position);
      },
      release: () => {
        if (!held) return;
        held = false;
        this.holds--;
        this.trim();
      },
    };
  }
  /** Jump to a history state: 0 = before the first retained edit. */
  goto(index: number) {
    const i = Math.max(0, Math.min(this.states.length - 1, Math.floor(index)));
    this.index = i;
    this.document = this.states[i].doc;
  }
  get position() {
    return this.index;
  }
  /** Labels of the states after the current one, nearest first. */
  get redoLabels() {
    return this.states.slice(this.index + 1).map((s) => s.label);
  }
  /** Label of the edit that made the oldest retained state: empty while it
   * is the opened document, otherwise the latest step history dropped. */
  get baseLabel() {
    return this.states[0].label;
  }
  /** Every retained state, oldest first, with the label of the edit that
   * made it (read-only; for views that show a stored state). */
  get entries(): readonly { readonly label: string; readonly doc: PhotoDocument }[] {
    return this.states.map(({ label, doc }) => ({ label, doc }));
  }
  /** Labels of the edits up to the current state. */
  get labels() {
    return this.states.slice(1, this.index + 1).map((s) => s.label);
  }
}

/** A copy of a document for the next history state. Long strings (a loaded
 * .cube file's text, for example) are shared with the original instead of
 * copied: strings are immutable, and every retained state would otherwise
 * hold a copy of its own. */
export function cloneDocument(doc: PhotoDocument): PhotoDocument {
  const copy = structuredClone(doc);
  shareLongStrings(doc, copy);
  return copy;
}
function shareLongStrings(from: unknown, to: unknown) {
  if (typeof from !== 'object' || typeof to !== 'object' || !from || !to) return;
  if (ArrayBuffer.isView(from)) return;
  const a = from as Record<string, unknown>,
    b = to as Record<string, unknown>;
  for (const k in b) {
    const v = b[k];
    if (typeof v === 'string') {
      if (v.length >= 1024 && a[k] === v) b[k] = a[k];
    } else if (typeof v === 'object' && v) shareLongStrings(a[k], v);
  }
}

const omitted = (v: unknown) => v === undefined || typeof v === 'function' || typeof v === 'symbol';
/** Whether `JSON.stringify(a) === JSON.stringify(b)`, without building the
 * strings: history compares whole documents on every edit. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const toJson = (v: unknown) => (v as { toJSON?: unknown } | null)?.toJSON;
  if (typeof toJson(a) === 'function') a = (a as { toJSON(): unknown }).toJSON();
  if (typeof toJson(b) === 'function') b = (b as { toJSON(): unknown }).toJSON();
  if (typeof a === 'number' && !Number.isFinite(a)) a = null;
  if (typeof b === 'number' && !Number.isFinite(b)) b = null;
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  const arrays = Array.isArray(a);
  if (arrays !== Array.isArray(b)) return false;
  if (arrays) {
    const p = a as unknown[],
      q = b as unknown[];
    if (p.length !== q.length) return false;
    for (let i = 0; i < p.length; i++)
      if (!sameJson(omitted(p[i]) ? null : p[i], omitted(q[i]) ? null : q[i])) return false;
    return true;
  }
  // Same keys in the same order, as JSON writes them (undefined values and
  // functions are left out).
  const kx = Object.keys(x),
    ky = Object.keys(y);
  for (let i = 0, j = 0; ; i++, j++) {
    while (i < kx.length && omitted(x[kx[i]])) i++;
    while (j < ky.length && omitted(y[ky[j]])) j++;
    if (i === kx.length || j === ky.length) return i === kx.length && j === ky.length;
    if (kx[i] !== ky[j] || !sameJson(x[kx[i]], y[ky[j]])) return false;
  }
}
