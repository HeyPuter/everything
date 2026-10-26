// Measuring body paragraphs is nearly all of a layout's work, and an edit changes only a few of
// them. A measurer can carry this cache of measured paragraphs from earlier layouts. An entry is
// keyed by every input measurement reads besides the measurer: the paragraph's content, its page
// geometry, list label, numbering, revision view and boundary rule. Results do not depend on
// where the paragraph starts, apart from the document offsets they carry, so a paragraph that
// only moved (text was typed before it) is reused with its offsets shifted. Measured paragraphs
// are read-only (readOnlyMeasurement), so every layout and pagination pass shares the remembered
// one; a moved paragraph is copied once, at its new offsets. The measurer's owner replaces the
// cache when its measurements can change (fonts loaded or replaced).

// Fields of measured lines and their parts that hold document offsets. Caret stops (including
// those of reordered bidi fragments and their shaping positions) carry theirs as `offset`;
// elsewhere `offset` is a distance, such as an underline's position below the baseline.
const OFFSET_KEYS = new Set(['start', 'end', 'trailingStart', 'drawingSegmentStart']);
const STOP_LISTS = new Set(['stops', 'caretStops', 'textOffsets']);

// Where a measured paragraph holds document offsets (null where a part holds none), worked out once
// for each remembered paragraph. A long document moves most of its paragraphs on every keystroke:
// a moved paragraph copies only the parts its plan names, and shares the rest (measurements are
// read-only). Plans of the same shape are one object, so a list of alike parts (caret stops,
// fragments) has one plan for every item.
const plans = new Map();
let uniquePlans = 0;
const canonicalPlan = plan => {
  // A plan holding a list of unlike parts is that paragraph's own; only shared shapes are kept.
  if (plan.sig.includes('#')) return plan;
  let found = plans.get(plan.sig);
  if (!found) plans.set(plan.sig, found = plan);
  return found;
};
function offsetPlan(value, list) {
  if (Array.isArray(value)) {
    let items = null, first, same = true;
    for (let i = 0; i < value.length; i++) {
      const item = value[i], plan = item && typeof item === 'object' ? offsetPlan(item, list) : null;
      if (plan) (items ||= new Array(value.length).fill(null))[i] = plan;
      if (i === 0) first = plan; else if (plan !== first) same = false;
    }
    if (!items) return null;
    return same ? canonicalPlan({ each: first, sig: `[${first.sig}]` }) : { items, sig: `#${uniquePlans++}` };
  }
  const stops = STOP_LISTS.has(list);
  let keys = null, children = null;
  for (const key in value) {
    // A picture is the document's own object, not a measured part.
    if (key === 'image') continue;
    const item = value[key];
    if (typeof item === 'number') { if (OFFSET_KEYS.has(key) || stops && key === 'offset') (keys ||= []).push(key); }
    else if (item && typeof item === 'object') { const plan = offsetPlan(item, key); if (plan) (children ||= []).push([key, plan]); }
  }
  if (!keys && !children) return null;
  keys ||= []; children ||= [];
  return canonicalPlan({ keys, children, sig: `{${keys.join(',')}|${children.map(([key, plan]) => `${key}:${plan.sig}`).join(',')}}` });
}
function shifted(value, plan, delta) {
  if (Array.isArray(value)) {
    const copy = value.slice();
    if (plan.each) { for (let i = 0; i < copy.length; i++) if (copy[i] && typeof copy[i] === 'object') copy[i] = shifted(copy[i], plan.each, delta); }
    else for (let i = 0; i < copy.length; i++) if (plan.items[i]) copy[i] = shifted(copy[i], plan.items[i], delta);
    return copy;
  }
  const copy = { ...value };
  for (const key of plan.keys) copy[key] += delta;
  for (const [key, child] of plan.children) copy[key] = shifted(value[key], child, delta);
  return copy;
}

