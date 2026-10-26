import { normalizeTabStops } from './paragraph-geometry.js';
import { applyLevelParagraph } from './numbering-paragraph.js';

export const emptyNumbering = () => ({ abstracts: {}, instances: {} });
export const NUMBER_FORMATS = ['bullet', 'decimal', 'decimalZero', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman', 'none'];
export class NumberingDefinitionError extends Error {}
export function levelFor(numbering, list) {
  const instance = numbering?.instances[list.numId], abstract = numbering?.abstracts[instance?.abstractId];
  if (!instance || !abstract) throw new NumberingDefinitionError('The list references a missing numbering definition.');
  if (instance.error || abstract.error) throw new NumberingDefinitionError(instance.error || abstract.error);
  const override = instance.overrides?.[list.level];
  const level = override?.level || abstract.levels[list.level];
  if (!level) throw new NumberingDefinitionError(`Numbering level ${list.level + 1} is missing.`);
  if (level.error) throw new NumberingDefinitionError(level.error);
  return { ...level, start: override?.start ?? level.start };
}
// A reference to a numbering instance, or an instance's abstract definition, that the numbering part
// does not contain leaves the paragraph unnumbered, as Word shows it. Its numPr stays in the source.
// A definition that is present but could not be read is not missing: levelFor reports its error.
export function hasNumberingDefinition(numbering, numId) {
  const instance = numbering && Object.hasOwn(numbering.instances, numId) ? numbering.instances[numId] : null;
  return !!instance && (!!instance.error || Object.hasOwn(numbering.abstracts, instance.abstractId));
}
export const listKind = (numbering, list) => list ? levelFor(numbering, list).format === 'bullet' ? 'bullet' : 'number' : null;

export function mergeGeometry(base, patch = {}) {
  const result = { ...base, ...patch };
  if (patch.tabs) {
    const tabs = new Map((base.tabs || []).map(t => [t.position, t]));
    for (const tab of patch.tabs) {
      if (tab.alignment === 'clear') tabs.delete(tab.position); else tabs.set(tab.position, tab);
    }
    result.tabs = normalizeTabStops([...tabs.values()]);
  }
  return result;
}
export function listGeometry(p, numbering, plain) {
  // A style binding can suppress the marker while retaining the level's
  // paragraph geometry. This is distinct from explicit numId=0 cancellation.
  const context = p.listContext, list = p.list || context?.inactiveList;
  if (!list) return plain;
  const level = levelFor(numbering, list);
  // The level's paragraph geometry is discarded when lvlText references a
  // deeper level. Paragraph/style geometry and the stored OOXML remain intact.
  if (referencesDeeperLevel(level, list.level)) return mergeGeometry(plain, {
    tabs: plain.tabs.some(t => t.position === 360) ? [] : [{ position: 360, alignment: 'left', numberingOnly: true }],
  });
  let geometry = context?.base || { indentLeft: plain.indentLeft, indentRight: plain.indentRight, firstLine: plain.firstLine, tabs: plain.tabs, contextualSpacing: plain.contextualSpacing };
  // Direct numbering follows paragraph styles (§17.7.2).
  for (const patch of list.direct ? [context?.style, level.geometry] : [level.geometry, context?.style]) geometry = mergeGeometry(geometry, patch);
  // Inherited list indents resolve at the style declaring numId: the
  // level overrides ancestors, while that style and its descendants win.
  // Tabs and contextual spacing keep their separate style hierarchy behavior.
  if (!list.direct && context?.afterNumbering) for (const key of ['indentLeft', 'indentRight', 'firstLine']) {
    const value = context.afterNumbering[key] ?? level.geometry[key];
    if (value !== undefined) geometry[key] = value;
  }
  geometry = mergeGeometry(geometry, context?.direct);
  const result = { ...plain, ...geometry };
  for (const key of ['indentLeft', 'indentRight', 'firstLine', 'tabs', 'contextualSpacing']) if (key in (p.formatOverrides || {})) result[key] = p.formatOverrides[key];
  // The level's other paragraph properties (spacing, alignment, borders…) take
  // the same place in the cascade as its indents.
  return applyLevelParagraph(result, level.paragraph, context?.paragraph, list.direct, p.formatOverrides);
}

function numeral(value, format) {
  if (format === 'none') return '';
  if (format === 'decimalZero') return String(value).padStart(2, '0');
  if (/Letter$/.test(format)) {
    // OOXML alphabetic numbering repeats letters after Z: AA, BB, ... (§17.18.59).
    if (value < 1) return String(value);
    const letter = String.fromCharCode(65 + (value - 1) % 26).repeat(Math.floor((value - 1) / 26) + 1);
    if (letter.length > 128) throw new Error('This alphabetic list number is too long for the preview.');
    return format === 'lowerLetter' ? letter.toLowerCase() : letter;
  }
  if (/Roman$/.test(format)) {
    if (value < 1 || value > 3999) throw new Error('Roman list numbers must be between 1 and 3999 in this preview.');
    let text = '';
    for (const [n, token] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (value >= n) { text += token; value -= n; }
    return format === 'lowerRoman' ? text.toLowerCase() : text;
  }
  return String(value);
}

function referencesDeeperLevel(level, index) {
  for (const match of level.text.matchAll(/%([1-9])/g)) if (Number(match[1]) - 1 > index) return true;
  return false;
}

/** Counters are a projection of document order, never edits to source text. */
export function listMarkers(paragraphs, numbering, onError = null) {
  const counters = new Map(), encountered = new Set();
  return paragraphs.map(p => {
    if (!p.list) return null;
    // An empty section-break paragraph is not a visible list item and
    // does not advance the numbering instance. Retain its stored declaration.
    if (p.sectionEnd && !p.fieldMarkers?.length && !p.runs.some(r => r.text.length || r.image)) return null;
    const { numId, level: index } = p.list, level = levelFor(numbering, p.list);
    const instance = numbering.instances[numId], abstract = numbering.abstracts[instance.abstractId];
    // Instances of an abstract list share the running sequence.
    // A start override applies at the first paragraph using that instance, at
    // that paragraph's level; it does not reset unvisited ancestor levels.
    const state = counters.get(instance.abstractId) || { values: [], starts: [] };
    counters.set(instance.abstractId, state);
    const { values, starts } = state, initial = !encountered.has(numId);
    encountered.add(numId);
    const override = initial ? instance.overrides?.[index]?.start : undefined;
    values[index] = override ?? (values[index] === undefined ? starts[index] ?? level.start : values[index] + 1);
    if (!Number.isSafeInteger(values[index])) throw new Error('The list counter exceeds the supported range.');
    for (let deeper = index + 1; deeper < 9; deeper++) {
      const definition = instance.overrides?.[deeper]?.level || abstract.levels[deeper];
      // Unused unsupported levels remain retained, as before; validate them
      // only when a paragraph actually uses them.
      if (!definition || definition.error) continue;
      const restart = definition.restart === undefined || definition.restart > deeper ? deeper : definition.restart;
      if (restart && index < restart) {
        values[deeper] = undefined;
        // Initial entry and an ancestor-driven reset use different starts for
        // imported full overrides.
        starts[deeper] = instance.overrides?.[deeper]?.start ?? definition.restartStart ?? definition.start;
      }
    }
    // Literal text is retained for every format, including none and bullet.
    // A deeper-level reference suppresses the whole label (native compatibility
    // beyond the reference-only omission described by §17.9.11).
    const suppressed = referencesDeeperLevel(level, index);
    let text;
    try {
      text = suppressed ? '' : level.text.replace(/%([1-9])/g, (_, n) => {
        const i = Number(n) - 1;
        const referenced = levelFor(numbering, { numId, level: i });
        // These levels have no numeric representation, even under isLgl.
        if (['none', 'bullet'].includes(referenced.format) || referencesDeeperLevel(referenced, i)) return '';
        return numeral(values[i] ?? referenced.start, level.legal ? 'decimal' : referenced.format);
      });
    } catch (error) {
      if (!numbering.previewMarkerRecovery) throw error;
      // Keep the authored list and its advanced counter state. Only this
      // label is unavailable; unrelated lists and later items still render.
      onError?.(error, p);
      text = '';
    }
    return { text, level: suppressed ? { ...level, suffix: 'tab', alignment: 'left', legacy: undefined } : level, suppressed, counters: [...values] };
  });
}

const nextId = records => String(Object.keys(records).reduce((max, id) => Math.max(max, Number(id)), 0) + 1);
export function newList(numbering, kind) {
  const abstractId = nextId(numbering.abstracts), numId = nextId(numbering.instances);
  const levels = Array.from({ length: 9 }, (_, index) => ({
    start: 1, format: kind === 'bullet' ? 'bullet' : 'decimal', text: kind === 'bullet' ? ['•', '◦', '▪'][index % 3] : Array.from({ length: index + 1 }, (_, i) => `%${i + 1}`).join('.') + '.',
    alignment: 'left', suffix: 'tab', geometry: { indentLeft: (index + 1) * 720, firstLine: -360, tabs: [] }, markerStyle: {},
  }));
  numbering.abstracts[abstractId] = { levels, generated: true };
  numbering.instances[numId] = { abstractId, overrides: {}, generated: true };
  return numId;
}
export function restartList(numbering, list, start = 1, counters = []) {
  if (!Number.isInteger(start) || start < 0 || start > 1000000) throw new Error('List starts must be integers from 0 to 1000000.');
  levelFor(numbering, list);
  const numId = nextId(numbering.instances), source = numbering.instances[list.numId];
  const starts = { [list.level]: start };
  // A nested restart keeps its current ancestor labels even though it uses a
  // fresh instance whose ancestor paragraphs do not occur in this sequence.
  for (let index = 0; index < list.level; index++) if (counters[index] !== undefined) starts[index] = counters[index];
  const overrides = structuredClone(source.overrides);
  for (const [index, value] of Object.entries(starts)) overrides[index] = { ...overrides[index], start: value };
  numbering.instances[numId] = { ...structuredClone(source), generated: true, startChanges: { ...source.startChanges, ...starts }, overrides };

  return numId;
}
