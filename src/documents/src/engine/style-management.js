import { paragraphText } from './model.js';
import { effectiveStyleId, resolveStyledParagraph, editedStyle } from './styles.js';
import { builtinOutlineLevel } from './outline.js';
import { directRun, directParagraph } from './home-editing.js';

/**
 * Styles pane operations on the model: which styles are in use, where, deleting a style, and creating a
 * style from the selection's formatting. Each mutation is one model transaction; deleted definitions are
 * recorded in styles.deleted so the DOCX writer removes them (§17.7.4.17) while every other style keeps
 * its original XML.
 */

/** How many paragraphs (paragraph styles) and runs (character styles) use each style. */
export function styleUsage(model) {
  const usage = new Map();
  const add = id => { if (id) usage.set(id, (usage.get(id) || 0) + 1); };
  for (const p of model.paragraphs) {
    add(effectiveStyleId(p, model.styles));
    for (const run of p.runs) if (run.text) add(run.styleId);
  }
  return usage;
}

/** The document ranges using a style: whole paragraphs for paragraph styles, runs for character styles. */
export function styleRanges(model, id) {
  const style = model.styles.definitions[id];
  if (!style) return [];
  const ranges = []; let at = 0;
  for (const p of model.paragraphs) {
    const length = paragraphText(p).length;
    if (style.type === 'paragraph' && effectiveStyleId(p, model.styles) === id) ranges.push({ start: at, end: at + length });
    if (style.type === 'character') {
      let offset = at;
      for (const run of p.runs) {
        if (run.styleId === id && run.text) {
          const last = ranges.at(-1);
          if (last && last.end === offset) last.end += run.text.length; else ranges.push({ start: offset, end: offset + run.text.length });
        }
        offset += run.text.length;
      }
    }
    at += length + 1;
  }
  return ranges.filter(r => r.end > r.start || style.type === 'paragraph');
}

/** Why a style cannot be deleted, or null. */
export function styleDeletionBlocker(model, id) {
  const style = model.styles.definitions[id];
  if (!style) return 'This style no longer exists.';
  if (!['paragraph', 'character'].includes(style.type)) return 'Only paragraph and character styles can be deleted here.';
  if (id === model.styles.defaultParagraph || id === model.styles.defaultCharacter) return 'The default style cannot be deleted.';
  if (builtinOutlineLevel(id) !== null || /^(normal|title|subtitle)$/i.test(String(style.name || ''))) return 'Built-in styles cannot be deleted.';
  return null;
}

/**
 * Delete a paragraph or character style. Paragraphs using it return to the default paragraph style; text
 * using a character style keeps its direct formatting. Styles based on it inherit from its own base.
 */
export function deleteStyle(model, id) {
  const blocker = styleDeletionBlocker(model, id);
  if (blocker) throw new Error(blocker);
  const styles = structuredClone(model.styles), style = styles.definitions[id];
  for (const other of Object.values(styles.definitions)) {
    if (other.id === id || other.type !== style.type) continue;
    const patch = {};
    if (other.basedOn === id) patch.basedOn = style.basedOn || null;
    if (other.next === id) patch.next = null;
    if (Object.keys(patch).length) styles.definitions[other.id] = editedStyle({ ...styles, definitions: { ...styles.definitions } }, other.id, patch, other.type);
  }
  delete styles.definitions[id];
  styles.deleted = [...new Set([...(styles.deleted || []), id])];
  const paragraphs = model.paragraphs.map(p => {
    const usesParagraph = style.type === 'paragraph' && p.styleId === id;
    const usesCharacter = style.type === 'character' && (p.runs.some(r => r.styleId === id) || p.markStyleId === id);
    if (!usesParagraph && !usesCharacter) return p;
    const next = structuredClone(p);
    if (usesParagraph) { next.styleId = styles.defaultParagraph || null; next.styleChanged = true; }
    if (usesCharacter) {
      for (const run of next.runs) if (run.styleId === id) { run.styleId = null; run.styleChanged = true; }
      if (next.markStyleId === id) { next.markStyleId = null; next.markStyleChanged = true; }
    }
    return next;
  });
  // Resolve everything against the new definitions: a derived style's look may change with its base.
  for (const p of paragraphs) resolveStyledParagraph(p, styles, model.numbering);
  model.checkpoint();
  model.styles = styles; model.paragraphs = paragraphs; model.stylesEnabled = true;
  model.didChange();
  return true;
}

/**
 * New Style from Formatting: a paragraph style based on the selection's style that captures the first
 * selected paragraph's direct paragraph and text formatting, then applied to the selection.
 */
export function createStyleFromSelection(model, name, { type = 'paragraph', basedOn = undefined, next = undefined } = {}) {
  const p = model.selectedParagraphs[0];
  const run = model.formatAt(model.range[0], model.range[0] === model.range[1] ? 'backward' : 'forward');
  const runPatch = directRun(model, run, p);
  for (const key of ['cs', 'rtl', 'boldCs', 'italicCs', 'fontSizeCs', 'highlight', 'textFill', 'textOutline', 'ligatures']) delete runPatch[key];
  if (type === 'character') {
    if (!model.createCharacterStyle(name, basedOn ?? (model.characterStyle || ''))) return false;
    const id = model.characterStyle;
    if (Object.keys(runPatch).length) model.editCharacterStyle(id, { run: runPatch });
    return id;
  }
  const paragraphPatch = directParagraph(model, p);
  for (const key of ['tabs', 'paragraphBorders']) delete paragraphPatch[key];
  if (!model.createParagraphStyle(name, basedOn ?? (model.paragraphStyle || ''))) return false;
  const id = model.paragraphStyle;
  const patch = { ...(Object.keys(paragraphPatch).length ? { paragraph: paragraphPatch } : {}), ...(Object.keys(runPatch).length ? { run: runPatch } : {}), ...(next !== undefined ? { next } : {}) };
  if (Object.keys(patch).length) model.editParagraphStyle(id, patch);
  return id;
}
