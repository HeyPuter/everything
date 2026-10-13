// Original tracked-change model (ECMA-376 Part 1 §17.13.5). Inserted and
// deleted text stay in the paragraphs as ordinary runs carrying
// `run.revision = { type: 'ins' | 'del', author, date, move? }`; a paragraph mark that
// was inserted or deleted carries `paragraph.markRevision`. Deleted text keeps
// its document positions until the change is accepted, as an all-markup view
// shows it. Moved text is a deletion/insertion pair flagged `move` (moveFrom /
// moveTo, §17.13.5.22/.25) sharing a `moveName`.
//
// A formatting change keeps the formatting it replaced: `run.formatRevision` and
// `paragraph.formatRevision` = { type: 'format', author, date, id?, previous },
// where `previous` holds the run's or paragraph's former formatting fields
// (§17.13.5.31 rPrChange, §17.13.5.29 pPrChange). Rejecting restores them.
const length = p => p.runs.reduce((n, r) => n + r.text.length, 0);

export const REVISION_COLORS = ['B5082E', '2E6EB5', '2F8A3A', '8A3FB0', 'C25E00', '00838F', 'A0306E', '5B6B00'];
export const MOVE_COLOR = '2E7D32';

/** A stable display color per author, as hex without '#'. */
export function revisionColor(author, authors = []) {
  const custom = revisionView.options.authorColors?.[author];
  if (custom) return custom;
  const index = authors.indexOf(author);
  if (index >= 0) return REVISION_COLORS[index % REVISION_COLORS.length];
  let hash = 0;
  for (const ch of String(author || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return REVISION_COLORS[hash % REVISION_COLORS.length];
}

export const sameRevision = (a, b) => !a && !b || !!a && !!b && a.type === b.type && a.author === b.author && a.date === b.date && !!a.move === !!b.move && (a.moveName || '') === (b.moveName || '');

/** Split runs so that a paragraph-local offset falls on a run boundary; returns the run index starting there. */
function splitAt(p, offset) {
  let at = 0;
  for (let i = 0; i < p.runs.length; i++) {
    const run = p.runs[i], end = at + run.text.length;
    if (offset === at) return i;
    if (offset < end) {
      p.runs.splice(i, 1, { ...run, text: run.text.slice(0, offset - at) }, { ...run, text: run.text.slice(offset - at) });
      return i + 1;
    }
    at = end;
  }
  return p.runs.length;
}

/**
 * Visit the run pieces and paragraph marks within [start, end):
 * visit({ paragraph, index, run }) for runs (after splitting at the bounds) and
 * visit({ paragraph, mark: true }) for each separator inside the range.
 */
export function eachRevisionTarget(paragraphs, start, end, visit) {
  let at = 0;
  for (const p of paragraphs) {
    const size = length(p), pStart = at, pEnd = at + size;
    if (pEnd >= start && pStart <= end) {
      const from = Math.max(0, start - pStart), to = Math.min(size, end - pStart);
      if (to > from) {
        const first = splitAt(p, from), last = splitAt(p, to);
        for (let i = first; i < last; i++) visit({ paragraph: p, index: i, run: p.runs[i] });
      }
      if (pEnd >= start && pEnd < end) visit({ paragraph: p, mark: true });
    }
    at = pEnd + 1;
    if (at > end) break;
  }
}

// Formatting revisions stay inside the retained property XML (§17.13.5.30
// rPrChange, §17.13.5.29 pPrChange) until the property is rewritten.
const CHANGE = { run: /<(?:\w+:)?rPrChange\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?rPrChange>)/g, paragraph: /<(?:\w+:)?pPrChange\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?pPrChange>)/g };
function formatChange(xml, kind) {
  if (!xml || !xml.includes(kind === 'run' ? 'rPrChange' : 'pPrChange')) return null;
  const match = xml.match(CHANGE[kind])?.[0];
  if (!match) return null;
  const attr = name => match.match(new RegExp(`\\b(?:\\w+:)?${name}="([^"]*)"`))?.[1] || '';
  return { type: 'format', author: attr('author'), date: attr('date') };
}
const revisionMeta = r => r && { type: 'format', author: r.author || '', date: r.date || '' };
export const runFormatChange = run => revisionMeta(run.formatRevision) || formatChange(run.properties, 'run');
export const paragraphFormatChange = p => revisionMeta(p.formatRevision) || formatChange(p.shell, 'paragraph') || formatChange(p.markProperties, 'run');
/** Drop the recorded formatting change from a run's or paragraph's retained XML (accepting it). */
export function acceptFormatChange(target, kind) {
  delete target.formatRevision;
  if (kind === 'run') { if (target.properties) target.properties = target.properties.replace(CHANGE.run, ''); return; }
  if (target.shell) target.shell = target.shell.replace(CHANGE.paragraph, '');
  if (target.markProperties && CHANGE.run.test(target.markProperties)) { target.markProperties = target.markProperties.replace(CHANGE.run, ''); target.markPropertiesChanged = true; }
  CHANGE.run.lastIndex = 0;
}
/** Restore the formatting a change replaced (rejecting it). Returns false when nothing was recorded. */
export function rejectFormatChange(target) {
  const previous = target.formatRevision?.previous;
  if (!previous) return false;
  for (const key of Object.keys(target)) if (!KEEP.has(key) && !Object.hasOwn(previous, key)) delete target[key];
  Object.assign(target, structuredClone(previous));
  delete target.formatRevision;
  target.formatRejected = true;
  return true;
}
// Fields that are content or annotations, not formatting.
const KEEP = new Set(['id', 'text', 'runs', 'revision', 'formatRevision', 'link', 'contentControl', 'image', 'math', 'field', 'noteMark', 'bodySymbol', 'noBreakHyphen', 'breakClear', 'positionalTab', 'tocHyperlink', 'bookmarks', 'fieldMarkers', 'markRevision', 'cellId', 'tableStyleId', 'tableStyleRegions', 'blockControls', 'sectionEnd', 'sectionProperties', 'sectionSourceIndex', 'markFormat', 'markOverrides', 'markProperties', 'markPropertiesChanged', 'markHasDirectProperties', 'markStyleId', 'markStyleChanged', 'pageStory', 'storySource', 'drawingText']);

