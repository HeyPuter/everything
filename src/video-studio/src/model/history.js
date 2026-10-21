/**
 * Snapshot undo history. Projects are small JSON documents (media lives in
 * files), so a structured clone per edit is cheap and keeps undo exact.
 * Big projects (thousands of captions) keep fewer steps, so the snapshots
 * stay within a memory budget (but never fewer than minSteps).
 */
export class History {
  constructor(limit = 200, { budget = 100e6, minSteps = 30 } = {}) {
    this.limit = limit;
    this.budget = budget; // about the bytes of JSON all undo steps may hold
    this.minSteps = minSteps;
    this.undoStack = [];
    this.redoStack = [];
    this.undos = 0; // how many steps were undone, for fold()
    this._size = 0;
    this._sinceSize = 0;
  }

  /** Record the state before an edit. */
  push(snapshot, label) {
    this.undoStack.push({ snapshot, label });
    this.redoStack.length = 0;
    let keep = this.limit;
    if (this.budget && this.undoStack.length > this.minSteps) {
      // Measured now and then: one edit's snapshot is about the size of the next.
      if (!this._size || ++this._sinceSize >= 10) {
        this._size = jsonSize(snapshot);
        this._sinceSize = 0;
      }
      if (this._size) keep = Math.min(keep, Math.max(this.minSteps, Math.floor(this.budget / this._size)));
    }
    if (this.undoStack.length > keep) this.undoStack.splice(0, this.undoStack.length - keep);
  }

  /** A bookmark of the current top step, for fold(). */
  mark() {
    return { top: this.undoStack.at(-1) || null, undos: this.undos };
  }

  /**
   * Fold every step recorded since mark into one step labeled label, which
   * restores the state before the first of them. Returns that step, or null
   * when nothing was recorded.
   */
  fold(mark, label) {
    // Find the bookmark by identity: the stack may have dropped old steps at its limit since.
    const at = mark?.top ? this.undoStack.lastIndexOf(mark.top) : -1;
    // Gone because it was undone (not dropped): the steps above it are not the batch's alone.
    if (mark?.top && at < 0 && this.undos !== mark.undos) return null;
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
    this.undos++;
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

function jsonSize(value) {
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return 0;
  }
}
