import { checkedTextShadow } from './text-shadow.js';
import { checkedText3d } from './text-3d.js';
import { FONT_DEFAULTS, FONT_SLOTS, checkedFontEdit } from './font-families.js';
import { BORDER_SIDES, checkedParagraphBorders } from './paragraph-borders.js';
import { checkedUnderline, underlineDeclaration } from './underlines.js';
import { checkedCapitalization, resolveCapitalization, checkCapitalizationText, capitalizationDeclarations } from './capitalization.js';
import { checkedStrike, resolveStrike, strikeDeclarations } from './strikethrough.js';
import { checkedLigatures } from './ligatures.js';
import { checkedKerning } from './kerning.js';
import { checkedTextScale } from './text-scale.js';
import { checkedCharacterSpacing } from './character-spacing.js';
import { checkedShading } from './backgrounds.js';
import { checkedVerticalAlign, checkedBaselineShift } from './vertical-align.js';
import { normalizeColor } from './colors.js';
import { PARAGRAPH_FORMAT, RUN_FORMAT, resolvedFormat, geometryPatch, checkedRunFormat, clearAutomaticSpacing } from './formatting.js';
import { levelFor, NumberingDefinitionError, hasNumberingDefinition } from './numbering.js';
import { levelParagraphPatch } from './numbering-paragraph.js';
import { builtinOutlineLevel } from './outline.js';
import { mergeSpacing, checkedLineSpacing } from './line-spacing.js';
import { conditionalStyleGroups } from './table-style-regions.js';