/** The formatting fields of a run or paragraph, for a formatting revision's `previous`. */
export function formattingSnapshot(target) {
  const out = {};
  for (const [key, value] of Object.entries(target)) if (!KEEP.has(key) && key !== 'formatRejected') out[key] = structuredClone(value);
  return out;
}

// What counts as a formatting change: the effective (resolved) formatting and style. A
// transaction that edits style definitions is not tracked (see trackFormatChanges).
const SOURCE_FIELDS = new Set(['directFormat', 'overrides', 'properties', 'hasDirectProperties', 'styleManaged', 'styleChanged', 'formatRejected']);
function runKey(run) {
  if (!run) return '';
  const out = {};
  for (const [key, value] of Object.entries(run)) if (!KEEP.has(key) && !SOURCE_FIELDS.has(key)) out[key] = value;
  return JSON.stringify(Object.keys(out).sort().map(key => [key, out[key]]));
}
function paragraphKey(p) {
  if (!p) return '';
  const format = p.format || {};
  return JSON.stringify([p.styleId || null, Object.keys(format).sort().map(key => [key, format[key]]), p.list ? [p.list.numId, p.list.level] : null]);
}
const special = r => r.image || r.math || r.field || r.noteMark || r.bodySymbol || r.noBreakHyphen || r.breakClear || r.contentControl && !r.text;
function mergeRuns(runs) {
  const out = [];
  for (const run of runs) {
    const last = out.at(-1);
    if (last && !special(last) && !special(run) && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...run, text: '' })) last.text += run.text;
    else out.push(run);
  }
  return out;
}

/**
 * Record formatting changes between two states of the same paragraphs (Track Changes on).
 * Paragraphs keep their ids across formatting commands; only paragraphs whose text is
 * unchanged are compared run by run. A change returned to its original formatting
 * drops its revision. `revision()` makes { type: 'format', author, date }.
 */
