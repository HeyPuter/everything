/**
 * Outline editing: the document as headings and body text, and the structural commands of an outline
 * view and the Navigation pane. A paragraph's outline level comes from its resolved paragraph
 * properties (w:outlineLvl, §17.3.1.20, directly or through its style); levels 1–9 are headings and
 * 10 is body text. Commands change the real document through the model, as one undoable step each:
 * promoting and demoting apply the built-in heading styles where the document has them (otherwise a
 * direct outline level), and moving a heading moves the paragraphs it heads.
 */
import { paragraph, paragraphText } from './model.js';
import { resolveStyledParagraph, effectiveStyleId } from './styles.js';
import { builtinOutlineLevel } from './outline.js';

export const BODY_LEVEL = 10;

/** The outline level of a paragraph: 1–9 for headings, 10 for body text (table text is body text). */
export function outlineLevelOf(p) {
  if (!p || p.cellId) return BODY_LEVEL;
  const level = p.format?.outlineLevel;
  return Number.isInteger(level) && level >= 0 && level < 9 ? level + 1 : BODY_LEVEL;
}

/**
 * The document's outline units: a top-level paragraph, or a whole table (its consecutive cell
 * paragraphs). [{ from, to, level, id, table }] with paragraph indices [from, to).
 */
export function outlineUnits(paragraphs) {
  const units = [];
  for (let i = 0; i < paragraphs.length;) {
    const p = paragraphs[i];
    if (p.cellId) {
      let j = i; while (j < paragraphs.length && paragraphs[j].cellId) j++;
      units.push({ from: i, to: j, level: BODY_LEVEL, id: p.id, table: true }); i = j;
    } else { units.push({ from: i, to: i + 1, level: outlineLevelOf(p), id: p.id, table: false }); i++; }
  }
  // The document's closing empty paragraph belongs to no section: moving a section never takes it along.
  const last = units.at(-1);
  if (units.length > 1 && !last.table && !paragraphText(paragraphs[last.from]).length && !paragraphs[last.from].sectionEnd) last.final = true;
  return units;
}

/** The rows an outline view shows: each unit with its text, its level and whether it heads others. */
export function outlineRows(paragraphs) {
  const units = outlineUnits(paragraphs);
  let offset = 0;
  const starts = paragraphs.map(p => { const start = offset; offset += paragraphText(p).length + 1; return start; });
  return units.map((unit, index) => {
    const next = units[index + 1];
    const p = paragraphs[unit.from], last = paragraphs[unit.to - 1];
    return { ...unit, start: starts[unit.from], end: starts[unit.to - 1] + paragraphText(last).length,
      text: unit.table ? '' : paragraphText(p), paragraph: p,
      parent: unit.level < BODY_LEVEL && !!next && next.level > unit.level };
  });
}

/** The unit index holding paragraph `id`, or -1. */
const unitOf = (units, id) => units.findIndex(u => u.id === id);

/** The units a heading leads: itself and everything until the next heading at its level or above. */
export function subtreeEnd(units, index) {
  const level = units[index].level;
  if (level >= BODY_LEVEL) return index + 1;
  let end = index + 1;
  while (end < units.length && units[end].level > level && !units[end].final) end++;
  return end;
}

/**
 * The two ends of every range that can run between paragraphs (bookmarks, comments, editable regions and
 * fields): [{ start, end, field }] with the paragraphs holding each end.
 */
function rangeEnds(paragraphs) {
  const ends = new Map();
  const note = (key, edge, p, field) => { if (!ends.has(key)) ends.set(key, { field }); ends.get(key)[edge] = p; };
  for (const p of paragraphs) {
    for (const m of p.bookmarks || []) if (m.edge === 'start' || m.edge === 'end') note(`b:${m.id}`, m.edge, p, false);
    for (const m of p.fieldMarkers || []) if (m.field) note(`f:${m.field.id}`, m.type === 'start' ? 'start' : 'end', p, true);
  }
  return [...ends.values()];
}

const movable = p => !p.sectionEnd && !p.blockControls?.length && !p.frame && !p.frameProperties;
function checkMovable(paragraphs) {
  if (!paragraphs.every(movable)) throw new Error('Content with section breaks, frames or block controls cannot be moved in the outline yet.');
}

/**
 * Move units [first, end) so they start before unit `target` (units.length: the end of the
 * document). Returns true when the document changed. The document's final empty paragraph stays last.
 */
