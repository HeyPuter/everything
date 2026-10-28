// Original document comparison. Two documents' paragraphs and tables are aligned, then each
// paired paragraph is diffed word by word (or character by character) with an O((N+M)·D)
// shortest-edit-script search, and the differences become tracked changes (§17.13.5): text only
// in one document is marked inserted or deleted, and text only in the other is copied in and
// marked the opposite way. The result keeps the base document's structure, formatting, comments
// and existing revisions.
//
// Compare: base = revised document, other = original (other-only text is deleted text).
// Combine: base = original document, other = a revised copy (other-only text is inserted text).
import { trackFormatChanges } from './revisions.js';
import { documentBlocks } from './tables.js';
import { readCoreProperties } from './docx-core-properties.js';

const OBJECT = '￼';

/* ---- Tokens and the edit script ---- */

const WORD = /[\p{L}\p{M}\p{N}_'’-]+|\s+|[^\s\p{L}\p{M}\p{N}_]/gu;
/** Tokens of `text` as { text, start, end }: words, runs of white space, single symbols — or graphemes. */
export function tokenize(text, granularity = 'word') {
  if (granularity === 'character') {
    const out = []; let at = 0;
    const segments = typeof Intl?.Segmenter === 'function' ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.segment) : [...text];
    for (const segment of segments) { out.push({ text: segment, start: at, end: at + segment.length }); at += segment.length; }
    return out;
  }
  return [...text.matchAll(WORD)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
}

/**
 * The shortest edit script between sequences a and b: [{ type: 'equal'|'delete'|'insert', aStart, aEnd, bStart, bEnd }]
 * in order, adjacent operations of one type merged. `equals(x, y)` compares elements. When the
 * script would need more than `maxEdits` edits the remaining middle is reported as a replacement.
 */
export function diffSequences(a, b, equals = (x, y) => x === y, { maxEdits = 4000 } = {}) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && equals(a[prefix], b[prefix])) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && equals(a[a.length - 1 - suffix], b[b.length - 1 - suffix])) suffix++;
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix;
  const ops = [];
  const push = (type, aStart, aEnd, bStart, bEnd) => {
    if (aEnd === aStart && bEnd === bStart) return;
    const last = ops.at(-1);
    if (last && last.type === type && last.aEnd === aStart && last.bEnd === bStart) { last.aEnd = aEnd; last.bEnd = bEnd; }
    else ops.push({ type, aStart, aEnd, bStart, bEnd });
  };
  push('equal', 0, prefix, 0, prefix);
  if (n === 0 || m === 0) {
    push('delete', prefix, prefix + n, prefix, prefix);
    push('insert', prefix + n, prefix + n, prefix, prefix + m);
  } else {
    // Forward search over diagonals k = x − y, keeping each round's frontier for the trace back. Round d
    // only reads round d − 1's diagonals, of the other parity, so one array is updated in place and the
    // trace keeps just diagonals −d…d of each round: copying every diagonal each round took gigabytes
    // for two long, very different documents.
    const offset = n + m + 1, size = 2 * offset + 1, trace = [];
    const v = new Int32Array(size).fill(-1); v[offset + 1] = 0;
    let found = -1;
    for (let d = 0; d <= Math.min(n + m, maxEdits) && found < 0; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || k !== d && v[offset + k - 1] < v[offset + k + 1] ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && equals(a[prefix + x], b[prefix + y])) { x++; y++; }
        v[offset + k] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
      trace.push(v.slice(offset - d, offset + d + 1));
    }
    if (found < 0) {
      push('delete', prefix, prefix + n, prefix, prefix);
      push('insert', prefix + n, prefix + n, prefix, prefix + m);
    } else {
      const steps = [];
      let x = n, y = m;
      for (let d = found; d > 0; d--) {
        // Round d − 1 kept diagonals −(d − 1)…d − 1.
        const previous = trace[d - 1], at = diagonal => previous[diagonal + d - 1], k = x - y;
        const down = k === -d || k !== d && at(k - 1) < at(k + 1);
        const prevK = down ? k + 1 : k - 1, prevX = at(prevK), prevY = prevX - prevK;
        const startX = down ? prevX : prevX + 1, startY = down ? prevY + 1 : prevY;
        steps.push({ snake: [startX, startY, x, y], edit: down ? ['insert', prevX, prevY] : ['delete', prevX, prevY] });
        x = prevX; y = prevY;
      }
      const head = [0, 0, x, y];
      const sequence = [];
      sequence.push(['equal', ...head]);
      for (const step of steps.reverse()) {
        const [type, px, py] = step.edit;
        sequence.push(type === 'insert' ? ['insert', px, py, px, py + 1] : ['delete', px, py, px + 1, py]);
        sequence.push(['equal', ...step.snake]);
      }
      for (const [type, x0, y0, x1, y1] of sequence) push(type, prefix + x0, prefix + x1, prefix + y0, prefix + y1);
    }
  }
  push('equal', prefix + n, a.length, prefix + m, b.length);
  // Present each replacement as its deletion followed by its insertion.
  return ops;
}

