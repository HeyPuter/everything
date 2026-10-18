// Measuring body paragraphs is nearly all of a layout's work, and an edit changes only a few of
// them. A measurer can carry this cache of measured paragraphs from earlier layouts. An entry is
// keyed by every input measurement reads besides the measurer: the paragraph's content, its page
// geometry, list label, numbering, revision view and boundary rule. Results do not depend on
// where the paragraph starts, apart from the document offsets they carry, so a paragraph that
// only moved (text was typed before it) is reused with its offsets shifted. Each use gets its own
// copy, so later layout stages may annotate it. The measurer's owner replaces the cache when its
// measurements can change (fonts loaded or replaced).

// Fields of measured lines and their parts that hold document offsets. Caret stops (including
// those of reordered bidi fragments and their shaping positions) carry theirs as `offset`;
// elsewhere `offset` is a distance, such as an underline's position below the baseline.
const OFFSET_KEYS = new Set(['start', 'end', 'trailingStart', 'drawingSegmentStart']);
const STOP_LISTS = new Set(['stops', 'caretStops', 'textOffsets']);

function shifted(value, delta, list) {
  if (Array.isArray(value)) return value.map(item => shifted(item, delta, list));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const key in value) {
    const item = value[key];
    copy[key] = typeof item === 'number' ? OFFSET_KEYS.has(key) || key === 'offset' && STOP_LISTS.has(list) ? item + delta : item : shifted(item, delta, key);
  }
  return copy;
}

export class ParagraphMeasureCache {
  constructor(limit = 10000) { this.limit = limit; this.entries = new Map(); this.generation = 0; }
  /**
   * The owner starts a new layout of its document: forget the paragraphs that none of the last
   * few layouts used (versions replaced by edits), so memory follows the document's size.
   */
  nextGeneration(keep = 4) {
    this.generation++;
    for (const [key, entry] of this.entries) if (entry.used < this.generation - keep) this.entries.delete(key);
  }
  /** The measured paragraph for `key` at document `offset`, measuring it with `measure()` on a miss. */
  measure(key, offset, measure) {
    const entry = this.entries.get(key);
    if (entry) {
      // Most recently used entries stay; the oldest go first if the cache is ever full.
      this.entries.delete(key); this.entries.set(key, entry); entry.used = this.generation;
      return shifted(entry.measured, offset - entry.offset);
    }
    const measured = measure();
    this.entries.set(key, { offset, measured: shifted(measured, 0), used: this.generation });
    // Past the limit the least recently used entry goes, unless this layout used it too: a document with
    // more paragraphs than the limit would otherwise evict each before its next use, and every keystroke
    // would measure the whole document again. nextGeneration() still forgets what layouts stop using.
    if (this.entries.size > this.limit) {
      const [oldest, entry] = this.entries.entries().next().value;
      if (entry.used < this.generation) this.entries.delete(oldest);
    }
    return measured;
  }
  clear() { this.entries.clear(); }
}
