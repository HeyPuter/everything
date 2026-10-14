import { locate, paragraphText, RUN_FORMAT, PARAGRAPH_FORMAT, runFormat } from './model.js';
import { effectiveStyleId, resolveCharacterRun, resolveStyledParagraph, paragraphRunStyle } from './styles.js';
import { clearedRun, clearParagraph } from './direct-formatting.js';

/**
 * Home tab editing commands that work on the canvas model through its own
 * operations: Change Case, Format Painter and Sort. Each mutates only text, run/paragraph formatting or
 * paragraph order, so serialization and layout stay unchanged.
 */

/** The word around a caret, as a command with no selection acts on it; null between words. */
export function wordAt(text, position) {
  const words = new Intl.Segmenter(undefined, { granularity: 'word' });
  for (const s of words.segment(text)) {
    const end = s.index + s.segment.length;
    if (s.isWordLike && s.index <= position && position <= end) return [s.index, end];
    if (s.index > position) break;
  }
  return null;
}

const objectRun = run => run.image || run.field || run.noteMark || run.bodySymbol || run.contentControl?.picture;
const isUpper = text => text === text.toLocaleUpperCase() && text !== text.toLocaleLowerCase();
const isLower = text => text === text.toLocaleLowerCase() && text !== text.toLocaleUpperCase();

/** Shift+F3 cycles lowercase → Capitalize Each Word → UPPERCASE → lowercase. */
export function nextCycleCase(text) {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (!letters || isUpper(letters)) return 'lower';
  return isLower(letters) ? 'title' : 'upper';
}

/**
 * Case-converted text with the same length as the source, so run boundaries and positions stay put. A
 * character whose conversion changes length (ß → SS) keeps its original form.
 */
