// Mail merge commands on the document model. Each runs inside an editor
// transaction (CanvasEditor.execute), so it is one undo step and passes the
// usual validation. Field records are built from DOCX field markup exactly as
// the reader builds them, so they save as ordinary MERGEFIELD, ADDRESSBLOCK,
// GREETINGLINE and rule fields (complex fields, with nested operands kept in
// the instruction).
import { bodyFieldRanges, newFieldEndOrder, newFieldStartOrder } from './body-fields.js';
import { bodyFieldInstruction } from './docx-body-fields.js';
import { pageFieldSegments } from './docx-page-fields.js';
import { paragraph } from './model.js';
import { validatePageSettings } from './page-settings.js';
import { parseFieldCode, flattenFieldCode, fieldKeyword, placeholderText, evaluateField, mergeContext, MERGE_TYPES } from './merge-fields.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const length = p => p.runs.reduce((n, r) => n + r.text.length, 0);
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let fieldCount = 0, order = 3e6;

/** Complex field markup for a code tree: nested fields become nested begin/separate/end envelopes. */
function fieldXml(tree, cache = '') {
  const code = tree.parts.map(part => typeof part === 'string'
    ? `<w:r><w:instrText xml:space="preserve">${escape(part)}</w:instrText></w:r>`
    : fieldXml(part, placeholderText(part) ?? '')).join('');
  return `<w:r><w:fldChar w:fldCharType="begin"/></w:r>${code}<w:r><w:fldChar w:fldCharType="separate"/></w:r>${cache ? `<w:r><w:rPr><w:noProof/></w:rPr><w:t xml:space="preserve">${escape(cache)}</w:t></w:r>` : ''}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
}

/** A new body field record for an instruction (nested fields in braces), as the DOCX reader would produce it. */
export function newMergeField(instruction) {
  const tree = parseFieldCode(instruction);
  const root = new DOMParser().parseFromString(`<w:p xmlns:w="${W}">${fieldXml(tree)}</w:p>`, 'application/xml').documentElement;
  const [segment] = pageFieldSegments(root, bodyFieldInstruction);
  if (!segment?.field) throw new Error('Invalid field instruction.');
  return { ...segment.field, id: `mergeField${++fieldCount}` };
}

const offsetOf = (paragraphs, index) => { let at = 0; for (let i = 0; i < index; i++) at += length(paragraphs[i]) + 1; return at; };
const paragraphAt = (paragraphs, position) => { let i = 0, at = 0; while (i < paragraphs.length - 1 && at + length(paragraphs[i]) < position) at += length(paragraphs[i++]) + 1; return { index: i, offset: position - at }; };
const displayText = text => String(text ?? '').replace(/\r\n?|\n/g, '\v');

/** Insert a field at the selection with its display text as the result; the caret ends after it. */
export function insertMergeField(model, instruction, text = null) {
  const field = newMergeField(instruction);
  const shown = displayText(text ?? placeholderResults([{ code: instruction, type: fieldKeyword(instruction) }])[0] ?? '');
  // Replacing a selection is an ordinary edit: with Track Changes on, the selection is marked deleted
  // and the field follows it, marked inserted, as typing over the selection would be.
  if (model.range[0] !== model.range[1]) model.replace('', { checkpoint: false });
  let at = model.range[0];
  const ranges = model.paragraphs.some(p => p.fieldMarkers?.length) ? bodyFieldRanges(model.paragraphs) : [];
  // A field is not placed inside another merge field's result: it goes after that field.
  const inside = ranges.find(r => r.start < at && at < r.end && MERGE_TYPES.has(r.field.type));
  if (inside) { at = inside.end; model.select(at); }
  // Typing at an empty field result fills it; a new field beside it must leave it empty.
  const empty = new Set(ranges.filter(r => r.start === at && r.end === at).map(r => r.field.id));
  if (shown) model.replace(shown, { checkpoint: false });
  const { index, offset } = paragraphAt(model.paragraphs, at);
  const p = model.paragraphs[index];
  for (const marker of p.fieldMarkers || []) if (marker.type === 'end' && empty.has(marker.field.id)) marker.offset = offset;
  const startOrder = newFieldStartOrder(p, offset, order), endOrder = startOrder + 1;
  order = endOrder + 1;
  (p.fieldMarkers ||= []).push({ type: 'start', field, offset, order: startOrder }, { type: 'end', field, offset: offset + shown.length, order: shown ? newFieldEndOrder(p, offset + shown.length, endOrder) : endOrder });
  model.hasBodyFields = true;
  bodyFieldRanges(model.paragraphs);
  model.select(at + shown.length);
  model.didChange();
  return field;
}

/** Top-level fields in the body that the merge evaluates (or that hold merge results), in document order. */
export function mergeFieldRanges(model) {
  if (!model.paragraphs.some(p => p.fieldMarkers?.length)) return [];
  const ranges = bodyFieldRanges(model.paragraphs), byId = new Map(ranges.map(r => [r.field.id, r]));
  const insideMerge = r => { for (let parent = byId.get(r.parentId); parent; parent = byId.get(parent.parentId)) if (MERGE_TYPES.has(parent.field.type)) return true; return false; };
  return ranges.filter(r => !insideMerge(r)).map(r => ({ range: r, code: r.field.instruction, type: fieldKeyword(r.field.instruction) }));
}

/** Whether the document has any merge fields. */
export const hasMergeFields = model => mergeFieldRanges(model).some(f => MERGE_TYPES.has(f.type));

/** The run holding document position `position` (the one starting there), or null. */
function runAt(paragraphs, position) {
  const { index, offset } = paragraphAt(paragraphs, position);
  let at = 0;
  for (const run of paragraphs[index].runs) { if (offset < at + run.text.length) return run; at += run.text.length; }
  return null;
}
// What a result run's formatting is made of: everything but its text and the objects and annotations it holds.
const NOT_FORMATTING = ['text', 'image', 'contentControl', 'positionalTab', 'noteMark', 'bodySymbol', 'noBreakHyphen', 'breakClear', 'field', 'revision', 'formatRevision', 'math', 'vml', 'link'];
const resultFormatting = run => { const out = structuredClone(run); for (const key of NOT_FORMATTING) delete out[key]; return out; };

/** Runs with the plain text in [from, to) given `formatting`; text a line break or object holds keeps its own. */
function withFormatting(runs, from, to, formatting) {
  const out = []; let at = 0;
  const plain = run => !run.image && !run.math && !run.vml && !run.field && !run.noteMark && !run.bodySymbol && !run.noBreakHyphen && !run.breakClear && !run.contentControl;
  const push = run => {
    const last = out.at(-1);
    if (last && plain(last) && plain(run) && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...run, text: '' })) last.text += run.text;
    else out.push(run);
  };
  for (const run of runs) {
    const start = at, end = at + run.text.length; at = end;
    if (end <= from || start >= to || !plain(run)) { push({ ...run }); continue; }
    const a = Math.max(from, start) - start, b = Math.min(to, end) - start;
    if (a) push({ ...run, text: run.text.slice(0, a) });
    push({ ...structuredClone(formatting), text: run.text.slice(a, b) });
    if (b < run.text.length) push({ ...run, text: run.text.slice(b) });
  }
  return out;
}

/** Replace field results in place (no tracking); returns how many changed. */
export function applyMergeResults(model, fields, results) {
  const text = model.text, changes = [];
  fields.forEach((f, i) => {
    const value = results[i];
    if (value === null || value === undefined) return;
    const shown = displayText(value);
    if (text.slice(f.range.start, f.range.end) !== shown) changes.push({ range: f.range, text: shown });
  });
  if (!changes.length) return 0;
  const tracking = model.trackChanges;
  // The selection stays on its text: a longer or shorter result before it moves it along.
  let { anchor, focus } = model.selection;
  model.trackChanges = false;
  try {
    for (const { range, text: value } of changes.reverse()) {
      const map = at => at <= range.start ? at : at >= range.end ? at + value.length - (range.end - range.start) : range.start + Math.min(at - range.start, value.length);
      anchor = map(anchor); focus = map(focus);
      model.select(range.start, range.end);
      model.typingFormat = {}; model.typingStyle = null; model.typingDirectCleared = false;
      if (range.start === range.end && !value) continue;
      // A result emptied for a recipient without a value keeps its formatting on the field, so the next
      // value (or the placeholder) is bold again where the field was bold, not like the text before it.
      if (range.end > range.start) { const run = runAt(model.paragraphs, range.start); if (run) range.field.resultFormatting = resultFormatting(run); }
      model.replaceResult(value, { checkpoint: false });
      const saved = range.start === range.end && value && range.field.resultFormatting;
      if (saved) {
        const { index } = paragraphAt(model.paragraphs, range.start), p = model.paragraphs[index], from = range.start - offsetOf(model.paragraphs, index), to = from + value.length;
        p.runs = withFormatting(p.runs, from, to, saved);
      }
    }
  } finally { model.trackChanges = tracking; }
  const max = model.text.length;
  model.select(Math.min(anchor, max), Math.min(focus, max));
  model.didChange();
  return changes.length;
}

/** Results that show field placeholders (preview off). */
export function placeholderResults(fields) {
  const ctx = mergeContext({ placeholders: true });
  return fields.map(f => MERGE_TYPES.has(f.type) ? evaluateField(f.code, ctx) : null);
}

/* ---- Labels ---- */

/** The label table: the first table whose first cell holds a merge field. */
export function labelTable(model) {
  const fields = mergeFieldRanges(model).filter(f => MERGE_TYPES.has(f.type));
  for (const table of model.tables) {
    if (table.parentCellId) continue;
    const first = table.rows[0]?.cells[0];
    if (first && fields.some(f => model.paragraphs.find(p => p.id === f.range.startParagraph)?.cellId === first.id)) return table;
  }
  return null;
}

/** Cells that hold labels; narrow spacer columns between labels are skipped. */
export function labelCells(table) {
  const firstWidth = table.grid[0] || 1;
  const cells = [];
  for (const row of table.rows) {
    let column = 0;
    for (const cell of row.cells) {
      const span = cell.span || 1, width = table.grid.slice(column, column + span).reduce((a, b) => a + b, 0);
      if (width >= firstWidth * 0.5 && cell.vMerge !== 'continue') cells.push(cell);
      column += span;
    }
  }
  return cells;
}

/** Copy the first label to every other label, each starting with a Next Record field. Returns the number of labels updated. */
export function updateLabels(model) {
  const table = labelTable(model);
  if (!table) throw new Error('Add merge fields to the first label, then update the other labels from it.');
  const [first, ...others] = labelCells(table);
  const source = model.paragraphs.filter(p => p.cellId === first.id);
  // A first label that starts with NEXT itself is copied without it.
  const sourceFields = new Map();
  const copyParagraph = (p, cellId) => {
    const copy = structuredClone({ ...p, fieldMarkers: undefined, bookmarks: undefined });
    delete copy.fieldMarkers; delete copy.bookmarks; delete copy.sectionEnd; delete copy.sectionProperties;
    copy.id = paragraph().id; copy.cellId = cellId;
    if (p.fieldMarkers?.length) copy.fieldMarkers = [...p.fieldMarkers].sort((a, b) => a.offset - b.offset || (a.order ?? 0) - (b.order ?? 0)).map(m => {
      let clones = sourceFields.get(cellId);
      if (!clones) sourceFields.set(cellId, clones = new Map());
      if (!clones.has(m.field.id)) clones.set(m.field.id, { ...structuredClone(m.field), id: `mergeField${++fieldCount}` });
      return { ...m, field: clones.get(m.field.id), order: order++ };
    });
    return copy;
  };
  let updated = 0;
  for (const cell of others) {
    const at = model.paragraphs.findIndex(p => p.cellId === cell.id);
    if (at < 0) continue;
    let end = at; while (end < model.paragraphs.length && model.paragraphs[end].cellId === cell.id) end++;
    // Each later label moves on to the next record: its NEXT field opens before the copied fields.
    const next = newMergeField(' NEXT '), text = placeholderText(' NEXT ');
    const nextMarkers = [{ type: 'start', field: next, offset: 0, order: order++ }, { type: 'end', field: next, offset: text.length, order: order++ }];
    const replacement = source.map(p => copyParagraph(p, cell.id));
    model.paragraphs.splice(at, end - at, ...replacement);
    const head = replacement[0];
    const template = head.runs.find(r => !r.field && !r.image && !r.noteMark && !r.math && !r.vml && !r.bodySymbol) || paragraph('x').runs[0];
    const lead = { ...structuredClone(template), text };
    for (const key of ['link', 'revision', 'contentControl', 'styleChanged']) delete lead[key];
    head.runs = [lead, ...head.runs];
    for (const m of [...(head.fieldMarkers || []), ...(head.bookmarks || [])]) m.offset += text.length;
    (head.fieldMarkers ||= []).unshift(...nextMarkers);
    updated++;
  }
  // The first label must not skip a record.
  model.hasBodyFields = true;
  bodyFieldRanges(model.paragraphs);
  model.select(offsetOf(model.paragraphs, model.paragraphs.findIndex(p => p.cellId === first.id)));
  model.didChange();
  return updated;
}

/* ---- Envelopes ---- */

const IN = 1440;
/** Section properties for an envelope page. */
export function envelopeSection(width, height, margins = { top: 0.4 * IN, left: 0.4 * IN, right: 0.4 * IN, bottom: 0.4 * IN }) {
  const landscape = width > height;
  const settings = validatePageSettings({ ...envelopePageSettings(width, height, margins) });
  const xml = `<w:sectPr xmlns:w="${W}"><w:pgSz w:w="${width}" w:h="${height}"${landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${margins.top}" w:right="${margins.right}" w:bottom="${margins.bottom}" w:left="${margins.left}" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>`;
  return { settings, xml };
}
export function envelopePageSettings(width, height, margins = { top: 0.4 * IN, left: 0.4 * IN, right: 0.4 * IN, bottom: 0.4 * IN }) {
  return { width, height, orientation: width > height ? 'landscape' : 'portrait', ...margins, header: 360, footer: 360, gutter: 0 };
}

/**
 * Lay out an envelope at the start of the document: a return address at the top left and the delivery
 * address placed by indent and space before. An empty document becomes the envelope; otherwise the
 * envelope is its own first section. `delivery` may be text or { field: instruction }.
 */
export function insertEnvelope(model, { width, height, delivery = '', returnAddress = '', omitReturn = false, deliveryLeft, deliveryTop, fontSize = null }) {
  const margin = 0.4 * IN;
  const empty = !model.text && model.paragraphs.length === 1 && !model.tables.length;
  const left = Math.max(0, Math.round((deliveryLeft ?? width * 0.42) - margin));
  const returnText = omitReturn ? '' : displayText(returnAddress.trim());
  const returnLines = returnText ? returnText.split('\v').length : 0;
  // Space before the delivery address: from the top margin to its top, less the return address lines.
  const lineHeight = 14.5;
  const spaceBefore = Math.max(0, Math.round((((deliveryTop ?? height * 0.48) - margin) / 20 - returnLines * lineHeight - (returnLines ? 9 : 0)) * 2) / 2);
  const deliveryField = typeof delivery === 'object' && delivery?.field;
  const deliveryText = deliveryField ? '' : displayText(String(delivery).trim());
  if (empty) model.setPageSettings(envelopePageSettings(width, height));
  model.select(0);
  const text = `${returnText}\n${deliveryText}${empty ? '' : '\n'}`;
  model.replaceUntracked(text, { checkpoint: false });
  model.select(0, returnText.length);
  model.setParagraphFormat({ spaceBefore: 0, spaceAfter: 0, indentLeft: 0, firstLine: 0, alignment: 'left' });
  if (fontSize) { model.select(0, returnText.length); if (returnText) model.setRunFormat({ fontSize: Math.max(8, fontSize - 2) }); }
  const deliveryStart = returnText.length + 1;
  model.select(deliveryStart, deliveryStart + deliveryText.length);
  model.setParagraphFormat({ spaceBefore, spaceAfter: 0, indentLeft: left, firstLine: 0, alignment: 'left' });
  if (fontSize && deliveryText) model.setRunFormat({ fontSize });
  // The envelope is written untracked, its address field with it.
  if (deliveryField) {
    const tracking = model.trackChanges; model.trackChanges = false;
    try { model.select(deliveryStart); insertMergeField(model, deliveryField); } finally { model.trackChanges = tracking; }
  }
  if (!empty) {
    const { settings, xml } = envelopeSection(width, height);
    const index = paragraphAt(model.paragraphs, deliveryStart).index;
    model.paragraphs[index].sectionEnd = settings;
    model.paragraphs[index].sectionProperties = xml;
  }
  model.select(0);
  model.didChange();
  return true;
}