// Style definitions and declarations are plain data; resolution never reads XML.
export const emptyStyles = () => ({ definitions: {}, defaults: { properties: { spacing: { after: '180', line: '240', lineRule: 'auto' } }, run: { ...RUN_FORMAT }, reference: {} }, defaultParagraph: null, defaultCharacter: null });
export function styleChain(styles, id, type = 'paragraph') {
  const chain = [], seen = new Set();
  while (id && styles.definitions[id]?.type === type) {
    if (seen.has(id)) throw new Error('Cyclic style inheritance is not supported.');
    seen.add(id);
    const style = styles.definitions[id];
    if (style.error) throw new Error(style.error);
    chain.unshift(style); id = style.basedOn;
  }
  return chain;
}
export function mergeProperties(base = {}, patch = {}) {
  const ind = { ...base.ind };
  for (const pair of [['firstLine', 'hanging'], ['firstLineChars', 'hangingChars']]) {
    if (pair.some(key => key in (patch.ind || {}))) for (const key of pair) delete ind[key];
  }
  const changes = new Map((base.tabChanges || []).map(t => [t.position, t]));
  for (const tab of patch.tabChanges || []) changes.set(tab.position, tab);
  const tabChanges = [...changes.values()];
  return { ...base, ...patch, paragraphBorders: { ...base.paragraphBorders, ...patch.paragraphBorders }, ind: { ...ind, ...patch.ind }, spacing: mergeSpacing(base.spacing, patch.spacing), tabChanges, tabs: tabChanges.filter(t => t.alignment !== 'clear') };
}
export function styleProperties(styles, id, base = styles.defaults.properties) {
  return styleChain(styles, id).reduce((p, s) => mergeProperties(cancelledIndent(p, s.reference), s.properties), base);
}
function cancelledIndent(properties, reference) {
  return reference?.numId === '0'
    ? { ...properties, ind: Object.fromEntries(Object.entries(properties.ind || {}).filter(([key]) => !['left', 'leftChars', 'firstLine', 'firstLineChars', 'hanging', 'hangingChars'].includes(key))) }
    : properties;
}
function withTableRegions(chain, regions = []) {
  return regions.length ? [...chain, ...conditionalStyleGroups(chain, regions).map(s => ({ properties: {}, reference: {}, run: {}, ...s }))] : chain;
}
export function styleRun(styles, id, inherited = styles.defaults.run, type = 'paragraph', regions = []) {
  const chain = withTableRegions(styleChain(styles, id, type), regions), properties = Object.assign({}, ...chain.map(s => underlineDeclaration(s.run)));
  const result = { ...inherited, ...properties };
  // MS-OI29500 §§2.1.246/2.1.258: table and paragraph declarations reset
  // toggle properties. Character declarations toggle relative to the document
  // default (§2.1.230); a missing declaration leaves the inherited value alone.
  // cs, rtl, webHidden and noProof are ordinary booleans, not §17.7.3 toggles.
  for (const key of ['bold', 'italic', 'boldCs', 'italicCs', 'vanish']) if (type === 'character' && key in properties) {
    result[key] = Boolean(inherited[key]) !== (properties[key] !== Boolean(styles.defaults.run[key]));
  }
  // Find the nearest declaration of each form; an off declaration of one
  // form must not erase a different form inherited through basedOn.
  const strikes = new Map();
  chain.forEach((s, index) => { if (s.run.strikethrough !== undefined) { checkedStrike(s.run.strikethrough, true); for (const value of strikeDeclarations(s.run.strikethrough)) strikes.set(value.startsWith('double') ? 'double' : 'single', { index, value }); } });
  const strikeOrder = [...strikes.values()].sort((a,b) => a.index - b.index);
  // Keep a pair declared at the same level simultaneous, as capitalization does.
  if (strikeOrder.length === 2 && strikeOrder[0].index === strikeOrder[1].index) strikeOrder.splice(0, 2, { value: chain[strikeOrder[0].index].run.strikethrough });
  result.strikethrough = strikeOrder.reduce((mode, declaration) => resolveStrike(mode, declaration.value, type === 'character', resolveStrike('none', styles.defaults.run.strikethrough)), resolveStrike('none', inherited.strikethrough));
  const capitals = new Map();
  chain.forEach((s, index) => { if (s.run.capitalization !== undefined) {
    checkedCapitalization(s.run.capitalization, true);
    for (const value of capitalizationDeclarations(s.run.capitalization)) capitals.set(value.startsWith('smallCaps') ? 'smallCaps' : 'caps', { index, value });
  } });
  const declarations = [...capitals.values()].sort((a,b) => a.index - b.index);
  // Keep a pair declared at the same level simultaneous, including toggles.
  if (declarations.length === 2 && declarations[0].index === declarations[1].index) declarations.splice(0, 2, { value: chain[declarations[0].index].run.capitalization });
  result.capitalization = declarations.reduce((mode, declaration) => resolveCapitalization(mode, declaration.value, type === 'character', resolveCapitalization('normal', styles.defaults.run.capitalization)), resolveCapitalization('normal', inherited.capitalization));
  return result;
}
export const effectiveStyleId = (p, styles) => !p.styleId ? styles.defaultParagraph : Object.hasOwn(styles.definitions, p.styleId) && styles.definitions[p.styleId].type === 'paragraph' ? p.styleId : null;
const directRun = (inherited, direct, overrides) => ({ ...inherited, ...underlineDeclaration(direct), ...underlineDeclaration(overrides), capitalization: resolveCapitalization(resolveCapitalization(inherited.capitalization, direct?.capitalization), overrides?.capitalization), strikethrough: resolveStrike(resolveStrike(inherited.strikethrough, direct?.strikethrough), overrides?.strikethrough), ...(overrides && 'underline' in overrides && !('underlineStyle' in overrides) ? { underlineColor: overrides.underlineColor ?? 'auto' } : {}) });