/* ---- Visible text of a paragraph with its existing revisions ---- */

const visible = run => run.revision?.type !== 'del';
/** The paragraph's text with tracked deletions left out. */
export const finalText = p => p.runs.filter(visible).map(r => r.text).join('');
const special = r => r.image || r.math || r.vml || r.field || r.noteMark || r.bodySymbol || r.noBreakHyphen || r.breakClear || r.contentControl;
const fullLength = p => p.runs.reduce((n, r) => n + r.text.length, 0);
/** Similarity of two texts: the Dice coefficient of their character bigrams (case-insensitive). */
export function similarity(x, y) {
  if (x === y) return 1;
  const grams = text => { const t = text.toLowerCase().replace(/\s+/g, ' ').trim(), out = new Map(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); } return out; };
  const a = grams(x), b = grams(y);
  let total = 0, shared = 0;
  for (const n of a.values()) total += n;
  for (const [g, n] of b) { total += n; shared += Math.min(n, a.get(g) || 0); }
  return total ? 2 * shared / total : 0;
}

/* ---- Copies from the other document ---- */

function sanitizedRun(run, styleIds) {
  if (special(run) && run.text === OBJECT) return null;
  const out = { ...structuredClone(run) };
  for (const key of ['link', 'contentControl', 'formatRevision', 'revision', 'image', 'math', 'vml', 'field', 'noteMark', 'bodySymbol', 'tocHyperlink']) delete out[key];
  if (out.styleId && !styleIds.has(out.styleId)) {
    out.styleId = null;
    if (out.properties) out.properties = out.properties.replace(/<(?:\w+:)?rStyle\b[^>]*\/>/g, '');
  }
  if (out.properties) out.properties = out.properties.replace(/<(?:\w+:)?rPrChange\b[\s\S]*?<\/(?:\w+:)?rPrChange>|<(?:\w+:)?rPrChange\b[^>]*\/>/g, '');
  return out.text ? out : null;
}
let copies = 0;
function copiedParagraph(p, { styleIds, cellId, template }) {
  const out = structuredClone(p);
  out.id = `cmp${++copies}`;
  out.runs = p.runs.filter(visible).map(r => sanitizedRun(r, styleIds)).filter(Boolean);
  for (const key of ['bookmarks', 'fieldMarkers', 'sectionEnd', 'sectionProperties', 'sectionSourceIndex', 'blockControls', 'markRevision', 'formatRevision', 'tableStyleId', 'tableStyleRegions', 'cellId', 'pageStory', 'storySource']) delete out[key];
  if (cellId) out.cellId = cellId;
  if (template?.tableStyleId) out.tableStyleId = template.tableStyleId;
  if (template?.tableStyleRegions) out.tableStyleRegions = structuredClone(template.tableStyleRegions);
  if (out.shell) out.shell = out.shell.replace(/<(?:\w+:)?(numPr|sectPr|pPrChange)\b[\s\S]*?<\/(?:\w+:)?\1>|<(?:\w+:)?(?:numPr|sectPr|pPrChange)\b[^>]*\/>/g, '').replace(/<(?:\w+:)?(?:ins|del|moveFrom|moveTo)\b[^>]*\/>/g, '');
  if (out.styleId && !styleIds.has(out.styleId)) {
    out.styleId = null;
    if (out.shell) out.shell = out.shell.replace(/<(?:\w+:)?pStyle\b[^>]*\/>/g, '');
  }
  if (out.markStyleId && !styleIds.has(out.markStyleId)) { out.markStyleId = null; out.markProperties = ''; out.markPropertiesChanged = true; }
  out.list = null; delete out.listChanged;
  return out;
}

/* ---- Marking ---- */