function moveUnits(model, units, first, end, target) {
  if (target >= first && target <= end) return false;
  const from = units[first].from, to = units[end - 1].to;
  const paragraphs = model.paragraphs;
  const moving = paragraphs.slice(from, to);
  checkMovable(moving);
  let at = target < units.length ? units[target].from : paragraphs.length;
  const last = paragraphs.at(-1);
  if (at === paragraphs.length && !last.cellId && !paragraphText(last).length && to !== paragraphs.length) at = paragraphs.length - 1;
  if (at >= from && at <= to) return false;
  // A reorder is not a change Track Changes can show here; done untracked, reviewers would never see it.
  if (model.trackChanges) throw new Error('Moving text in the outline cannot be tracked. Turn off Track Changes to move it.');
  // A range from the moved text into the text it passes would end before it starts: the document could not be saved.
  const inside = new Set(moving), passed = new Set(at < from ? paragraphs.slice(at, from) : paragraphs.slice(to, at));
  if (rangeEnds(paragraphs).some(({ start, end }) => start && end && (inside.has(start) && passed.has(end) || inside.has(end) && passed.has(start)))) {
    throw new Error('A bookmark, comment or field runs from this text into the text it would move past, so it cannot be moved.');
  }
  // The caret keeps its place in the text it was in.
  const [anchor, focus] = [model.selection.anchor, model.selection.focus];
  const before = model.paragraphOffset(from), length = model.paragraphOffset(to) - before;
  const within = value => value >= before && value < before + length;
  model.checkpoint();
  const rest = [...paragraphs.slice(0, from), ...paragraphs.slice(to)];
  const insertAt = at > from ? at - (to - from) : at;
  rest.splice(insertAt, 0, ...moving);
  model.paragraphs = rest;
  model.didChange();
  const moved = model.paragraphOffset(insertAt);
  const map = value => within(value) ? moved + value - before : value;
  if (within(anchor) || within(focus)) model.select(map(anchor), map(focus));
  else model.select(Math.min(anchor, model.text.length), Math.min(focus, model.text.length));
  return true;
}

/**
 * Move Up / Move Down: the unit holding `id` moves past its neighbour, taking its subtree when
 * `withSubtree` (a heading moved from the Navigation pane or collapsed in the outline). A heading
 * passes a whole sibling section; other units pass one unit.
 */
export function moveOutlineBlock(model, id, direction, { withSubtree = true } = {}) {
  const units = outlineUnits(model.paragraphs), index = unitOf(units, id);
  if (index < 0) return false;
  const end = withSubtree ? subtreeEnd(units, index) : index + 1;
  if (direction < 0) {
    if (index === 0) return false;
    // Pass the previous sibling's whole section, or the single unit just above.
    let target = index - 1;
    if (withSubtree && units[index].level < BODY_LEVEL) {
      let sibling = index - 1;
      while (sibling > 0 && units[sibling].level > units[index].level) sibling--;
      if (units[sibling].level === units[index].level) target = sibling;
    }
    return moveUnits(model, units, index, end, target);
  }
  if (end >= units.length) return false;
  const next = withSubtree && units[end].level <= units[index].level && units[end].level < BODY_LEVEL ? subtreeEnd(units, end) : end + 1;
  return moveUnits(model, units, index, end, next);
}

/** Drag and drop in the Navigation pane: the section headed by `id` goes before (or after the section of) `targetId`. */
export function moveOutlineSection(model, id, targetId, placement = 'before') {
  const units = outlineUnits(model.paragraphs), index = unitOf(units, id), target = unitOf(units, targetId);
  if (index < 0 || target < 0) return false;
  const end = subtreeEnd(units, index);
  if (target >= index && target < end) return false;
  const at = placement === 'after' ? subtreeEnd(units, target) : target;
  return moveUnits(model, units, index, end, at);
}

/** The paragraph style the document uses for heading `level` (1–9), or for body text (10). */
export function styleForOutlineLevel(styles, level) {
  const definitions = Object.values(styles?.definitions || {}).filter(s => s.type === 'paragraph' && !s.error);
  if (level >= BODY_LEVEL) return definitions.find(s => s.id === styles.defaultParagraph) || definitions.find(s => s.id === 'Normal' || String(s.name).toLowerCase() === 'normal') || null;
  return definitions.find(s => s.id === `Heading${level}`) || definitions.find(s => String(s.name).toLowerCase() === `heading ${level}`) || null;
}

const hasDirectLevel = p => Object.hasOwn(p.formatOverrides || {}, 'outlineLevel') || Object.hasOwn(p.styleContext?.properties || {}, 'outlineLevel') || !p.styleContext && Object.hasOwn(p.format || {}, 'outlineLevel');

/** Give one paragraph an outline level through its style, or a direct level when the document has no such style. */
function applyLevel(model, p, level) {
  if (outlineLevelOf(p) === level) return;
  const start = model.paragraphOffset(model.paragraphs.indexOf(p));
  model.select(start, start + paragraphText(p).length);
  const style = styleForOutlineLevel(model.styles, level);
  if (style && (level < BODY_LEVEL || builtinOutlineLevel(effectiveStyleId(p, model.styles)) !== null)) model.setParagraphStyle(style.id);
  // A direct level would outrank the style just applied: the style decides from now on.
  if (style && hasDirectLevel(p)) model.setOutlineLevel(null);
  if (outlineLevelOf(p) === level) return;
  // No heading style for this level (or the body style carries a level): set the level directly.
  if (builtinOutlineLevel(effectiveStyleId(p, model.styles)) !== null) {
    const normal = styleForOutlineLevel(model.styles, BODY_LEVEL);
    model.setParagraphStyle(normal?.id || null);
  }
  if (outlineLevelOf(p) !== level) model.setParagraphFormat({ outlineLevel: level - 1 });
}

