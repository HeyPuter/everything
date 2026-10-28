import { locate, paragraphText, paragraphFormat, boundaries } from './model.js';
import { resolveStyledParagraph } from './styles.js';
import { OBJECT } from './images.js';

// ECMA-376 Part 1 §17.3.1.11 (framePr dropCap/lines/hSpace) and §17.18.20
// (ST_DropCap). A drop cap is stored as its own framed paragraph holding the
// first letter, immediately before the paragraph whose text it begins. The
// layout (paragraph-frames.js) places it from the following paragraph's lines.

const MODES = ['none', 'drop', 'margin'];
// Approximate cap height and single line height as fractions of the font size.
// The layout aligns the cap's baseline itself; these only size the glyph and
// give other consumers a matching exact line height and lowering.
const CAP_HEIGHT = .7, LINE_HEIGHT = 1.2, BASELINE = .8;
const halfPoints = value => Math.round(value * 2) / 2;
const capMode = p => ['drop', 'margin'].includes(p?.frameProperties?.dropCap) ? p.frameProperties.dropCap : null;
const paragraphStart = (model, index) => model.paragraphs.slice(0, index).reduce((n, p) => n + paragraphText(p).length + 1, 0);
const copy = value => structuredClone(value);
const plainRun = run => run.text && !run.image && !run.field && !run.noteMark && !run.math && !run.vml && !run.bodySymbol && !run.contentControl;

/** The caret's drop-cap frame paragraph (itself, or the one right before it) and its text paragraph. */
function capPair(model) {
  const index = locate(model.paragraphs, model.selection.focus).index, ps = model.paragraphs;
  if (capMode(ps[index])) return { frame: index, text: index + 1 };
  if (index > 0 && capMode(ps[index - 1])) return { frame: index - 1, text: index };
  return { frame: -1, text: index };
}

export function dropCapState(model) {
  const { frame } = capPair(model);
  if (frame < 0) return { mode: 'none', lines: 3, distance: 0, fontFamily: null };
  const p = model.paragraphs[frame], properties = p.frameProperties;
  return { mode: properties.dropCap, lines: Number(properties.lines ?? 1) || 1, distance: Number(properties.hSpace ?? 0) / 20 || 0,
    fontFamily: p.runs.find(plainRun)?.fontHAnsi ?? null };
}

/** Run inside an engine transaction; sub-operations collapse into one model undo step too. */
export function setDropCap(model, { mode, lines = 3, distance = 0, fontFamily = null } = {}) {
  if (!MODES.includes(mode)) throw new Error('Choose None, Dropped or In margin for the drop cap.');
  if (!Number.isInteger(lines) || lines < 1 || lines > 10) throw new Error('A drop cap spans 1–10 lines.');
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0 || distance > 1584) throw new Error('The distance from text must be 0–1584 pt.');
  if (fontFamily !== null && (typeof fontFamily !== 'string' || !fontFamily.trim())) throw new Error('Choose a font for the drop cap.');
  if (model.trackChanges) throw new Error('Turn off Track Changes to add, change or remove a drop cap.');
  const pair = capPair(model);
  if (mode === 'none' && pair.frame < 0) return false;
  return transaction(model, () => mode === 'none' ? removeCap(model, pair.frame) : styleCap(model, pair.frame < 0 ? createCap(model, pair.text) : pair.frame, { mode, lines, distance, fontFamily }));
}

function transaction(model, change) {
  // Its own copy to roll back to: inside an editor command the history entry holds no copy of the document.
  const before = model.snapshot();
  model.checkpoint();
  const mine = model.history.at(-1);
  try { change(); }
  catch (error) {
    model.restore(before);
    const at = model.history.lastIndexOf(mine);
    if (at >= 0) model.history.length = at;
    throw error;
  }
  const at = model.history.lastIndexOf(mine);
  if (at >= 0) model.history.length = at + 1;
  model.future = [];
  model.didChange();
  return true;
}

// Split the first grapheme off into a preceding paragraph; returns its index.
function createCap(model, index) {
  const p = model.paragraphs[index], text = paragraphText(p);
  if (p.cellId) throw new Error('Drop caps are not available in table cells.');
  if (p.list) throw new Error('Drop caps are not available for list items.');
  if (p.frameProperties) throw new Error('This paragraph is already in a frame.');
  if (!text) throw new Error('Type some text before adding a drop cap.');
  const start = paragraphStart(model, index), offset = model.selection.focus - start;
  const length = (boundaries(model.text).find(b => b > start) ?? start + text.length) - start, letter = text.slice(0, length);
  const run = p.runs.find(r => r.text);
  if (!plainRun(run) || /[\s\u0000-\u001f]/u.test(letter) || letter.includes(OBJECT)) throw new Error('A drop cap must start with a letter or other visible character.');
  model.select(start + length);
  if (!model.replace('\n')) throw new Error('The drop cap could not be created here.');
  model.select(offset >= length ? start + offset + 1 : start + offset);
  return index;
}

