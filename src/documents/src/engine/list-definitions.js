import { levelFor, listKind, newList, NUMBER_FORMATS, listMarkers } from './numbering.js';
import { checkedFontEdit } from './font-families.js';
import { validFontSize } from './font-size.js';
import { normalizeColor } from './colors.js';
import { validateIndent } from './paragraph-geometry.js';

/**
 * List definitions authored from the Bullets and Numbering dialogs: a new bullet or number format for the
 * selection's list level, list indents, the numbering value, continuing a previous list and whole
 * multilevel definitions. Each operation works on the model inside the caller's transaction and writes a
 * new generated numbering definition (§17.9.1 abstractNum, §17.9.15 num), so the original definitions in an
 * imported numbering part stay untouched and every change is one undo step.
 */

export const LIST_ALIGNMENTS = Object.freeze(['left', 'center', 'right']);
export const LIST_SUFFIXES = Object.freeze({ tab: 'Tab character', space: 'Space', nothing: 'Nothing' });
/** Number styles offered for new formats: the numeral formats the preview renders. */
export const NUMBER_STYLES = Object.freeze([['decimal', '1, 2, 3'], ['decimalZero', '01, 02, 03'], ['upperRoman', 'I, II, III'], ['lowerRoman', 'i, ii, iii'], ['upperLetter', 'A, B, C'], ['lowerLetter', 'a, b, c'], ['none', '(none)']]);

/** The list the selection is in when every selected paragraph shares one list and level, else null. */
export function selectedListLevel(model) {
  const lists = model.selectedParagraphs.map(p => p.list);
  if (!lists.length || !lists.every(Boolean) || lists.some(l => l.numId !== lists[0].numId || l.level !== lists[0].level)) return null;
  return lists[0];
}

/** The resolved level definition at the selection, or null outside a single list level. */
export function selectedLevelDefinition(model) {
  const list = selectedListLevel(model);
  if (!list) return null;
  try { return { list, kind: listKind(model.numbering, list), level: levelFor(model.numbering, list) }; } catch { return null; }
}

function checkedLevelPatch(patch) {
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'format') {
      if (!NUMBER_FORMATS.includes(value)) throw new Error('Choose a supported number style.');
      result.format = value;
    } else if (key === 'text') {
      if (typeof value !== 'string' || value.length > 64 || /[\u0000-\u001f]/.test(value)) throw new Error('Enter a list label of up to 64 characters.');
      result.text = value;
    } else if (key === 'start') {
      if (!Number.isInteger(value) || value < 0 || value > 32767) throw new Error('Start at a whole number from 0 to 32767.');
      result.start = value;
    } else if (key === 'alignment') {
      if (!LIST_ALIGNMENTS.includes(value)) throw new Error('Align the number left, centered or right.');
      result.alignment = value;
    } else if (key === 'suffix') {
      if (!Object.hasOwn(LIST_SUFFIXES, value)) throw new Error('Follow the number with a tab, a space or nothing.');
      result.suffix = value;
    } else if (key === 'markerStyle') {
      result.markerStyle = checkedMarkerStyle(value);
    } else if (key === 'geometry') {
      result.geometry = checkedGeometry(value);
    } else throw new Error('Unknown list level property.');
  }
  return result;
}

function checkedMarkerStyle(style) {
  const result = {};
  for (const [key, value] of Object.entries(style || {})) {
    if (['fontAscii', 'fontHAnsi', 'fontEastAsia', 'fontCs'].includes(key)) result[key] = checkedFontEdit(key, value);
    else if (key === 'fontSize') { if (!validFontSize(value)) throw new Error('Font size must be 1–1638 pt in half-point steps.'); result.fontSize = value; }
    else if (['bold', 'italic'].includes(key)) { if (typeof value !== 'boolean') throw new Error('Bold and italic must be on or off.'); result[key] = value; }
    else if (key === 'color') result.color = normalizeColor(value);
    else throw new Error('Unknown list label formatting.');
  }
  return result;
}

function checkedGeometry(geometry) {
  const result = {};
  for (const key of ['indentLeft', 'firstLine']) if (key in geometry) result[key] = validateIndent(geometry[key]);
  if ('tabs' in geometry) {
    if (!Array.isArray(geometry.tabs)) throw new Error('Invalid list tab stop.');
    result.tabs = geometry.tabs.map(t => ({ position: validateIndent(t.position), alignment: 'left', numberingOnly: true }));
  }
  return result;
}

// Only the label properties the dialogs author are checked; other imported declarations are kept as they are.
const pick = style => Object.fromEntries(Object.entries(style).filter(([key]) => ['fontAscii', 'fontHAnsi', 'fontSize', 'bold', 'italic', 'color'].includes(key)));
const writableLevel = level => {
  const copy = structuredClone(level);
  // Imported levels may carry declarations this copy does not own: a linked style, legacy spacing, a symbol font.
  for (const key of ['legacy', 'styleId', 'symbol', 'error']) delete copy[key];
  copy.markerStyle ||= {};
  copy.geometry ||= { tabs: [] };
  return copy;
};

/**
 * Give the selection's list (every paragraph of it) a new definition built by `edit(levels)`, or start a new
 * list of `kind` for the selected paragraphs when they are not in one list level. Returns whether it changed.
 */
export function redefineList(model, kind, edit, { startLevel = 0 } = {}) {
  const current = selectedListLevel(model);
  const numbering = structuredClone(model.numbering);
  const numId = newList(numbering, kind);
  const abstract = numbering.abstracts[numbering.instances[numId].abstractId];
  if (current) {
    for (let i = 0; i < 9; i++) {
      try { abstract.levels[i] = writableLevel(levelFor(model.numbering, { numId: current.numId, level: i })); } catch { /* keep the default level */ }
    }
  }
  // The edit validates what it sets (checkedLevelPatch) before anything changes.
  edit(abstract.levels, current?.level ?? startLevel);
  model.checkpoint();
  model.numbering = numbering;
  const targets = current ? model.paragraphs.filter(p => p.list?.numId === current.numId) : model.selectedParagraphs;
  for (const p of targets) {
    p.list = { numId, level: current ? p.list.level : startLevel, direct: true };
    p.listChanged = true;
  }
  model.didChange();
  return true;
}