export function resolveCharacterRun(run, styles, inherited, options) {
  if (!run.styleManaged) {
    run.directFormat = Object.fromEntries(Object.keys(RUN_FORMAT).filter(k => k in run && run[k] !== RUN_FORMAT[k]).map(k => [k, run[k]]));
    run.styleManaged = true;
  }
  const id = !run.styleId ? styles.defaultCharacter : styles.definitions[run.styleId]?.type === 'character' ? run.styleId : null;
  let character = styleRun(styles, id, inherited, 'character');
  // The built-in Hyperlink style's non-font formatting is suppressed in a
  // cached TOC result. Its font family slots and direct run formatting survive.
  // The native toc-hyperlink-style control uses a noncanonical style ID and
  // contrasts the same style outside the TOC with a custom character style.
  if (run.tocHyperlink) character = { ...inherited, ...Object.fromEntries(Object.keys(FONT_SLOTS).map(key => [key, character[key]])) };
  Object.assign(run, checkedRunFormat(directRun(character, run.directFormat, run.overrides), options));
  // The document compatibility switch gates display, not the retained declaration.
  if (!styles.openTypeFeatures) run.ligatures = 'none';
  run.legacyKerning = !styles.openTypeFeatures;
  run.fontEastAsiaCharset = Object.hasOwn(styles.fontCharsets || {}, run.fontEastAsia) ? styles.fontCharsets[run.fontEastAsia] : '';
  checkCapitalizationText(run.text, run);
  if (run.image && options?.displayOnly && run.textScale !== 100) {
    // Keep an unsupported picture local to the read-only approximation. If
    // this escaped style resolution, one newly recognized drawing could make
    // the whole document fall back to unformatted text. The original package
    // remains untouched and the strict editable reader still rejects it.
    delete run.image; run.text = '';
  }
  if (run.image && run.textScale !== 100) throw new Error('Text width scaling on inline pictures is not supported.');
  // Drawing runs keep character spacing without adding it to the
  // picture advance. Adjacent text still inherits and applies the same spacing.
  // Drawings keep vertAlign without scaling or shifting them.
  return run;
}

export function paragraphRunStyle(p, styles) {
  const defaults = p.drawingRunDefaults ? { ...styles.defaults.run, ...p.drawingRunDefaults } : styles.defaults.run;
  // A document-default color is an explicit WordprocessingML declaration.
  // It precedes the shape fontRef fallback; a later w:color="auto" still
  // resolves to fontRef after the paragraph/character/direct cascade below.
  if (p.drawingRunDefaults && styles.defaults.run.color !== undefined) defaults.color = styles.defaults.run.color;
  const table = p.cellId ? styleRun(styles, p.tableStyleId, defaults, 'table', p.tableStyleRegions) : defaults;
  return styleRun(styles, effectiveStyleId(p, styles), table);
}
/**
 * The character unit of character-unit indents (§17.3.1.12), in twips: the East Asian font size of the
 * Normal style, as Word measures it (a full-width character is one em wide). Evaluated only when needed.
 */