function mark(run, type, revision) {
  if (type === 'ins') { if (run.revision?.type !== 'ins') run.revision = { ...revision, type: 'ins' }; delete run.formatRevision; return run; }
  // Deleting another reviewer's insertion keeps it beneath the deletion.
  if (run.revision?.type === 'ins') { if (run.revision.author !== revision.author) run.revision = { ...revision, type: 'del', inserted: { author: run.revision.author, date: run.revision.date } }; else run.revision = { ...revision, type: 'del' }; }
  else if (run.revision?.type !== 'del') run.revision = { ...revision, type: 'del' };
  return run;
}
function mergeRuns(runs) {
  const out = [];
  for (const run of runs) {
    const last = out.at(-1);
    if (last && !special(last) && !special(run) && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...run, text: '' })) last.text += run.text;
    else if (run.text || run.contentControl) out.push(run);
  }
  return out;
}

/** Visible runs of p cut to final-text [from, to). */
function visibleSlice(p, from, to) {
  const out = []; let at = 0;
  for (const run of p.runs) {
    if (!visible(run)) continue;
    const end = at + run.text.length;
    if (end > from && at < to) out.push(special(run) ? { ...run } : { ...run, text: run.text.slice(Math.max(0, from - at), Math.min(run.text.length, to - at)) });
    at = end;
  }
  return out;
}

/**
 * Merge one paragraph pair. Returns the base paragraph rebuilt with marks and copied text, or
 * null when the pair cannot be merged inline (fields or content controls whose text differs).
 */
function mergePair(base, other, { granularity, equals, otherIsNew, revision, styleIds }) {
  const baseText = finalText(base), otherText = finalText(other);
  if ((base.fieldMarkers?.length || other.fieldMarkers?.length || base.runs.some(r => r.contentControl) || other.runs.some(r => r.contentControl)) && baseText !== otherText) return null;
  const a = tokenize(baseText, granularity), b = tokenize(otherText, granularity);
  const ops = diffSequences(a, b, equals);
  // Deleted text reads before the text that replaced it.
  if (!otherIsNew) for (let i = 0; i + 1 < ops.length; i++) if (ops[i].type === 'delete' && ops[i + 1].type === 'insert') { [ops[i], ops[i + 1]] = [ops[i + 1], ops[i]]; i++; }
  const baseMark = otherIsNew ? 'del' : 'ins', otherMark = otherIsNew ? 'ins' : 'del';
  // Base runs in final-text coordinates; deleted (hidden) runs sit at a point.
  const pieces = []; let at = 0;
  for (const run of base.runs) {
    if (!visible(run)) pieces.push({ hidden: true, run, at });
    else { pieces.push({ run, start: at, end: at + run.text.length }); at += run.text.length; }
  }
  const runs = [], shifts = [];
  let emittedBase = 0;
  const takeBase = (from, to, type) => {
    for (const piece of pieces) {
      if (piece.hidden) { if (piece.at >= from && piece.at < to) { runs.push({ ...piece.run }); emittedBase += piece.run.text.length; } continue; }
      if (piece.end <= from || piece.start >= to) continue;
      const run = special(piece.run) ? { ...piece.run } : { ...piece.run, text: piece.run.text.slice(Math.max(from, piece.start) - piece.start, Math.min(to, piece.end) - piece.start) };
      emittedBase += run.text.length;
      runs.push(type ? mark(run, type, revision) : run);
    }
  };
  for (const op of ops) {
    const aFrom = op.aStart < a.length ? a[op.aStart].start : baseText.length, aTo = op.aEnd > op.aStart ? a[op.aEnd - 1].end : aFrom;
    const bFrom = op.bStart < b.length ? b[op.bStart].start : otherText.length, bTo = op.bEnd > op.bStart ? b[op.bEnd - 1].end : bFrom;
    if (op.type !== 'insert') { takeBase(aFrom, aTo, op.type === 'delete' ? baseMark : null); continue; }
    const copied = visibleSlice(other, bFrom, bTo).map(run => {
      const source = run.revision;
      const copy = sanitizedRun(run, styleIds);
      // Text the other reviewer tracked as an insertion keeps its author.
      if (copy && otherMark === 'ins' && source?.type === 'ins') { copy.revision = { ...source }; delete copy.revision.inserted; return copy; }
      return copy && mark(copy, otherMark, revision);
    }).filter(Boolean);
    const length = copied.reduce((n, r) => n + r.text.length, 0);
    if (length) { shifts.push({ at: emittedBase, length }); runs.push(...copied); }
  }
  // Deleted runs after the last visible character.
  for (const piece of pieces) if (piece.hidden && piece.at >= baseText.length) runs.push({ ...piece.run });
  const out = { ...base, runs: mergeRuns(runs) };
  const moved = offset => offset + shifts.filter(s => s.at < offset).reduce((n, s) => n + s.length, 0);
  if (out.bookmarks) out.bookmarks = out.bookmarks.map(m => ({ ...m, offset: moved(m.offset) }));
  if (out.fieldMarkers) out.fieldMarkers = out.fieldMarkers.map(m => ({ ...m, offset: moved(m.offset) }));
  return out;
}