/** Define New Bullet: a character (and optional symbol font) for the selection's list level. */
export function defineBullet(model, { character, font = null, color = null, alignment = 'left' } = {}) {
  if (typeof character !== 'string' || ![...character].length || [...character].length > 2 || /[\u0000-\u001f]/.test(character)) throw new Error('Choose one bullet character.');
  return redefineList(model, 'bullet', (levels, index) => {
    const markerStyle = { ...(levels[index].markerStyle || {}) };
    for (const key of ['fontAscii', 'fontHAnsi', 'fontEastAsia', 'fontCs']) delete markerStyle[key];
    if (font) Object.assign(markerStyle, { fontAscii: font, fontHAnsi: font });
    if (color) markerStyle.color = color; else delete markerStyle.color;
    levels[index] = { ...levels[index], ...checkedLevelPatch({ format: 'bullet', text: character, alignment, markerStyle: pick(markerStyle) }), markerStyle };
  });
}

/** Define New Number Format: number style, literal text around the number, start and alignment. */
export function defineNumberFormat(model, { format = 'decimal', before = '', after = '.', start = 1, alignment = 'left', font = null, bold = null, italic = null } = {}) {
  if (format === 'bullet') throw new Error('Use Define New Bullet for bullets.');
  for (const text of [before, after]) if (typeof text !== 'string' || /%/.test(text)) throw new Error('List text cannot contain a percent sign.');
  return redefineList(model, 'number', (levels, index) => {
    const markerStyle = { ...(levels[index].markerStyle || {}) };
    if (font) Object.assign(markerStyle, { fontAscii: font, fontHAnsi: font });
    if (bold !== null) markerStyle.bold = bold;
    if (italic !== null) markerStyle.italic = italic;
    levels[index] = { ...levels[index], ...checkedLevelPatch({ format, text: `${before}%${index + 1}${after}`, start, alignment, markerStyle: pick(markerStyle) }), markerStyle };
  });
}

/**
 * Adjust List Indents: where the number sits, where the text starts, what follows the number and an
 * optional tab stop. Positions are twips from the text margin.
 */
export function adjustListIndents(model, { numberPosition, textIndent, suffix = 'tab', tabStop = null } = {}) {
  if (!selectedListLevel(model)) throw new Error('Place the cursor in a list to adjust its indents.');
  const kind = listKind(model.numbering, selectedListLevel(model));
  validateIndent(numberPosition); validateIndent(textIndent);
  if (tabStop !== null) validateIndent(tabStop);
  return redefineList(model, kind, (levels, index) => {
    const geometry = checkedGeometry({ indentLeft: textIndent, firstLine: numberPosition - textIndent, tabs: tabStop === null ? [] : [{ position: tabStop }] });
    levels[index] = { ...levels[index], ...checkedLevelPatch({ suffix }), geometry: { ...levels[index].geometry, ...geometry } };
  });
}

/** Define New Multilevel List: per-level settings, applied to the selection's list or a new one. */
export function defineMultilevelList(model, levels) {
  if (!Array.isArray(levels) || levels.length !== 9) throw new Error('Define all nine list levels.');
  const kind = levels[0].format === 'bullet' ? 'bullet' : 'number';
  return redefineList(model, kind, target => {
    levels.forEach((level, i) => {
      const { geometry, markerStyle, ...rest } = level;
      target[i] = { ...target[i], ...checkedLevelPatch(rest), markerStyle: markerStyle ? checkedMarkerStyle(markerStyle) : target[i].markerStyle || {}, geometry: { ...target[i].geometry, ...(geometry ? checkedGeometry(geometry) : {}) } };
    });
  });
}

/** The value the selection's first list item shows, as a number, or null when it is not numbered. */
export function currentListValue(model) {
  const first = model.selectedParagraphs[0];
  if (!first?.list || listKind(model.numbering, first.list) !== 'number') return null;
  const marker = listMarkers(model.paragraphs, model.numbering)[model.paragraphs.indexOf(first)];
  return marker?.counters?.[first.list.level] ?? null;
}

/** The nearest earlier numbered list of a different instance that the selection could continue, or null. */
export function previousList(model) {
  const first = model.selectedParagraphs[0];
  if (!first?.list || listKind(model.numbering, first.list) !== 'number') return null;
  for (let i = model.paragraphs.indexOf(first) - 1; i >= 0; i--) {
    const p = model.paragraphs[i];
    if (p.cellId !== first.cellId || !p.list || p.list.numId === first.list.numId) continue;
    try { if (listKind(model.numbering, p.list) === 'number') return p.list; } catch { /* skip an unreadable list */ }
  }
  return null;
}

/** Continue Numbering: join the selection's list (from its first item onwards) to the previous numbered list. */
export function continueNumbering(model) {
  const first = model.selectedParagraphs[0], previous = previousList(model);
  if (!previous) return false;
  const original = { ...first.list };
  model.checkpoint();
  for (let i = model.paragraphs.indexOf(first); i < model.paragraphs.length; i++) {
    const p = model.paragraphs[i];
    if (!p.list || p.list.numId !== original.numId) break;
    if (p !== first && p.list.level < original.level) break;
    p.list = { ...p.list, numId: previous.numId, direct: true }; p.listChanged = true;
  }
  model.didChange();
  return true;
}