function styleCap(model, index, { mode, lines, distance, fontFamily }) {
  const frame = model.paragraphs[index], next = model.paragraphs[index + 1];
  const textParagraph = next && !next.cellId && !capMode(next) ? next : frame;
  const textRun = textParagraph.runs.find(plainRun) || textParagraph.markFormat || {}, size = textRun.fontSize ?? 12;
  // One line of the following paragraph, in points (§17.3.1.33 spacing).
  const format = paragraphFormat(textParagraph, model.numbering);
  const line = format.lineRule === 'exact' ? format.lineSpacing : format.lineRule === 'atLeast' ? Math.max(format.lineSpacing, size * LINE_HEIGHT) : size * LINE_HEIGHT * format.lineSpacing;
  // Cap height reaches from the first line's cap height to line `lines`' baseline.
  const capSize = Math.min(1638, Math.max(1, halfPoints(((lines - 1) * line + CAP_HEIGHT * size) / CAP_HEIGHT)));
  const height = Math.min(600, Math.round(lines * line * 20) / 20);
  // With baselines at 80% of each line, lower the cap from its exact line's baseline to line `lines`.
  const lowering = Math.min(200, halfPoints((1 - BASELINE) * (lines - 1) * line));
  // §17.3.1.11: rebuild the declaration we manage. The layout ignores anchors
  // for drop caps; a margin cap is written page-relative as desktop
  // word processors do, and is placed hSpace before the text column.
  const properties = { dropCap: mode, lines: String(lines), wrap: 'around', vAnchor: 'text', hAnchor: mode === 'margin' ? 'page' : 'text',
    ...(distance ? { hSpace: String(Math.round(distance * 20)) } : {}) };
  if (frame.styleContext) { frame.styleContext.properties.frameProperties = properties; resolveStyledParagraph(frame, model.styles, model.numbering); }
  else frame.frameProperties = properties;
  frame.framePropertiesChanged = true;
  const { anchor, focus } = model.selection, start = paragraphStart(model, index), end = start + paragraphText(frame).length;
  model.select(start);
  // Only declare what differs, so an unindented paragraph gains no w:ind.
  const current = paragraphFormat(frame, model.numbering);
  model.setParagraphFormat(Object.fromEntries(Object.entries({ lineRule: 'exact', lineSpacing: height, spaceBefore: 0, spaceAfter: 0, keepNext: true,
    indentLeft: 0, indentRight: 0, firstLine: 0, alignment: 'left' }).filter(([key, value]) => current[key] !== value)));
  model.select(start, end);
  model.setRunFormat({ fontSize: capSize, baselineShift: -lowering,
    ...(fontFamily ? { fontAscii: fontFamily, fontHAnsi: fontFamily, fontEastAsia: fontFamily, fontCs: fontFamily } : {}) });
  model.select(anchor, focus);
}

// Merge the cap back into its text paragraph, keeping that paragraph's properties.
function removeCap(model, index) {
  const frame = model.paragraphs[index], next = model.paragraphs[index + 1];
  const start = paragraphStart(model, index), letter = paragraphText(frame), caret = model.selection.focus;
  if (!next || next.cellId || capMode(next) || frame.sectionEnd) {
    // No text paragraph to rejoin: keep the text as an ordinary paragraph.
    if (frame.styleContext) { delete frame.styleContext.properties.frameProperties; resolveStyledParagraph(frame, model.styles, model.numbering); }
    else delete frame.frameProperties;
    frame.framePropertiesChanged = true;
    return;
  }
  // A paragraph merge keeps the first paragraph's properties, so the frame
  // paragraph first takes the text paragraph's properties (its own text-bound
  // runs, bookmarks and fields stay). The cap letter takes the text's run format.
  const base = next.runs.find(plainRun), runs = base && frame.runs.every(plainRun) ? [{ ...copy(base), text: letter }] : frame.runs;
  if (runs !== frame.runs) delete runs[0].revision;
  const replacement = { ...copy(next), id: frame.id, runs };
  for (const key of ['bookmarks', 'fieldMarkers']) { if (frame[key]) replacement[key] = frame[key]; else delete replacement[key]; }
  model.paragraphs[index] = replacement;
  model.select(start + letter.length, start + letter.length + 1);
  if (!model.replace('')) throw new Error('The drop cap could not be removed.');
  model.select(caret > start + letter.length ? caret - 1 : caret);
}
