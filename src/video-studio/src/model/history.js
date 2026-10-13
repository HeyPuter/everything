/**
 * Snapshot undo history. Projects are small JSON documents (media lives in
 * files), so a structured clone per edit is cheap and keeps undo exact.
 */
export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Record the state before an edit. */
  push(snapshot, label) {
    this.undoStack.push({ snapshot, label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** A bookmark of the current top step, for fold(). */
  mark() {
    return { top: this.undoStack.at(-1) || null };
  }

  /**
   * Fold every step recorded since mark into one step labeled label, which
   * restores the state before the first of them. Returns that step, or null
   * when nothing was recorded.
   */
  fold(mark, label) {
    // Find the bookmark by identity: the stack may have dropped old steps at its limit since.
    const at = mark?.top ? this.undoStack.lastIndexOf(mark.top) : -1;
    const steps = this.undoStack.splice(at + 1);
    if (!steps.length) return null;
    const entry = { snapshot: steps[0].snapshot, label: label || steps[0].label };
    this.undoStack.push(entry);
    return entry;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  /** Returns { snapshot, label } to restore, given the current state to keep for redo. */
  undo(current) {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ snapshot: current, label: entry.label });
    return entry;
  }

  redo(current) {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ snapshot: current, label: entry.label });
    return entry;
  }

  get undoLabel() {
    return this.undoStack.at(-1)?.label || '';
  }

  get redoLabel() {
    return this.redoStack.at(-1)?.label || '';
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