/* ---- Block alignment ---- */

function blockText(block) {
  if (block.type !== 'table') return finalText(block.paragraph);
  return block.rows.map(row => row.cells.map(cell => cell.content.map(blockText).join('\n')).join('\t')).join('\n');
}
const asBlocks = content => content.map(entry => entry.type ? entry : { type: 'paragraph', paragraph: entry.paragraph });

/**
 * Pair blocks: exact matches first, then similar blocks of the same kind, in order, within each
 * changed stretch. Unpaired blocks come out with the deleted side first (`otherFirst` when the
 * other document is the older one).
 */
function alignBlocks(baseBlocks, otherBlocks, otherFirst) {
  const key = block => `${block.type}:${blockText(block).trim().replace(/\s+/g, ' ')}`;
  const ops = diffSequences(baseBlocks.map(key), otherBlocks.map(key));
  const pairs = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'equal') { for (let k = 0; k < op.aEnd - op.aStart; k++) pairs.push({ base: baseBlocks[op.aStart + k], other: otherBlocks[op.bStart + k], same: true }); continue; }
    let deleted = [], inserted = [];
    if (op.type === 'delete') { deleted = baseBlocks.slice(op.aStart, op.aEnd); if (ops[i + 1]?.type === 'insert') { inserted = otherBlocks.slice(ops[i + 1].bStart, ops[i + 1].bEnd); i++; } }
    else { inserted = otherBlocks.slice(op.bStart, op.bEnd); if (ops[i + 1]?.type === 'delete') { deleted = baseBlocks.slice(ops[i + 1].aStart, ops[i + 1].aEnd); i++; } }
    const single = deleted.length === 1 && inserted.length === 1 && deleted[0].type === inserted[0].type;
    let j = 0, waiting = [];
    const flush = upTo => {
      const others = inserted.slice(j, upTo).map(other => ({ other }));
      const bases = waiting.map(base => ({ base }));
      pairs.push(...(otherFirst ? [...others, ...bases] : [...bases, ...others]));
      waiting = []; j = upTo;
    };
    for (const block of deleted) {
      let match = -1;
      for (let k = j; k < inserted.length; k++) if (inserted[k].type === block.type && (single || block.type === 'table' || similarity(blockText(block), blockText(inserted[k])) >= 0.5)) { match = k; break; }
      if (match < 0) { waiting.push(block); continue; }
      flush(match);
      pairs.push({ base: block, other: inserted[match] }); j = match + 1;
    }
    flush(inserted.length);
  }
  return pairs;
}

/**
 * Compare or combine two documents' paragraph sequences.
 * base/other: { paragraphs, tables }. Returns { paragraphs, tables, stats } for the base structure.
 */
