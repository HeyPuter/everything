/**
 * Page-level undo history. Each entry is a serialized snapshot of the
 * page's editable state plus where the caret was, so undo works the same for
 * typing, moving containers, ink and page settings.
 */
export class History {
  /**
   * limit: most entries kept. budget: most snapshot characters kept, since
   * every entry is a full copy of the page (200 edits of a 1 MB page held
   * 200 MB); the oldest entries go first, but at least `keep` stay.
   */
  constructor(limit = 200, { budget = 32e6, keep = 10 } = {}) {
    this.limit = limit;
    this.budget = budget;
    this.keep = keep;
    this.stack = [];
    this.index = -1;
  }

  reset(snapshot, caret = null) {
    this.stack = [{ snapshot, caret }];
    this.index = 0;
  }

  /** Records a new state; returns false when nothing changed. */
  push(snapshot, caret = null) {
    const current = this.stack[this.index];
    if (current && sameSnapshot(current.snapshot, snapshot)) {
      current.caret = caret;
      return false;
    }
    // Ink rarely changes while typing: share the previous entry's copy
    // instead of keeping one per entry (it can be megabytes).
    if (current && typeof snapshot === 'object' && current.snapshot?.ink === snapshot.ink) snapshot = { ...snapshot, ink: current.snapshot.ink };
    this.stack.length = this.index + 1;
    this.stack.push({ snapshot, caret });
    while (this.stack.length > this.limit || (this.stack.length > this.keep && this.size() > this.budget)) this.stack.shift();
    this.index = this.stack.length - 1;
    return true;
  }

  /** Characters held by the snapshots; ink shared with the entry before is held once. */
  size() {
    let size = 0;
    this.stack.forEach((e, i) => {
      const s = e.snapshot;
      if (typeof s === 'string') size += s.length;
      else size += s.doc.length + (s.ink === this.stack[i - 1]?.snapshot.ink ? 0 : s.ink.length);
    });
    return size;
  }

  canUndo() {
    return this.index > 0;
  }

  canRedo() {
    return this.index < this.stack.length - 1;
  }

  /** Returns the entry to restore and the caret to put back. */
  undo() {
    if (!this.canUndo()) return null;
    const leaving = this.stack[this.index];
    this.index--;
    return { ...this.stack[this.index], caret: leaving.caretBefore ?? this.stack[this.index].caret };
  }

  redo() {
    if (!this.canRedo()) return null;
    this.index++;
    return this.stack[this.index];
  }
}

function sameSnapshot(a, b) {
  if (a === b) return true;
  return typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && a.doc === b.doc && a.ink === b.ink;
}

/** The parts of a page that undo restores: page text and settings, and ink, kept apart. */
export function snapshotOf(page) {
  return {
    doc: JSON.stringify({ title: page.title, outlines: page.outlines, color: page.color, rules: page.rules, ruleColor: page.ruleColor }),
    ink: JSON.stringify(page.ink),
  };
}

export function applySnapshot(page, snapshot) {
  const s = JSON.parse(snapshot.doc);
  page.title = s.title;
  page.outlines = s.outlines;
  page.ink = JSON.parse(snapshot.ink);
  page.color = s.color;
  page.rules = s.rules;
  page.ruleColor = s.ruleColor;
}