export const characterUnit = styles => () => (styleRun(styles, styles.defaultParagraph).fontSize || 12) * 20;
export function resolveStyledParagraph(p, styles, numbering, options) {
  const tableChain = p.cellId ? withTableRegions(styleChain(styles, p.tableStyleId, 'table'), p.tableStyleRegions) : [];
  const base = tableChain.reduce((properties, s) => mergeProperties(properties, s.properties), styles.defaults.properties);
  const id = effectiveStyleId(p, styles), inherited = styleProperties(styles, id, base), inheritedRun = paragraphRunStyle(p, styles);
  if (!p.styleContext) {
    p.styleContext = { properties: {}, reference: {}, mark: {} };
    p.formatOverrides = { ...p.format, ...p.formatOverrides };
  }
  p.resolvedStyleId = id;
  p.resolvedStyleName = styles.definitions[id]?.name || null;
  const context = p.styleContext;
  // numId=0 resets inherited left/first-line indentation at its level
  // in the hierarchy. Right indentation and declarations at/after it survive.
  // Independent native controls: numbering-cancel-{indent,direct,style}.
  const inheritedGeometry = cancelledIndent(inherited, context.reference);
  const properties = mergeProperties(inheritedGeometry, context.properties);
  p.frameProperties = properties.frameProperties;
  const unit = characterUnit(styles), resolved = resolvedFormat(properties, unit);
  p.format = { ...resolved, ...p.formatOverrides, paragraphBorders: { ...resolved.paragraphBorders, ...p.formatOverrides?.paragraphBorders } };
  clearAutomaticSpacing(p.format, p.formatOverrides);
  // MS-OI29500 §2.1.51: a built-in heading's ID fixes its effective outline level.
  const fixedOutline = builtinOutlineLevel(id);
  if (fixedOutline !== null) p.format.outlineLevel = fixedOutline;
  p.markFormat = resolveCharacterRun({ styleId: p.markStyleId, styleManaged: true, directFormat: context.mark, overrides: p.markOverrides }, styles, inheritedRun, options);
  // Paragraph marks carry formatting and a reference, but no editable text run.
  p.markFormat = Object.fromEntries(Object.keys(RUN_FORMAT).map(key => [key, p.markFormat[key]]));
  p.markFormat.legacyKerning = !styles.openTypeFeatures;
  p.inheritedTabPositions = (inherited.tabs || []).map(t => t.position);
  const chain = styleChain(styles, id);
  // Numbering enters the hierarchy at the nearest style declaring numId.
  // Its geometry supersedes ancestors, but that style's own declarations and
  // its descendants still override the numbering level.
  const numberingIndex = chain.findLastIndex(s => s.reference?.numId !== undefined);
  const split = Math.max(0, numberingIndex);
  const chainGeometry = entries => geometryPatch(entries.reduce((properties, s) => mergeProperties(properties, s.properties), {}), false, unit);
  // Numbering levels' other paragraph properties resolve against the same three layers.
  const paragraph = { base: levelParagraphPatch(base), style: levelParagraphPatch(chain.reduce((properties, s) => mergeProperties(properties, s.properties), {})), direct: levelParagraphPatch(context.properties) };
  p.listContext = { base: geometryPatch(base, false, unit), style: chainGeometry(chain), afterNumbering: chainGeometry(chain.slice(split)), direct: geometryPatch(context.properties, false, unit), paragraph };
  if (!p.listChanged) {
    const inheritedReference = Object.assign({}, styles.defaults.reference, ...tableChain.map(s => s.reference), ...chain.map(s => s.reference));
    const ref = { ...inheritedReference, ...context.reference };
    p.list = null;
    try { if (ref.numId && ref.numId !== '0' && hasNumberingDefinition(numbering, ref.numId)) {
      const list = { numId: ref.numId, level: ref.level ?? 0, direct: !!context.numberingDirect };
      const definition = levelFor(numbering, list);
      const inheritedList = { ...list, level: inheritedReference.level ?? 0, direct: false };
      // An active reciprocal style binding owns the level for inherited
      // numbering. Stale pStyle links do not suppress another style, and a
      // paragraph's explicit numId always selects the list directly.
      let ownedElsewhere = false;
      if (context.reference?.numId === undefined) {
        const binding = inheritedList.level === list.level ? definition : levelFor(numbering, inheritedList);
        const ownerChain = binding.styleId && !chain.some(s => s.id === binding.styleId) ? styleChain(styles, binding.styleId) : [];
        const owner = Object.assign({}, ...ownerChain.map(s => s.reference));
        ownedElsewhere = owner.numId && owner.numId !== '0' &&
          numbering.instances[owner.numId]?.abstractId === numbering.instances[list.numId]?.abstractId &&
          (owner.level ?? 0) === inheritedList.level;
      }
      if (ownedElsewhere) p.listContext.inactiveList = inheritedList;
      else p.list = list;
    } } catch (error) {
      // Import reports the limitation once. Later display-only resolution can
      // retain that same approximation, but editing never receives permission.
      if (!options?.displayOnly || !(error instanceof NumberingDefinitionError) ||
        !options.onNumberingError && p.previewNumberingError !== error.message) throw error;
      p.list = null;
      delete p.listContext.inactiveList;
      p.previewNumberingError = error.message;
      options.onNumberingError?.(error);
    }
  }
  for (const run of p.runs) resolveCharacterRun(run, styles, inheritedRun, options);
  // In WPS text boxes w:color="auto" resolves against the shape's
  // fontRef color, independently of the fill. Resolve after the full cascade
  // so explicit paragraph/character/direct colors still win, and retain the
  // automatic declarations for serialization and later style resolution.
  if (p.drawingRunDefaults?.color) {
    for (const run of [p.markFormat, ...p.runs]) {
      if (run.color === 'auto') run.color = p.drawingRunDefaults.color;
    }
  }
  return p;
}

