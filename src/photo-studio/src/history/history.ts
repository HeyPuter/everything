import type { PhotoDocument } from '../model/document';
interface State {
  label: string;
  doc: PhotoDocument;
}
/** A position remembered by `History.mark`, for combining later edits. */
export type HistoryMark = { state: State; existing: Set<State>; open: boolean };
/** Metadata snapshots share immutable asset IDs. Pixel data never enters history.
 * States form one list; `position` is the current one. Linear history drops the
 * states after the current one on a new edit; non-linear history keeps them and
 * appends the edit at the end of the list. */
export class History {
  private states: State[];
  private index = 0;
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
  }
  /** Record an edit. With `coalesce`, an edit repeating the label of the
   * latest step replaces that step's result (frame selection, for example),
   * and drops the step when it returns to the state before it. */
  execute(label: string, edit: (doc: PhotoDocument) => void, coalesce = false) {
    const before = this.document,
      after = structuredClone(before);
    edit(after);
    this.normalize?.(after, before);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const last = this.states.length - 1;
    const top = this.states[this.index];
    if (coalesce && this.index > 0 && this.index === last && top.label === label && top.doc === before) {
      if (JSON.stringify(this.states[this.index - 1].doc) === JSON.stringify(after)) {
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
  /** Labels of the edits up to the current state. */
  get labels() {
    return this.states.slice(1, this.index + 1).map((s) => s.label);
  }
}