export function convertCase(text, mode, sentenceStart = true) {
  const chars = [...text];
  let start = sentenceStart, wordStart = true;
  return chars.map(ch => {
    const letter = /\p{L}/u.test(ch);
    let out = ch;
    if (letter) {
      const upper = ch.toLocaleUpperCase(), lower = ch.toLocaleLowerCase();
      if (mode === 'upper') out = upper;
      else if (mode === 'lower') out = lower;
      else if (mode === 'toggle') out = ch === upper ? lower : upper;
      else if (mode === 'title') out = wordStart ? upper : lower;
      else if (mode === 'sentence') out = start ? upper : lower;
      if (out.length !== ch.length) out = ch;
      start = false;
    }
    if (mode === 'sentence' && /[.!?\n\f\v]/.test(ch)) start = true;
    wordStart = !(letter || /[\p{N}'’]/u.test(ch));
    return out;
  }).join('');
}

/** Whether the text before a position ends a sentence, so Sentence case capitalizes the first letter. */
function sentenceStartsAt(text, position) {
  const before = text.slice(0, position).replace(/[\s"'“‘(\[]+$/u, '');
  return !before || /[.!?\n\f\v]$/.test(before);
}

/**
 * Change the case of the selection, or of the word at the caret. Formatting, links, fields and pictures are
 * kept: only letters within ordinary text runs change. Returns whether the text changed.
 */
export function changeCase(model, mode) {
  let [start, end] = model.range;
  const text = model.text;
  if (start === end) {
    const word = wordAt(text, start);
    if (!word) return false;
    [start, end] = word;
  }
  if (mode === 'cycle') mode = nextCycleCase(text.slice(start, end));
  const converted = convertCase(text.slice(start, end), mode, sentenceStartsAt(text, start));
  if (converted === text.slice(start, end)) return false;
  const changes = [];
  let at = 0;
  for (const p of model.paragraphs) {
    p.runs.forEach((run, index) => {
      const a = Math.max(start, at), b = Math.min(end, at + run.text.length);
      if (a < b && !objectRun(run)) {
        const next = run.text.slice(0, a - at) + converted.slice(a - start, b - start) + run.text.slice(b - at);
        if (next !== run.text) changes.push([p, index, next]);
      }
      at += run.text.length;
    });
    at++;
  }
  if (!changes.length) return false;
  model.checkpoint();
  for (const [p, index, next] of changes) p.runs[index] = { ...p.runs[index], text: next };
  const { anchor, focus } = model.selection;
  model.didChange();
  model.select(anchor, focus);
  return true;
}

const runKeys = Object.keys(RUN_FORMAT).filter(key => !['cs', 'rtl'].includes(key));
const paragraphKeys = Object.keys(PARAGRAPH_FORMAT).filter(key => key !== 'outlineLevel');
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const copy = value => structuredClone(value);

/**
 * Direct formatting as it appears: the resolved values that differ from what the styles alone give. This
 * covers imported declarations and in-editor edits alike, however each is stored.
 */
export function directRun(model, run, p) {
  const baseline = clearedRun(run);
  if (model.stylesEnabled) resolveCharacterRun(baseline, model.styles, paragraphRunStyle(p, model.styles));
  const source = runFormat(run), plain = runFormat(baseline);
  return Object.fromEntries(runKeys.filter(key => !same(source[key], plain[key]) && source[key] !== null && source[key] !== undefined).map(key => [key, copy(source[key])]));
}
export function directParagraph(model, p) {
  const baseline = copy(p);
  clearParagraph(baseline);
  if (model.stylesEnabled) resolveStyledParagraph(baseline, model.styles, model.numbering);
  const source = { ...PARAGRAPH_FORMAT, ...p.format }, plain = { ...PARAGRAPH_FORMAT, ...baseline.format };
  return Object.fromEntries(paragraphKeys.filter(key => !same(source[key], plain[key])).map(key => [key, copy(source[key])]));
}

/**
 * The formatting Format Painter copies: the character style and direct character formatting of the
 * selection's first character, plus — when the selection is a caret or covers whole paragraphs — the
 * paragraph style and direct paragraph formatting.
 */
export function captureFormat(model) {
  const [start, end] = model.range;
  const { index, offset } = locate(model.paragraphs, start), p = model.paragraphs[index];
  const run = model.formatAt(start, start === end ? 'backward' : 'forward');
  // A caret, a whole paragraph or a selection that takes in the paragraph mark carries the paragraph's formatting too.
  const wholeParagraph = start === end || offset === 0 && end - start >= paragraphText(p).length || end > start - offset + paragraphText(p).length;
  return {
    characterStyle: model.stylesEnabled ? run.styleId || '' : null,
    run: directRun(model, run, p),
    paragraph: wholeParagraph ? { styleId: model.stylesEnabled ? effectiveStyleId(p, model.styles) || '' : null, format: directParagraph(model, p) } : null,
  };
}

// Each property applies on its own: one the target cannot take (a page break in a table cell) is skipped
// without losing the rest. Validation runs before any change, so a refused property leaves no trace.
function applyEach(patch, apply) {
  for (const [key, value] of Object.entries(patch)) { try { apply({ [key]: value }); } catch { /* not applicable here */ } }
}

/**
 * Paint captured formatting onto the selection, or the word at the caret. Runs inside one engine
 * transaction, so the whole change is a single undo step.
 */
export function applyFormat(model, captured) {
  let [start, end] = model.range;
  if (start === end) {
    const word = wordAt(model.text, start);
    if (!word && !captured.paragraph) return false;
    if (word) { [start, end] = word; model.select(start, end); }
  }
  const before = model.revision;
  if (start !== end) {
    const style = captured.characterStyle;
    if (style === '' || style && model.styles.definitions[style]?.type === 'character') model.setCharacterStyle(style);
    model.clearDirectTextFormatting();
    applyEach(captured.run, patch => model.setRunFormat(patch));
  }
  if (captured.paragraph) {
    const { styleId, format } = captured.paragraph;
    if (styleId === '' || styleId && model.styles.definitions[styleId]?.type === 'paragraph') model.setParagraphStyle(styleId);
    model.clearDirectParagraphFormatting();
    applyEach(format, patch => model.setParagraphFormat(patch));
  }
  return model.revision !== before;
}

const SORT_TYPES = ['text', 'number', 'date'];
function sortKey(text, type) {
  const value = text.trim();
  if (type === 'number') {
    const match = /[-+]?\d[\d,]*(?:\.\d+)?|[-+]?\.\d+/.exec(value);
    return match ? Number(match[0].replace(/,/g, '')) : null;
  }
  if (type === 'date') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return value;
}

/**
 * Sort the selected paragraphs by their text. Paragraphs
 * without a key (empty, or no number/date for those types) go first when ascending.
 * Only body paragraphs outside tables, section breaks and content controls can be reordered.
 */
export function sortParagraphs(model, { type = 'text', descending = false, caseSensitive = false } = {}) {
  if (!SORT_TYPES.includes(type)) throw new Error('Choose Text, Number or Date.');
  const targets = model.selectedParagraphs;
  if (targets.length < 2) throw new Error('Select two or more paragraphs to sort.');
  if (targets.some(p => p.cellId)) throw new Error('Sorting table rows is not supported yet. Select paragraphs outside a table.');
  if (targets.some(p => p.sectionEnd || p.blockControls?.length || p.frame || p.fieldMarkers?.length)) throw new Error('These paragraphs contain a section break, content control, frame or field and cannot be reordered.');
  const first = model.paragraphs.indexOf(targets[0]);
  if (targets.some((p, i) => model.paragraphs[first + i] !== p)) throw new Error('Select adjacent paragraphs to sort.');
  // The final paragraph of a document sorts like any other; a trailing empty paragraph stays last.
  const collator = new Intl.Collator(undefined, { sensitivity: caseSensitive ? 'case' : 'base', numeric: true });
  const keyed = targets.map((p, index) => ({ p, index, key: sortKey(paragraphText(p), type) }));
  const compare = (a, b) => {
    if (a.key === null || a.key === '') return b.key === null || b.key === '' ? a.index - b.index : -1;
    if (b.key === null || b.key === '') return 1;
    const order = type === 'text' ? collator.compare(a.key, b.key) || (caseSensitive ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : 0) : a.key - b.key;
    return (descending ? -order : order) || a.index - b.index;
  };
  const sorted = [...keyed].sort(compare).map(item => item.p);
  if (sorted.every((p, i) => p === targets[i])) return false;
  model.checkpoint();
  model.paragraphs.splice(first, targets.length, ...sorted);
  model.didChange();
  const start = model.paragraphOffset(first), last = first + targets.length - 1;
  model.select(start, model.paragraphOffset(last) + paragraphText(model.paragraphs[last]).length);
  return true;
}

/**
 * Alt+Shift+Up/Down: move the selected paragraphs above the previous paragraph or below the next one,
 * keeping the selection on them. Only body paragraphs outside tables move, and they do not cross a
 * table, section break, content control or frame.
 */
export function moveParagraphs(model, direction) {
  const targets = model.selectedParagraphs, first = model.paragraphs.indexOf(targets[0]), last = first + targets.length - 1;
  const neighbour = model.paragraphs[direction < 0 ? first - 1 : last + 1];
  const movable = p => p && !p.cellId && !p.sectionEnd && !p.blockControls?.length && !p.frame;
  if (!neighbour || !targets.every(movable) || !movable(neighbour)) return false;
  // The document's final paragraph mark stays last: moving into the last place keeps it.
  if (direction > 0 && last + 1 === model.paragraphs.length - 1 && !paragraphText(neighbour).length) return false;
  const [anchor, focus] = [model.selection.anchor, model.selection.focus];
  const shift = (paragraphText(neighbour).length + 1) * (direction < 0 ? -1 : 1);
  model.checkpoint();
  if (direction < 0) model.paragraphs.splice(first - 1, targets.length + 1, ...targets, neighbour);
  else model.paragraphs.splice(first, targets.length + 1, neighbour, ...targets);
  model.didChange();
  model.select(anchor + shift, focus + shift);
  return true;
}
