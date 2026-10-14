// New documents for mailings: label sheets (a fixed table with one cell per
// label, spacer columns for the gaps) and envelopes (a page the size of the
// envelope). Label sheets are generated as WordprocessingML directly so every
// measurement is exact; envelopes are laid out through the document model.
import { zipSync } from 'fflate';
import { createDocx, DocxPackage, WRITING_STYLES, DOCX_TYPE } from './docx.js';
import { TextDocument, paragraph } from './model.js';
import { writeMailMerge } from './docx-mail-merge.js';
import { insertEnvelope } from './mail-merge-model.js';
import { parseFieldCode, placeholderText } from './merge-fields.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const IN = 1440, MM = 1440 / 25.4;
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Page sizes for label sheets, in twips. */
export const SHEETS = { letter: { name: 'Letter (8½ × 11 in)', width: 12240, height: 15840 }, a4: { name: 'A4 (210 × 297 mm)', width: 11906, height: 16838 } };

const inch = (cols, rows, w, h, top, left, pitchX = w, pitchY = h) => ({ unit: 'in', columns: cols, rows, width: w * IN, height: h * IN, top: top * IN, left: left * IN, pitchX: pitchX * IN, pitchY: pitchY * IN });
const mm = (cols, rows, w, h, top, left, pitchX = w, pitchY = h) => ({ unit: 'mm', columns: cols, rows, width: w * MM, height: h * MM, top: top * MM, left: left * MM, pitchX: pitchX * MM, pitchY: pitchY * MM });
/** Generic label sheets described by their measurements. */
export const LABEL_LAYOUTS = [
  { id: 'letter-30', sheet: 'letter', name: '30 per sheet — 1 × 2⅝ in (address)', ...inch(3, 10, 2.625, 1, 0.5, 0.1875, 2.75) },
  { id: 'letter-20', sheet: 'letter', name: '20 per sheet — 1 × 4 in (address)', ...inch(2, 10, 4, 1, 0.5, 0.15625, 4.1875) },
  { id: 'letter-14', sheet: 'letter', name: '14 per sheet — 1⅓ × 4 in (address)', ...inch(2, 7, 4, 1 + 1 / 3, 0.8333, 0.15625, 4.1875) },
  { id: 'letter-10', sheet: 'letter', name: '10 per sheet — 2 × 4 in (shipping)', ...inch(2, 5, 4, 2, 0.5, 0.15625, 4.1875) },
  { id: 'letter-6', sheet: 'letter', name: '6 per sheet — 3⅓ × 4 in (shipping)', ...inch(2, 3, 4, 3 + 1 / 3, 0.5, 0.15625, 4.1875) },
  { id: 'letter-80', sheet: 'letter', name: '80 per sheet — ½ × 1¾ in (return address)', ...inch(4, 20, 1.75, 0.5, 0.5, 0.28125, 2.0625) },
  { id: 'letter-8', sheet: 'letter', name: '8 per sheet — 2⅓ × 3⅜ in (name badge)', ...inch(2, 4, 3.375, 2 + 1 / 3, 1, 0.6875, 3.75) },
  { id: 'letter-2', sheet: 'letter', name: '2 per sheet — 5½ × 8½ in (shipping)', ...inch(1, 2, 8.5, 5.5, 0, 0) },
  { id: 'letter-1', sheet: 'letter', name: '1 per sheet — 8½ × 11 in (full sheet)', ...inch(1, 1, 8.5, 11, 0, 0) },
  { id: 'a4-21', sheet: 'a4', name: '21 per sheet — 63.5 × 38.1 mm', ...mm(3, 7, 63.5, 38.1, 15.15, 7.21, 66.04) },
  { id: 'a4-24', sheet: 'a4', name: '24 per sheet — 63.5 × 33.9 mm', ...mm(3, 8, 63.5, 33.9, 12.9, 7.21, 66.04) },
  { id: 'a4-14', sheet: 'a4', name: '14 per sheet — 99.1 × 38.1 mm', ...mm(2, 7, 99.1, 38.1, 15.15, 4.65, 101.6) },
  { id: 'a4-8', sheet: 'a4', name: '8 per sheet — 99.1 × 67.7 mm', ...mm(2, 4, 99.1, 67.7, 13.1, 4.65, 101.6) },
  { id: 'a4-65', sheet: 'a4', name: '65 per sheet — 38.1 × 21.2 mm', ...mm(5, 13, 38.1, 21.2, 10.7, 4.7, 40.6) },
];

