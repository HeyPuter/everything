import { levelFor, listKind, newList } from './numbering.js';

/**
 * Bullet and Numbering Library choices: the marker for one list level. Choosing one changes that level
 * of the list the selection is in — every paragraph of that list — or starts a new list.
 * Bullets are Unicode characters rendered in the paragraph font, so they need no symbol font.
 */
export const BULLET_LIBRARY = Object.freeze([
  ['Filled round bullet', '•'], ['Hollow round bullet', '○'], ['Filled square bullet', '■'], ['Diamond bullet', '❖'],
  ['Arrow bullet', '➢'], ['Check mark bullet', '✓'], ['Dash bullet', '–'],
]);
export const NUMBER_LIBRARY = Object.freeze([
  ['1. 2. 3.', 'decimal', '.'], ['1) 2) 3)', 'decimal', ')'], ['I. II. III.', 'upperRoman', '.'], ['A. B. C.', 'upperLetter', '.'],
  ['a) b) c)', 'lowerLetter', ')'], ['a. b. c.', 'lowerLetter', '.'], ['i. ii. iii.', 'lowerRoman', '.'],
]);

/** The library entry a list level matches, or -1. */
export function libraryIndex(level, kind) {
  if (!level) return -1;
  if (kind === 'bullet') return level.format === 'bullet' ? BULLET_LIBRARY.findIndex(([, ch]) => ch === level.text) : -1;
  return NUMBER_LIBRARY.findIndex(([, format, suffix]) => level.format === format && /^%[1-9]$/.test(level.text.slice(0, -1)) && level.text.endsWith(suffix));
}

/** The level the selection's list markers are at, when they agree. */
function selectedList(model) {
  const lists = model.commandParagraphs.map(p => p.list);
  if (!lists.every(Boolean) || lists.some(l => l.numId !== lists[0].numId || l.level !== lists[0].level)) return null;
  return lists[0];
}

/**
 * Apply library entry `index` of `kind` ('bullet' or 'number'). Returns whether anything changed.
 */
export function applyListLibrary(model, kind, index) {
  const entry = (kind === 'bullet' ? BULLET_LIBRARY : NUMBER_LIBRARY)[index];
  if (!entry) throw new Error('Choose a list style.');
  const current = selectedList(model), currentKind = current && listKind(model.numbering, current);
  const levelIndex = current?.level ?? 0;
  const marker = level => kind === 'bullet'
    ? { ...level, format: 'bullet', text: entry[1], markerStyle: {} }
    : { ...level, format: entry[1], text: `%${levelIndex + 1}${entry[2]}`, markerStyle: {} };
  if (current && currentKind && libraryIndex(levelFor(model.numbering, current), kind) === index && currentKind === kind) return false;
  model.checkpoint();
  // A new definition keeps the list's other levels; the chosen level gets the new marker.
  const numId = newList(model.numbering, kind);
  const instance = model.numbering.instances[numId], abstract = model.numbering.abstracts[instance.abstractId];
  if (current && currentKind) {
    for (let i = 0; i < 9; i++) {
      // Imported levels may carry declarations this copy does not own: a linked style, legacy spacing, a symbol font.
      try {
        const level = structuredClone(levelFor(model.numbering, { numId: current.numId, level: i }));
        for (const key of ['legacy', 'styleId', 'symbol', 'error']) delete level[key];
        abstract.levels[i] = level;
      } catch { /* keep the default level */ }
    }
  }
  abstract.levels[levelIndex] = marker(abstract.levels[levelIndex]);
  const targets = current && currentKind ? model.paragraphs.filter(p => p.list?.numId === current.numId) : model.commandParagraphs;
  for (const p of targets) {
    p.list = { numId, level: p.list?.numId === current?.numId && current ? p.list.level : levelIndex, direct: true };
    p.listChanged = true;
  }
  model.didChange();
  return true;
}

/** Multilevel List library: [name, (levelIndex) → { format, text }]. Indents follow the default list geometry. */
export const MULTILEVEL_LIBRARY = Object.freeze([
  ['1. 1.1. 1.1.1.', i => ({ format: 'decimal', text: Array.from({ length: i + 1 }, (_, n) => `%${n + 1}`).join('.') + '.' })],
  ['1) a) i)', i => [{ format: 'decimal', text: '%1)' }, { format: 'lowerLetter', text: '%2)' }, { format: 'lowerRoman', text: '%3)' }][i % 3]],
  ['I. A. 1. a)', i => [{ format: 'upperRoman', text: '%1.' }, { format: 'upperLetter', text: '%2.' }, { format: 'decimal', text: '%3.' }, { format: 'lowerLetter', text: '%4)' }, { format: 'lowerRoman', text: '%5)' }][Math.min(i, 4)]],
  ['• ○ ■', i => ({ format: 'bullet', text: ['•', '○', '■'][i % 3] })],
]);

/** Apply a multilevel definition to the selection's list (every paragraph of it, keeping levels), or start one. */
export function applyMultilevelList(model, index) {
  const entry = MULTILEVEL_LIBRARY[index];
  if (!entry) throw new Error('Choose a multilevel list.');
  const current = selectedList(model), kind = entry[1](0).format === 'bullet' ? 'bullet' : 'number';
  model.checkpoint();
  const numId = newList(model.numbering, kind);
  const abstract = model.numbering.abstracts[model.numbering.instances[numId].abstractId];
  abstract.levels = abstract.levels.map((level, i) => ({ ...level, ...entry[1](i), markerStyle: {} }));
  const targets = current ? model.paragraphs.filter(p => p.list?.numId === current.numId) : model.commandParagraphs;
  for (const p of targets) { p.list = { numId, level: current ? p.list.level : 0, direct: true }; p.listChanged = true; }
  model.didChange();
  return true;
}