export function trackFormatChanges(before, after, revision, { stylesChanged = false } = {}) {
  if (stylesChanged) return;
  const old = new Map(before.map(p => [p.id, p]));
  let made = null;
  const stamp = () => (made ||= revision());
  for (const p of after) {
    const source = old.get(p.id);
    if (!source || source === p) continue;
    if (paragraphKey(source) !== paragraphKey(p)) {
      if (!p.formatRevision) p.formatRevision = { ...stamp(), type: 'format', previous: formattingSnapshot(source) };
      else if (Object.hasOwn(p.formatRevision.previous || {}, 'format') && paragraphKey({ ...p, ...p.formatRevision.previous }) === paragraphKey(p)) delete p.formatRevision;
    }
    if (p.runs.map(r => r.text).join('') !== source.runs.map(r => r.text).join('')) continue;
    if (JSON.stringify(p.runs) === JSON.stringify(source.runs)) continue;
    // Cut the new runs where the old ones started, so each piece has one former format.
    const cuts = []; let at = 0;
    for (const run of source.runs) { cuts.push(at); at += run.text.length; }
    const pieces = []; at = 0;
    for (const run of p.runs) {
      const end = at + run.text.length;
      const inner = cuts.filter(c => c > at && c < end && !special(run));
      let from = at;
      for (const cut of [...inner, end]) { if (cut > from || !run.text) pieces.push({ ...run, text: run.text.slice(from - at, cut - at) }); from = cut; }
      at = end;
    }
    let offset = 0, changed = false;
    for (const piece of pieces) {
      let o = 0, former = null;
      for (const run of source.runs) { if (offset >= o && offset < o + run.text.length || !run.text && o === offset) { former = run; break; } o += run.text.length; }
      offset += piece.text.length;
      if (!former || piece.revision?.type === 'ins') continue;
      if (runKey(former) !== runKey(piece)) {
        if (!piece.formatRevision) { piece.formatRevision = former.formatRevision ? structuredClone(former.formatRevision) : { ...stamp(), type: 'format', previous: formattingSnapshot(former) }; changed = true; }
      }
      // Only a change recorded here knows the former resolved formatting to compare with.
      if (Object.hasOwn(piece.formatRevision?.previous || {}, 'fontSize') && runKey({ ...piece, ...piece.formatRevision.previous }) === runKey(piece)) { delete piece.formatRevision; changed = true; }
    }
    if (changed || pieces.length !== p.runs.length) p.runs = mergeRuns(pieces);
  }
}

/** Revised ranges in document order: [{ type, author, date, start, end, mark?, move? }]; adjacent same-revision runs merge. */
export function revisionRanges(paragraphs) {
  const ranges = []; let at = 0;
  const push = (revision, start, end, mark = false) => {
    const last = ranges.at(-1);
    if (last && last.end === start && sameRevision(last, revision)) { last.end = end; if (mark) last.marks = (last.marks || 0) + 1; return; }
    ranges.push({ type: revision.type, author: revision.author, date: revision.date, start, end, ...(revision.move ? { move: true, moveName: revision.moveName || '' } : {}), ...(mark ? { marks: 1 } : {}) });
  };
  for (const p of paragraphs) {
    let offset = at;
    const paragraphChange = paragraphFormatChange(p);
    for (const run of p.runs) {
      if (run.revision && run.text) push(run.revision, offset, offset + run.text.length);
      else if (run.text && !paragraphChange) { const change = runFormatChange(run); if (change) push(change, offset, offset + run.text.length); }
      offset += run.text.length;
    }
    if (p.markRevision) push(p.markRevision, offset, offset + 1, true);
    if (paragraphChange) push(paragraphChange, at, offset + 1, true);
    at = offset + 1;
  }
  // A paragraph's formatting change spans its text, so it sorts before changes inside it.
  return ranges.map((range, index) => [range, index]).sort((a, b) => a[0].start - b[0].start || a[1] - b[1]).map(([range]) => range);
}

export const hasRevisions = paragraphs => paragraphs.some(p => p.markRevision || paragraphFormatChange(p) || p.runs.some(r => r.revision || runFormatChange(r)));

/** The authors who made changes, in first-appearance order. */
export function revisionAuthors(paragraphs) {
  const authors = [];
  for (const range of revisionRanges(paragraphs)) if (!authors.includes(range.author)) authors.push(range.author);
  return authors;
}

const MARKS = {
  underline: color => ({ underline: true, underlineStyle: 'single', underlineColor: color }),
  doubleUnderline: color => ({ underline: true, underlineStyle: 'double', underlineColor: color }),
  strikethrough: () => ({ strikethrough: 'single' }),
  doubleStrikethrough: () => ({ strikethrough: 'double' }),
  bold: () => ({ bold: true }),
  italic: () => ({ italic: true }),
  colorOnly: () => ({}),
  hidden: () => ({ hidden: true }),
};
export const INSERT_MARKS = ['underline', 'doubleUnderline', 'bold', 'italic', 'strikethrough', 'colorOnly'];
export const DELETE_MARKS = ['strikethrough', 'doubleStrikethrough', 'hidden', 'bold', 'italic', 'underline', 'colorOnly'];
export const FORMAT_MARKS = ['none', 'bold', 'italic', 'underline', 'doubleUnderline', 'colorOnly'];