/** Check a layout fits its sheet; returns a list of problems (empty when it fits). */
export function layoutProblems(layout) {
  const sheet = SHEETS[layout.sheet] || SHEETS.letter, problems = [];
  if (!(layout.columns >= 1 && layout.columns <= 10 && layout.rows >= 1 && layout.rows <= 40)) problems.push('Use 1–10 labels across and 1–40 down.');
  if (!(layout.width >= 0.25 * IN && layout.height >= 0.25 * IN)) problems.push('Labels must be at least ¼ in (6 mm) wide and high.');
  if (layout.pitchX < layout.width - 1 || layout.pitchY < layout.height - 1) problems.push('The distance between labels cannot be less than the label size.');
  if (layout.left + layout.pitchX * (layout.columns - 1) + layout.width > sheet.width + 2) problems.push('The labels are wider than the page.');
  if (layout.top + layout.pitchY * (layout.rows - 1) + layout.height > sheet.height + 2) problems.push('The labels are taller than the page.');
  return problems;
}

/** Complex field markup for an instruction (nested fields in braces) with its display result. */
export function fieldMarkup(instruction, properties = '') {
  const build = tree => {
    const code = tree.parts.map(part => typeof part === 'string' ? `<w:r>${properties}<w:instrText xml:space="preserve">${escape(part)}</w:instrText></w:r>` : build(part)).join('');
    const shown = placeholderText(tree) ?? '';
    return `<w:r>${properties}<w:fldChar w:fldCharType="begin"/></w:r>${code}<w:r>${properties}<w:fldChar w:fldCharType="separate"/></w:r>${runs(shown, properties)}<w:r>${properties}<w:fldChar w:fldCharType="end"/></w:r>`;
  };
  return build(parseFieldCode(instruction));
}
/** Runs for text with line breaks. */
function runs(text, properties = '') {
  if (!text) return '';
  return `<w:r>${properties}${String(text).split(/\r\n?|\n|\v/).map((line, i) => `${i ? '<w:br/>' : ''}${line ? `<w:t xml:space="preserve">${escape(line)}</w:t>` : ''}`).join('')}</w:r>`;
}

/**
 * A label sheet's body XML. `content(index)` returns a label's content: { text } or { fields: [instruction | text pieces] }.
 * Each label is one cell; spacer columns and rows carry the gaps.
 */