/**
 * Set the outline level of paragraphs: `level(current, unitIndex, units, paragraph)` gives each one's new level (1–10).
 * With `withSubtree`, the paragraphs each heading leads shift by the same number of levels.
 */
export function setOutlineLevels(model, ids, level, { withSubtree = false } = {}) {
  const units = outlineUnits(model.paragraphs);
  const targets = new Map();
  for (const id of ids) {
    const index = unitOf(units, id);
    if (index < 0 || units[index].table) continue;
    const unit = units[index], p = model.paragraphs[unit.from], current = unit.level;
    const next = Math.max(1, Math.min(BODY_LEVEL, level(current, index, units, p)));
    targets.set(p, next);
    if (withSubtree && current < BODY_LEVEL) {
      const shift = next - current;
      for (let i = index + 1; i < subtreeEnd(units, index); i++) {
        const child = units[i];
        if (child.table || child.level >= BODY_LEVEL || targets.has(model.paragraphs[child.from])) continue;
        targets.set(model.paragraphs[child.from], Math.max(1, Math.min(9, child.level + shift)));
      }
    }
  }
  const changes = [...targets].filter(([p, next]) => outlineLevelOf(p) !== next);
  if (!changes.length) return false;
  const [anchor, focus] = [model.selection.anchor, model.selection.focus];
  for (const [p, next] of changes) applyLevel(model, p, next);
  model.select(anchor, focus);
  return true;
}

/** The level a promoted paragraph takes: one level up; body text joins the level of the heading above it. */
export function promotedLevel(current, index, units) {
  if (current < BODY_LEVEL) return Math.max(1, current - 1);
  for (let i = index - 1; i >= 0; i--) if (units[i].level < BODY_LEVEL) return units[i].level;
  return 1;
}
export const demotedLevel = current => current < BODY_LEVEL ? Math.min(9, current + 1) : BODY_LEVEL;

/** Delete the section a heading leads (the heading and its subtree) from the Navigation pane. */
export function deleteOutlineSection(model, id) {
  const units = outlineUnits(model.paragraphs), index = unitOf(units, id);
  if (index < 0) return false;
  const end = subtreeEnd(units, index), from = units[index].from, to = units[end - 1].to;
  const paragraphs = model.paragraphs, removed = new Set(paragraphs.slice(from, to));
  checkMovable([...removed]);
  // With Track Changes on, the section is marked deleted, for reviewers to accept or reject.
  if (model.trackChanges) {
    const start = model.paragraphOffset(from);
    if (to < paragraphs.length) model.select(start, model.paragraphOffset(to));
    else model.select(from ? start - 1 : 0, model.text.length);
    if (!model.replace('')) return false;
    model.select(start);
    return true;
  }
  // As deleting the text would: bookmarks and comments in the section stay, where it was, so a range
  // running out of it keeps both ends and no comment is left without an anchor. A field cannot lose one end.
  if (rangeEnds(paragraphs).some(r => r.field && r.start && r.end && removed.has(r.start) !== removed.has(r.end))) throw new Error('A field runs from this section into the text around it, so the section cannot be deleted here. Select the text and delete it instead.');
  model.checkpoint();
  const rest = [...paragraphs.slice(0, from), ...paragraphs.slice(to)];
  const keep = rest.length ? rest : [resolveStyledParagraph(paragraph(), model.styles, model.numbering)];
  const hostIndex = Math.min(from, keep.length - 1), hostAt = from < keep.length ? 0 : paragraphText(keep[hostIndex]).length;
  const kept = [...removed].flatMap(p => (p.bookmarks || []).map(marker => ({ ...marker, offset: hostAt })));
  if (kept.length) keep[hostIndex] = { ...keep[hostIndex], bookmarks: [...(keep[hostIndex].bookmarks || []), ...kept] };
  model.paragraphs = keep;
  model.didChange();
  model.select(model.paragraphOffset(Math.min(from, keep.length - 1)));
  return true;
}

/** A new, empty heading at `level`, before the heading `id` or after the section it leads. The caret goes into it. */
export function insertOutlineHeading(model, id, placement = 'after', level = null) {
  const units = outlineUnits(model.paragraphs), index = unitOf(units, id);
  if (index < 0) return false;
  const target = level ?? (units[index].level < BODY_LEVEL ? units[index].level : 1);
  const at = placement === 'before' ? units[index].from : units[subtreeEnd(units, index) - 1].to;
  const style = styleForOutlineLevel(model.styles, target);
  const fresh = resolveStyledParagraph(paragraph('', style ? { styleId: style.id, styleChanged: true } : {}), model.styles, model.numbering);
  if (outlineLevelOf(fresh) !== target && target < BODY_LEVEL) {
    fresh.format = { ...fresh.format, outlineLevel: target - 1 };
    fresh.formatOverrides = { ...fresh.formatOverrides, outlineLevel: target - 1 };
  }
  model.checkpoint();
  model.paragraphs = [...model.paragraphs.slice(0, at), fresh, ...model.paragraphs.slice(at)];
  model.didChange();
  model.select(model.paragraphOffset(at));
  return true;
}