/** Inline display of a revised run for a view: { hidden } or style overrides. */
export function revisionDisplay(revision, view, color) {
  if (!revision || revision.type === 'format') return null;
  const o = revisionView.options;
  if (view === 'original') return revision.type === 'ins' ? { hidden: true } : {};
  // Hidden reviewers and hidden insertions/deletions show as accepted.
  if (view === 'none' || view === 'simple' || !o.showInsDel || o.hiddenAuthors?.includes(revision.author)) return revision.type === 'del' ? { hidden: true } : {};
  if (revision.move && o.trackMoves !== false) {
    const moveColor = o.moveColor || MOVE_COLOR;
    return revision.type === 'ins' ? { color: moveColor, ...MARKS[o.moveToMark || 'doubleUnderline'](moveColor) } : { color: moveColor, ...MARKS[o.moveFromMark || 'doubleStrikethrough'](moveColor) };
  }
  if (revision.type === 'del' && o.balloons === 'balloons') return { hidden: true };
  const fixed = revision.type === 'ins' ? o.insertColor : o.deleteColor;
  const shade = fixed && fixed !== 'author' ? fixed : color;
  return revision.type === 'ins' ? { color: shade, ...MARKS[o.insertMark || 'underline'](shade) } : { color: shade, ...MARKS[o.deleteMark || 'strikethrough'](shade) };
}

/** The display a run's revisions call for in the current view, or null. */
export function runRevisionDisplay(run) {
  if (!run) return null;
  if (run.revision) return revisionDisplay(run.revision, revisionView.mode, revisionColor(run.revision.author, revisionView.authors));
  const o = revisionView.options;
  if (run.formatRevision && revisionView.mode === 'all' && o.showFormatting !== false && o.formatMark && o.formatMark !== 'none' && !o.hiddenAuthors?.includes(run.formatRevision.author)) {
    const fixed = o.formatColor && o.formatColor !== 'author' ? o.formatColor : revisionColor(run.formatRevision.author, revisionView.authors);
    return { color: fixed, ...MARKS[o.formatMark](fixed) };
  }
  return null;
}

/** Human-readable names of what a formatting revision changed, e.g. ['Bold', 'Font size 14 pt']. */
export function describeFormatChange(target, previous = target.formatRevision?.previous) {
  if (!previous) return ['Formatted'];
  const now = target.styleManaged || target.formatOverrides ? { ...(target.directFormat || {}), ...(target.overrides || {}), ...(target.formatOverrides || {}) } : target;
  const before = previous.styleManaged || previous.formatOverrides ? { ...(previous.directFormat || {}), ...(previous.overrides || {}), ...(previous.formatOverrides || {}) } : previous;
  const names = { bold: 'Bold', italic: 'Italic', underline: 'Underline', strikethrough: 'Strikethrough', fontSize: 'Font size', color: 'Font color', highlight: 'Highlight', fontAscii: 'Font', alignment: 'Alignment', indentLeft: 'Indent', firstLine: 'First line indent', spaceBefore: 'Space before', spaceAfter: 'Space after', lineSpacing: 'Line spacing', capitalization: 'Caps', verticalAlign: 'Position', fontLanguage: 'Language', noProof: 'No proofing' };
  const out = [];
  for (const key of new Set([...Object.keys(now), ...Object.keys(before)])) {
    if (JSON.stringify(now[key]) === JSON.stringify(before[key])) continue;
    const label = names[key]; if (!label) continue;
    const value = now[key];
    out.push(typeof value === 'boolean' ? (value ? label : `Not ${label.toLowerCase()}`) : value === undefined ? `${label} removed` : key === 'fontSize' ? `${label} ${value} pt` : `${label}: ${value}`);
  }
  if ((target.styleId || null) !== (previous.styleId || null)) out.push(`Style: ${target.styleId || 'Default'}`);
  return out.length ? [...new Set(out)] : ['Formatted'];
}

/**
 * How the canvas shows tracked changes: mode 'all' (All Markup), 'simple', 'none' (No Markup)
 * or 'original'; `authors` fixes author colors in order of appearance; `options` are the
 * Show Markup and Tracking Options choices.
 */
// showHidden: hidden text (w:vanish) is laid out when formatting marks are shown.
export const revisionView = { mode: 'all', authors: [], showHidden: false, options: {
  showInsDel: true, showFormatting: true, showComments: true, showInk: true, hiddenAuthors: [], balloons: 'commentsFormatting',
  insertMark: 'underline', deleteMark: 'strikethrough', insertColor: 'author', deleteColor: 'author', formatMark: 'none', formatColor: 'author',
  trackMoves: true, moveFromMark: 'doubleStrikethrough', moveToMark: 'doubleUnderline', moveColor: MOVE_COLOR, trackFormatting: true,
  changeBars: 'left', changeBarColor: 'auto', authorColors: {},
} };