export function mergeDocuments(base, other, { mode = 'compare', author = 'Author', date = new Date().toISOString().replace(/\.\d+Z$/, 'Z'), granularity = 'word', caseChanges = true, whiteSpace = true, formatting = true, tables: compareTables = true, styleIds = new Set() } = {}) {
  const otherIsNew = mode === 'combine';
  const revision = { author, date };
  const normalize = text => { let t = text; if (!caseChanges) t = t.toLowerCase(); if (!whiteSpace && /^\s+$/.test(t)) t = ' '; return t; };
  const equals = (x, y) => normalize(x.text) === normalize(y.text);
  const options = { granularity, equals, otherIsNew, revision, styleIds };
  const stats = { inserted: 0, deleted: 0, formatted: 0, paragraphs: 0 };
  const out = [];
  const allMarked = (p, type) => { const copy = { ...structuredClone(p), runs: p.runs.map(r => mark({ ...r }, type, revision)) }; return copy; };
  const countChange = (type, text) => { if (type === 'ins') stats.inserted += text.length; else stats.deleted += text.length; };

  const emitOtherOnly = (block, scope, template) => {
    const type = otherIsNew ? 'ins' : 'del';
    const paragraphs = block.type === 'paragraph' ? [block.paragraph] : flatten(block);
    for (const p of paragraphs) {
      const copy = copiedParagraph(p, { styleIds, cellId: scope, template });
      // Text the other reviewer already tracked as inserted keeps its author.
      const sources = p.runs.filter(visible).filter(r => sanitizedRun(r, styleIds));
      copy.runs = copy.runs.map((r, i) => type === 'ins' && sources[i]?.revision?.type === 'ins' ? { ...r, revision: (({ inserted, ...own }) => own)(sources[i].revision) } : mark(r, type, revision));
      copy.markRevision = type === 'ins' && p.markRevision?.type === 'ins' ? (({ inserted, ...own }) => own)(p.markRevision) : { ...revision, type }; copy.whole = type;
      countChange(type, finalText(p)); stats.paragraphs++;
      out.push(copy);
    }
  };
  const emitBaseOnly = block => {
    const type = otherIsNew ? 'del' : 'ins';
    if (block.type === 'paragraph') {
      const p = allMarked(block.paragraph, type);
      p.markRevision = { ...revision, type }; p.whole = type;
      countChange(type, finalText(block.paragraph)); stats.paragraphs++;
      out.push(p); return;
    }
    walkTable(block, null, type);
  };
  const flatten = block => block.rows.flatMap(row => row.cells.flatMap(cell => cell.content.flatMap(entry => entry.type === 'table' ? flatten(entry) : [entry.paragraph])));
  const emitPair = (pb, po) => {
    if (finalText(pb) === finalText(po)) {
      const p = structuredClone(pb);
      if (formatting && !otherIsNew && !pb.runs.some(r => r.revision) && finalText(pb) === finalText(po)) {
        const before = { ...structuredClone(po), id: p.id, runs: po.runs.filter(visible).map(r => ({ ...structuredClone(r) })) };
        const marked = [p];
        trackFormatChanges([before], marked, () => ({ type: 'format', ...revision }));
        if (p.formatRevision || p.runs.some(r => r.formatRevision)) stats.formatted++;
      }
      out.push(p); return;
    }
    const merged = mergePair(pb, po, options);
    if (!merged) {
      // Not mergeable inline: the base paragraph changes as a whole and the other is copied beside it.
      if (otherIsNew) { emitBaseOnly({ type: 'paragraph', paragraph: pb }); emitOtherOnly({ type: 'paragraph', paragraph: po }, pb.cellId || null, pb); }
      else { emitOtherOnly({ type: 'paragraph', paragraph: po }, pb.cellId || null, pb); emitBaseOnly({ type: 'paragraph', paragraph: pb }); }
      return;
    }
    for (const run of merged.runs) if (run.revision?.author === author && run.revision.date === date) countChange(run.revision.type, run.text);
    stats.paragraphs++;
    out.push(merged);
  };
  // The table's base structure is kept; rows pair by content, cells by position.
  const walkTable = (block, otherBlock, markAll) => {
    const rowKey = row => row.cells.map(cell => cell.content.map(blockText).join('\n')).join('\t');
    const pairs = otherBlock && !markAll ? alignRows(block.rows, otherBlock.rows, rowKey) : block.rows.map(row => ({ base: row }));
    const orphans = [];
    for (const pair of pairs) {
      if (!pair.base) { orphans.push(pair.other); continue; }
      pair.base.cells.forEach((cell, c) => {
        if (!cell.content.length) return; // continuation of a vertical merge
        const otherCell = pair.other?.cells[c];
        if (markAll || !pair.other || !otherCell || !otherCell.content.length) { for (const entry of cell.content) entry.type === 'table' ? walkTable(entry, null, markAll || (otherIsNew ? 'del' : 'ins')) : emitBaseOnly({ type: 'paragraph', paragraph: entry.paragraph }); return; }
        walkScope(asBlocks(cell.content), asBlocks(otherCell.content), cell.id);
      });
    }
    return orphans;
  };
  const alignRows = (baseRows, otherRows, rowKey) => {
    const ops = diffSequences(baseRows.map(rowKey), otherRows.map(rowKey));
    const pairs = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.type === 'equal') { for (let k = 0; k < op.aEnd - op.aStart; k++) pairs.push({ base: baseRows[op.aStart + k], other: otherRows[op.bStart + k] }); continue; }
      let deleted = [], inserted = [];
      if (op.type === 'delete') { deleted = baseRows.slice(op.aStart, op.aEnd); if (ops[i + 1]?.type === 'insert') { inserted = otherRows.slice(ops[i + 1].bStart, ops[i + 1].bEnd); i++; } }
      else { inserted = otherRows.slice(op.bStart, op.bEnd); if (ops[i + 1]?.type === 'delete') { deleted = baseRows.slice(ops[i + 1].aStart, ops[i + 1].aEnd); i++; } }
      const n = Math.min(deleted.length, inserted.length);
      for (let k = 0; k < n; k++) pairs.push({ base: deleted[k], other: inserted[k] });
      for (let k = n; k < deleted.length; k++) pairs.push({ base: deleted[k] });
      for (let k = n; k < inserted.length; k++) pairs.push({ other: inserted[k] });
    }
    return pairs;
  };
  const walkScope = (baseBlocks, otherBlocks, scope) => {
    let lastTemplate = null;
    for (const pair of alignBlocks(baseBlocks, otherBlocks, !otherIsNew)) {
      if (pair.base?.type === 'paragraph') lastTemplate = pair.base.paragraph;
      if (pair.base && pair.other) {
        if (pair.base.type === 'paragraph') emitPair(pair.base.paragraph, pair.other.paragraph);
        else if (!compareTables) out.push(...flatten(pair.base).map(p => structuredClone(p)));
        else {
          const orphans = walkTable(pair.base, pair.other, null);
          // Rows only in the other document follow the table as paragraphs.
          for (const row of orphans) for (const cell of row.cells) for (const entry of cell.content) emitOtherOnly(entry.type === 'table' ? entry : { type: 'paragraph', paragraph: entry.paragraph }, scope, lastTemplate);
        }
      } else if (pair.base) emitBaseOnly(pair.base);
      else if (pair.other.type === 'table' && !compareTables) continue;
      else {
        // Other-only content takes the place where it was: before the next base block.
        emitOtherOnly(pair.other, scope, lastTemplate || baseBlocks[0]?.paragraph);
      }
    }
  };
  const baseTree = documentBlocks(base.paragraphs, base.tables), otherTree = documentBlocks(other.paragraphs, other.tables);
  walkScope(baseTree, otherTree, null);
  // The mark that ends a cell or the document is never a tracked change. Whole paragraphs added or
  // removed at the end of their region carry the change on the mark before them instead: the mark of the
  // paragraph before the run, or, when that paragraph is itself wholly removed (added), the run's first
  // paragraph joins it so that one mark ends both versions.
  const sameRegion = (a, b) => (a.cellId || null) === (b.cellId || null);
  for (let i = 0; i < out.length; i++) {
    const p = out[i], next = out[i + 1];
    if (next && sameRegion(next, p)) continue;
    if (!p.markRevision) continue;
    const change = p.markRevision;
    delete p.markRevision;
    if (!p.whole) continue;
    let first = i;
    while (first > 0 && sameRegion(out[first - 1], p) && out[first - 1].whole && out[first - 1].markRevision?.type === change.type) first--;
    const before = first > 0 && sameRegion(out[first - 1], p) ? out[first - 1] : null;
    if (!before) continue;
    if (!before.markRevision) before.markRevision = { ...change };
    else if (before.whole && before.markRevision.type !== change.type) {
      const joined = out[first];
      // The joined paragraph's bookmarks, comment anchors and fields come along, after the text before them.
      const shift = fullLength(before);
      for (const key of ['bookmarks', 'fieldMarkers']) if (joined[key]?.length) before[key] = [...(before[key] || []), ...joined[key].map(m => ({ ...m, offset: m.offset + shift }))];
      before.runs = [...before.runs, ...joined.runs];
      if (first === i) delete before.markRevision; else before.markRevision = joined.markRevision;
      out.splice(first, 1); i--;
    }
  }
  for (const p of out) delete p.whole;
  return { paragraphs: out, tables: base.tables, stats };
}

/**
 * The last author recorded in a package's core properties (cp:lastModifiedBy, then dc:creator), read from
 * the part the package relationship names (ECMA-376 Part 2 §11).
 */
export function documentAuthor(parts) {
  const core = readCoreProperties(parts || {});
  return core.lastModifiedBy || core.creator || null;
}