// Where a measured paragraph holds its pictures, worked out once for each remembered paragraph from
// the pictures it was measured with. The pictures are the document's own objects, which an edit
// elsewhere (Undo, for one) can replace with equal copies; the measurement stays the same, and a
// reused one is copied along this plan to hold the paragraph's current pictures. null where none.
function picturePlan(value, pictures) {
  if (Array.isArray(value)) {
    let items = null;
    for (let i = 0; i < value.length; i++) {
      const item = value[i], plan = item && typeof item === 'object' ? picturePlan(item, pictures) : null;
      if (plan) (items ||= []).push([i, plan]);
    }
    return items && { items };
  }
  let keys = null, children = null;
  for (const key in value) {
    const item = value[key];
    if (!item || typeof item !== 'object') continue;
    if (pictures.has(item)) (keys ||= []).push([key, pictures.get(item)]);
    else if (key !== 'image') { const plan = picturePlan(item, pictures); if (plan) (children ||= []).push([key, plan]); }
  }
  return keys || children ? { keys: keys || [], children: children || [] } : null;
}
function withPictures(value, plan, pictures) {
  const copy = Array.isArray(value) ? value.slice() : { ...value };
  if (plan.items) for (const [i, child] of plan.items) copy[i] = withPictures(value[i], child, pictures);
  else {
    for (const [key, index] of plan.keys) copy[key] = pictures[index];
    for (const [key, child] of plan.children) copy[key] = withPictures(value[key], child, pictures);
  }
  return copy;
}
const samePictures = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((picture, i) => picture === b[i]));

// Development and test builds freeze measured paragraphs, so a layout stage that changes one
// in place fails loudly instead of corrupting the paragraphs every later layout shares. Pictures
// are the document's own objects, which editing changes; they stay as they are.
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key in value) if (key !== 'image') freeze(value[key]);
}
/** A measured paragraph, which later layout stages read but never change (they copy what they adjust). */
export function readOnlyMeasurement(measured) {
  if (import.meta.env?.DEV) freeze(measured);
  return measured;
}

// What pagination reads of a measured block: everything but its document offsets (an empty line,
// whose start is its end, breaks pages differently) and, for body text, the horizontal detail of
// its lines, which typing changes without moving any line. Table cells keep their fragments, which
// clip a cell's content.
const FLOW_OFFSETS = new Set([...OFFSET_KEYS, ...STOP_LISTS]);
const FLOW_HORIZONTAL = new Set(['fragments', 'underlines', 'strikes', 'backgrounds', 'leaders', 'x', 'width', 'contentWidth', 'ignoredTrailingWidth', 'ignoredTabWidth', 'justificationSpacing']);
function flowJson(measured, horizontal) {
  return JSON.stringify(measured, function (key, value) {
    // A cell's source content is the document's (with its offsets); its measured blocks follow.
    if (FLOW_OFFSETS.has(key) || key === 'content' && Array.isArray(this.blocks)) return undefined;
    const line = Array.isArray(this.stops);
    if (horizontal && line && FLOW_HORIZONTAL.has(key)) return undefined;
    if (value && typeof value === 'object' && Array.isArray(value.stops) && typeof value.start === 'number' && !('empty' in value)) return { ...value, empty: value.start === value.end };
    return value;
  });
}