// An edited declaration remains distinct from inherited and direct formatting.
const spacingKeys = { spaceBefore: 'before', spaceAfter: 'after', lineRule: 'lineRule', lineSpacing: 'line' };
const indentKeys = { indentLeft: 'left', indentRight: 'right' };
export function editStyleProperties(properties, patch) {
  const p = structuredClone(properties || {}); p.ind ||= {}; p.spacing ||= {};
  const lineRule = Object.hasOwn(patch, 'lineRule') ? patch.lineRule === null ? 'auto' : patch.lineRule : p.spacing.lineRule ?? 'auto';
  if (!['auto', 'exact', 'atLeast'].includes(lineRule)) throw new Error('Choose multiple, exact or minimum line spacing.');
  const line = patch.lineSpacing == null ? null : checkedLineSpacing({ lineRule, lineSpacing: patch.lineSpacing });
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in PARAGRAPH_FORMAT)) throw new Error('Unknown style paragraph property.');
    if (value !== null) {
      if (key === 'paragraphBorders') {
        checkedParagraphBorders(value, true);
      } else if (key === 'paragraphShading') {
        checkedShading(value);
      } else if (key === 'outlineLevel') {
        if (!Number.isInteger(value) || value < 0 || value > 9) throw new Error('Choose an outline level from 1–9 or Body text.');
      } else if (key in indentKeys || key === 'firstLine') {
        if (!Number.isInteger(value) || Math.abs(value) > 31680) throw new Error('Style indents must be whole twips within 22 inches.');
      } else if (typeof PARAGRAPH_FORMAT[key] === 'boolean') {
        if (typeof value !== 'boolean') throw new Error('Style pagination must be on, off, or inherited.');
      } else if (['spaceBefore', 'spaceAfter', 'lineSpacing'].includes(key) && (!Number.isFinite(value) || value < 0 || value > 600)) throw new Error('Invalid style spacing.');
    }
    const set = (target, name, next = value) => { if (value === null) delete target[name]; else target[name] = next; };
    if (key === 'paragraphBorders') {
      if (value === null) delete p.paragraphBorders;
      else {
        p.paragraphBorders = { ...p.paragraphBorders };
        for (const [side, border] of Object.entries(checkedParagraphBorders(value, true))) {
          if (border === null) delete p.paragraphBorders[side]; else p.paragraphBorders[side] = border;
        }
      }
    } else if (key in spacingKeys) {
      set(p.spacing, spacingKeys[key], key === 'lineSpacing' ? line && String(Math.round(line.lineSpacing * (lineRule === 'auto' ? 240 : 20))) : key === 'lineRule' ? value : String(Math.round(value * 20)));
      if (['spaceBefore', 'spaceAfter'].includes(key)) for (const suffix of ['Lines', 'Autospacing']) set(p.spacing, spacingKeys[key] + suffix, '0');
    }
    // An edited indent is in twips; its character-unit form (§17.3.1.12) is zeroed so an inherited one cannot override it.
    else if (key in indentKeys) { set(p.ind, indentKeys[key]); set(p.ind, indentKeys[key] + 'Chars', 0); }
    else if (key === 'firstLine') { for (const name of ['firstLine', 'hanging', 'firstLineChars', 'hangingChars']) delete p.ind[name]; if (value !== null) { p.ind[value < 0 ? 'hanging' : 'firstLine'] = Math.abs(value); p.ind[value < 0 ? 'hangingChars' : 'firstLineChars'] = 0; } }
    else if (key === 'tabs') { if (value === null) { delete p.tabs; delete p.tabChanges; } else { p.tabs = value; p.tabChanges = value; } }
    else set(p, key, key === 'paragraphShading' && value !== null ? checkedShading(value) : value);
  }
  return p;
}
export function editedStyle(styles, id, patch, type = 'paragraph') {
  const previous = styles.definitions[id];
  if (!previous || previous.type !== type || !['paragraph', 'character'].includes(type)) throw new Error(`Choose a ${type} style.`);
  if (type === 'paragraph' && Object.hasOwn(patch.paragraph || {}, 'outlineLevel') && builtinOutlineLevel(id) !== null && patch.paragraph.outlineLevel !== builtinOutlineLevel(id)) throw new Error('Built-in heading styles have a fixed outline level. Use a custom paragraph style to change it.');
  const next = structuredClone(previous);
  for (const key of Object.keys(patch)) if (!(type === 'character' ? ['name', 'basedOn', 'run'] : ['name', 'basedOn', 'next', 'paragraph', 'run']).includes(key)) throw new Error('Unknown style property.');
  for (const key of ['name', 'basedOn', 'next']) if (key in patch) next[key] = patch[key];
  if (typeof next.name !== 'string' || !next.name.trim() || next.name.length > 253 || /[\u0000-\u001f]/.test(next.name)) throw new Error('Enter a style name of 1–253 characters.');
  next.name = next.name.trim();
  for (const key of ['basedOn', 'next']) if (key in patch && next[key] && styles.definitions[next[key]]?.type !== type) throw new Error(`Choose an existing ${type} style.`);
  if (type === 'paragraph') next.properties = editStyleProperties(next.properties, patch.paragraph || {});
  // The boolean alias keeps its historical single/none + automatic-color behavior.
  // Enum and color declarations can inherit independently, like w:u attributes.
  if ('underline' in (patch.run || {}) && !('underlineStyle' in patch.run)) patch = { ...patch, run: { ...patch.run, underlineColor: patch.run.underlineColor ?? (patch.run.underline === null ? null : 'auto') } };
  if (patch.run) patch = { ...patch, run: underlineDeclaration(patch.run, true) };
  next.run = { ...next.run };
  for (const [key, value] of Object.entries(patch.run || {})) {
    if (key === 'capitalization' && value === 'normal') throw new Error('Choose Caps off or Small caps off for a style declaration.');
    if (key === 'strikethrough' && value === 'none') throw new Error('Choose Single off or Double off for a style declaration.');
    if (key === 'highlight') throw new Error('Apply highlighting directly to text; named styles do not support it.');
    if (key === 'fontEastAsiaCharset') throw new Error('Font character sets come from the document font table.');
    if (!(key in RUN_FORMAT)) throw new Error('Unknown style text property.');
    if (value !== null && !Object.hasOwn(FONT_DEFAULTS, key) && !['text3d', 'textScene', 'textShadow', 'underlineStyle', 'capitalization', 'strikethrough', 'ligatures', 'kerning', 'textScale', 'characterSpacing', 'fontSize', 'fontSizeCs', 'color', 'underlineColor', 'shading', 'verticalAlign', 'baselineShift'].includes(key) && typeof value !== 'boolean') throw new Error('Style text formatting must be on, off, or inherited.');
    if (value === null) delete next.run[key]; else next.run[key] = Object.hasOwn(FONT_DEFAULTS, key) ? checkedFontEdit(key, value) : key === 'text3d' || key === 'textScene' ? checkedText3d(value, key) : key === 'textShadow' ? checkedTextShadow(value) : key === 'underlineStyle' ? checkedUnderline(value) : key === 'capitalization' ? checkedCapitalization(value, true) : key === 'strikethrough' ? checkedStrike(value, true) : key === 'ligatures' ? checkedLigatures(value) : key === 'kerning' ? checkedKerning(value) : key === 'textScale' ? checkedTextScale(value) : key === 'characterSpacing' ? checkedCharacterSpacing(value) : key === 'baselineShift' ? checkedBaselineShift(value) : key === 'verticalAlign' ? checkedVerticalAlign(value) : key === 'shading' ? checkedShading(value) : ['color', 'underlineColor'].includes(key) ? normalizeColor(value) : value;
    if (key === 'underline') delete next.run.underlineTheme;
  }
  next.changes = { ...next.changes, ...patch, paragraph: { ...next.changes?.paragraph, ...patch.paragraph }, run: { ...next.changes?.run, ...patch.run } };
  if (Object.hasOwn(patch.paragraph || {}, 'paragraphBorders')) {
    const previousBorders = previous.changes?.paragraph?.paragraphBorders, incoming = patch.paragraph.paragraphBorders;
    next.changes.paragraph.paragraphBorders = incoming === null ? null : { ...(previousBorders === null ? Object.fromEntries(BORDER_SIDES.map(side => [side, null])) : previousBorders), ...checkedParagraphBorders(incoming, true) };
  }
  const candidate = { ...styles, definitions: { ...styles.definitions, [id]: next } };
  if (type === 'paragraph') resolvedFormat(styleProperties(candidate, id), characterUnit(candidate));
  checkedRunFormat(styleRun(candidate, id, candidate.defaults.run, type));
  return next;
}