export function labelSheetBody(layout, content, { fontSize = 10 } = {}) {
  const sheet = SHEETS[layout.sheet] || SHEETS.letter;
  const gapX = Math.max(0, Math.round(layout.pitchX - layout.width)), gapY = Math.max(0, Math.round(layout.pitchY - layout.height));
  const width = Math.round(layout.width), height = Math.round(layout.height);
  const grid = [];
  for (let c = 0; c < layout.columns; c++) { grid.push(width); if (gapX && c < layout.columns - 1) grid.push(gapX); }
  const total = grid.reduce((a, b) => a + b, 0);
  const pad = Math.min(Math.round(0.06 * IN), Math.round(width / 10));
  const rPr = `<w:rPr><w:sz w:val="${Math.round(fontSize * 2)}"/><w:szCs w:val="${Math.round(fontSize * 2)}"/></w:rPr>`;
  const pPr = `<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="${pad}" w:right="${pad}"/>${rPr}</w:pPr>`;
  const cell = (w, inner, label) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${label ? '<w:vAlign w:val="center"/>' : ''}</w:tcPr>${inner || `<w:p>${pPr}</w:p>`}</w:tc>`;
  const labelXml = index => {
    const item = content(index);
    if (!item) return '';
    if (item.fields) return `<w:p>${pPr}${item.fields.map(piece => typeof piece === 'string' ? runs(piece, rPr) : fieldMarkup(piece.field, rPr)).join('')}</w:p>`;
    const lines = String(item.text || '').split(/\r\n?|\n/);
    return lines.map(line => `<w:p>${pPr}${runs(line, rPr)}</w:p>`).join('');
  };
  let rowsXml = '', index = 0;
  for (let r = 0; r < layout.rows; r++) {
    let cells = '';
    for (let c = 0; c < layout.columns; c++) {
      cells += cell(width, labelXml(index++), true);
      if (gapX && c < layout.columns - 1) cells += cell(gapX, '', false);
    }
    rowsXml += `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${height}" w:hRule="exact"/></w:trPr>${cells}</w:tr>`;
    if (gapY && r < layout.rows - 1) rowsXml += `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${gapY}" w:hRule="exact"/></w:trPr>${grid.map(w => cell(w, '', false)).join('')}</w:tr>`;
  }
  const none = side => `<w:${side} w:val="nil"/>`;
  const table = `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblInd w:w="0" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(none).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rowsXml}</w:tbl>`;
  // A tiny final paragraph, so the table does not push a blank page.
  const tail = `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`;
  const top = Math.round(layout.top), left = Math.round(layout.left);
  const right = Math.max(0, sheet.width - left - total);
  const section = `<w:sectPr><w:pgSz w:w="${sheet.width}" w:h="${sheet.height}"/><w:pgMar w:top="${top}" w:right="${right}" w:bottom="0" w:left="${left}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
  return table + tail + section;
}

/** The label sheet as a .docx Blob. `mailMerge` (state) makes it a labels main document. */
export function labelSheetDocx(layout, content, { fontSize, mailMerge = null } = {}) {
  const parts = { ...createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES).parts };
  parts['word/document.xml'] = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${labelSheetBody(layout, content, { fontSize })}</w:body></w:document>`);
  if (mailMerge) writeMailMerge(parts, mailMerge);
  return new Blob([zipSync(parts)], { type: DOCX_TYPE });
}

/** An envelope document as a .docx Blob (one envelope page). */
export async function envelopeDocx(options, { mailMerge = null } = {}) {
  const blank = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  model.checkpoint = () => {};
  insertEnvelope(model, options);
  pkg.mailMerge = mailMerge;
  return pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets);
}

/** Envelope sizes (width × height, landscape as fed). */
export const ENVELOPE_SIZES = [
  { id: 'us10', name: '#10 (4⅛ × 9½ in)', width: 9.5 * IN, height: 4.125 * IN },
  { id: 'us9', name: '#9 (3⅞ × 8⅞ in)', width: 8.875 * IN, height: 3.875 * IN },
  { id: 'monarch', name: 'Monarch (3⅞ × 7½ in)', width: 7.5 * IN, height: 3.875 * IN },
  { id: 'a7', name: 'A7 invitation (5¼ × 7¼ in)', width: 7.25 * IN, height: 5.25 * IN },
  { id: 'us6', name: '6¾ (3⅝ × 6½ in)', width: 6.5 * IN, height: 3.625 * IN },
  { id: 'dl', name: 'DL (110 × 220 mm)', width: Math.round(220 * MM), height: Math.round(110 * MM) },
  { id: 'c5', name: 'C5 (162 × 229 mm)', width: Math.round(229 * MM), height: Math.round(162 * MM) },
  { id: 'c6', name: 'C6 (114 × 162 mm)', width: Math.round(162 * MM), height: Math.round(114 * MM) },
  { id: 'c4', name: 'C4 (229 × 324 mm)', width: Math.round(324 * MM), height: Math.round(229 * MM) },
  { id: 'b5', name: 'B5 (176 × 250 mm)', width: Math.round(250 * MM), height: Math.round(176 * MM) },
];