export class ParagraphMeasureCache {
  constructor(limit = 10000) { this.limit = limit; this.entries = new Map(); this.generation = 0; this.names = new Map(); this.nextName = 0; this.flowNames = new WeakMap(); this.flows = new Map(); this.stories = new Map(); this.cells = new Map(); }
  /** A page story measured earlier with the same inputs (page-story-measure.js), or undefined. */
  story(key) {
    const entry = this.stories.get(key);
    if (!entry) return undefined;
    entry.used = this.generation;
    return entry.value;
  }
  rememberStory(key, value) { this.stories.set(key, { value, used: this.generation }); }
  /**
   * A table cell's AutoFit content widths for `key` (layout.js names the cell's properties, borders,
   * paragraphs and list labels), computing them with `compute()` when no earlier layout did. Typing
   * elsewhere leaves every cell of a long AutoFit table as it was; measuring them all again took
   * most of each keystroke.
   */
  cellWidths(key, compute) {
    let entry = this.cells.get(key);
    if (!entry) this.cells.set(key, entry = { value: compute() });
    entry.used = this.generation;
    return entry.value;
  }
  /**
   * A short name for what pagination reads of measured blocks (a body paragraph's measurement
   * or a table's rows): equal names paginate alike wherever their text and offsets differ.
   */
  flowName(blocks, table = false) {
    if (table) return this.intern(flowJson(blocks, false));
    let name = this.flowNames.get(blocks);
    if (!name) this.flowNames.set(blocks, name = this.#name(flowJson(blocks, true)));
    else {
      // Still in use: keep it, so a paragraph measured again alike gets the same name.
      name.used = this.generation;
      if (!this.names.has(name.text)) this.names.set(name.text, name);
    }
    return name.id;
  }
  /**
   * A short name for a long key part (page geometry, numbering, what pagination reads), the same
   * while layouts keep using it. A name is never given to other text, even once forgotten.
   */
  intern(text) { return this.#name(text).id; }
  #name(text) {
    let name = this.names.get(text);
    if (!name) this.names.set(text, name = { id: this.nextName++, text, used: 0 });
    name.used = this.generation;
    return name;
  }
  /**
   * The owner starts a new layout of its document: forget the paragraphs that none of the last
   * few layouts used (versions replaced by edits), so memory follows the document's size.
   */
  nextGeneration(keep = 4) {
    this.generation++;
    for (const [key, entry] of this.entries) if (entry.used < this.generation - keep) this.entries.delete(key);
    for (const [text, name] of this.names) if (name.used < this.generation - keep) this.names.delete(text);
    for (const [key, entry] of this.stories) if (entry.used < this.generation - keep) this.stories.delete(key);
    for (const [key, entry] of this.cells) if (entry.used < this.generation - keep) this.cells.delete(key);
  }
  /**
   * The measured paragraph for `key` at document `offset`, measuring it with `measure()` on a miss.
   * `pictures` lists the paragraph's pictures in order (null when it has none): a reused measurement
   * holds these very objects, however equal earlier ones were.
   */
  measure(key, offset, measure, pictures = null) {
    const entry = this.entries.get(key);
    if (entry) {
      // Most recently used entries stay; the oldest go first if the cache is ever full.
      this.entries.delete(key); this.entries.set(key, entry); entry.used = this.generation;
      if (entry.offset !== offset || !samePictures(entry.pictures, pictures)) {
        // Moved copies are made from the paragraph as first measured, along its offset plan.
        if (entry.plan === undefined) entry.plan = offsetPlan(entry.base);
        let moved = entry.plan && offset !== entry.baseOffset ? shifted(entry.base, entry.plan, offset - entry.baseOffset) : entry.base;
        if (!samePictures(entry.basePictures, pictures)) {
          if (entry.picturePlan === undefined) entry.picturePlan = picturePlan(entry.base, new Map(entry.basePictures.map((picture, i) => [picture, i])));
          if (entry.picturePlan) moved = withPictures(moved, entry.picturePlan, pictures);
        }
        if (moved !== entry.base) readOnlyMeasurement(moved);
        const name = this.flowNames.get(entry.base);
        if (name) this.flowNames.set(moved, name);
        entry.measured = moved; entry.offset = offset; entry.pictures = pictures;
      }
      return entry.measured;
    }
    const measured = readOnlyMeasurement(measure());
    this.entries.set(key, { offset, measured, base: measured, baseOffset: offset, plan: undefined, pictures, basePictures: pictures, picturePlan: undefined, used: this.generation });
    // Past the limit the least recently used entry goes, unless this layout used it too: a document with
    // more paragraphs than the limit would otherwise evict each before its next use, and every keystroke
    // would measure the whole document again. nextGeneration() still forgets what layouts stop using.
    if (this.entries.size > this.limit) {
      const [oldest, entry] = this.entries.entries().next().value;
      if (entry.used < this.generation) this.entries.delete(oldest);
    }
    return measured;
  }
  clear() { this.entries.clear(); this.names.clear(); this.flowNames = new WeakMap(); this.flows.clear(); this.stories.clear(); this.cells.clear(); }
}
