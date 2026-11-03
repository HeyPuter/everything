// Undo keeps an exact copy of the document from before each command (StorySession.snapshot). A
// keystroke changes a paragraph or two, but copying all of a long document took most of a keystroke's
// time whenever keys came faster than the browser went idle. After a keystroke, the copy for the next
// one is made from the copy this one started from: the paragraphs the keystroke replaced are copied
// again, and every other paragraph keeps its copy (copies are never changed, so undo steps can share
// them).
//
// A paragraph kept by identity is taken to be unchanged, which holds for what typing does: an edit
// replaces the paragraphs it changes with new objects. The paragraphs a keystroke reaches (the caret's
// and its neighbours) are compared with their copies all the same, since some keys change a paragraph
// in place (Backspace at a list item's start takes its numbering away). Development builds compare
// every copy with the document before it is used (StorySession.snapshot).
//
// structuredClone keeps objects that two paragraphs share shared in the copy, as a field whose start and
// end are in different paragraphs is. A paragraph copied alone would lose that, so ParagraphOwners
// remembers which paragraph holds each object; a keystroke whose paragraphs share anything with others
// is copied whole.

const SHARED = Symbol('shared');
const plain = value => {
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype;
};

/**
 * Whether `copy` (made by structuredClone of `value` earlier) is what structuredClone(value) would give
 * now: the same keys in the same order, the same values, and the same objects shared within it. Anything
 * but plain objects and arrays counts as changed.
 */
export function sameAsCopy(value, copy, seen = new Map(), copies = new Set()) {
  if (typeof value !== 'object' || value === null || typeof copy !== 'object' || copy === null) return Object.is(value, copy);
  const known = seen.get(value);
  if (known !== undefined) return known === copy;
  if (value === copy || copies.has(copy) || !plain(value) || !plain(copy) || Array.isArray(value) !== Array.isArray(copy)) return false;
  if (Array.isArray(value) && value.length !== copy.length) return false;
  seen.set(value, copy); copies.add(copy);
  const keys = Object.keys(value), copyKeys = Object.keys(copy);
  if (keys.length !== copyKeys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key !== copyKeys[i] || !sameAsCopy(value[key], copy[key], seen, copies)) return false;
  }
  return true;
}

/** Which paragraph holds each object of a document's paragraphs, or SHARED for one more than one holds. */
export class ParagraphOwners {
  constructor(paragraphs) {
    this.owners = new WeakMap();
    this.live = new Set(paragraphs);
    // Contents a walk cannot see (anything but plain objects and arrays) could be shared unseen.
    this.opaque = false;
    for (const p of paragraphs) this.hold(p, p);
  }
  /** Records `paragraph` as holding `value`. Whatever two paragraphs hold is shared, and so is all it holds. */
  hold(value, paragraph) {
    const owner = this.owners.get(value);
    if (owner === paragraph || owner === SHARED) return;
    this.owners.set(value, owner === undefined ? paragraph : SHARED);
    if (!plain(value)) { this.opaque = true; return; }
    const values = Object.values(value);
    for (let i = 0; i < values.length; i++) if (typeof values[i] === 'object' && values[i] !== null) this.hold(values[i], paragraph);
  }
  /**
   * Records `paragraph`, which replaced others, as holding `value`, walking all of it again (`visited`).
   * Returns whether it holds nothing another paragraph does, besides the others in `this.adding`.
   */
  claim(value, paragraph, visited) {
    if (typeof value !== 'object' || value === null || visited.has(value)) return true;
    visited.add(value);
    const owner = this.owners.get(value);
    let alone = true;
    // An object of a paragraph no longer in the document is free to be another's.
    if (owner === undefined || owner === paragraph || owner !== SHARED && !this.live.has(owner)) this.owners.set(value, paragraph);
    else {
      this.owners.set(value, SHARED);
      alone = owner !== SHARED && this.adding.has(owner);
    }
    if (!plain(value)) { this.opaque = true; return false; }
    for (const item of Object.values(value)) if (!this.claim(item, paragraph, visited)) alone = false;
    return alone;
  }
  /**
   * The paragraphs `added` replaced `removed`. Records what they hold, and returns whether they share
   * nothing with the document's other paragraphs.
   */
  replace(removed, added) {
    for (const p of removed) this.live.delete(p);
    for (const p of added) this.live.add(p);
    this.adding = new Set(added);
    let alone = true;
    try { for (const p of added) if (!this.claim(p, p, new Set())) alone = false; }
    finally { this.adding = null; }
    return alone && !this.opaque;
  }
}

/**
 * The document copy after a keystroke, from `before`: the live paragraphs when it started (`live`), the copy
 * it started from (`copy`, the parts of model.documentSnapshot()), and the paragraphs it could change in
 * place (`reach`, the first and last indexes into `live`). `paragraphs` are the document's paragraphs now,
 * and `caret` the index of the caret's paragraph among them: those beside it are compared too. Returns null
 * when the paragraphs it changed share objects with others (copy the document whole then); `owners`
 * describes `live` and is brought up to date either way.
 */
export function copyAfterTyping(before, paragraphs, caret, owners) {
  const { live, copy, reach } = before, copies = copy.paragraphs;
  const was = live.length, now = paragraphs.length, shorter = Math.min(was, now);
  let start = 0, tail = 0;
  while (start < shorter && paragraphs[start] === live[start]) start++;
  while (tail < shorter - start && paragraphs[now - 1 - tail] === live[was - 1 - tail]) tail++;
  // The caret's paragraph and its neighbours, where it started and where it ended, kept as they were.
  const reached = new Set();
  for (let i = reach[0]; i <= reach[1]; i++) reached.add(i);
  for (let i = caret - 1; i <= caret + 1; i++) reached.add(i < start ? i : i >= now - tail ? i - now + was : -1);
  for (const i of [...reached].sort((a, b) => a - b)) {
    if (i < 0 || i >= was || i >= start && i < was - tail) continue;
    if (sameAsCopy(live[i], copies[i])) continue;
    if (i < start) start = i;
    else tail = Math.min(tail, was - 1 - i);
  }
  const added = paragraphs.slice(start, now - tail);
  if (!owners.replace(live.slice(start, was - tail), added)) return null;
  const fresh = structuredClone(added);
  return {
    comments: copy.comments, tables: copy.tables, styles: copy.styles, stylesEnabled: copy.stylesEnabled,
    numbering: copy.numbering, pageSettings: copy.pageSettings,
    paragraphs: [...copies.slice(0, start), ...fresh, ...copies.slice(was - tail)],
  };
}
