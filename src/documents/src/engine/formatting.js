import { validFontSize } from './font-size.js';
import { checkedTextShadow } from './text-shadow.js';
import { checkedText3d } from './text-3d.js';
import { checkedTextFill } from './text-fill.js';
import { checkedTextOutline } from './text-outline.js';
import { FONT_DEFAULTS, checkedFontProperty } from './font-families.js';
import { checkedParagraphBorders } from './paragraph-borders.js';
import { underlinePattern } from './underlines.js';
import { checkedCapitalization } from './capitalization.js';
import { checkedStrike } from './strikethrough.js';
import { checkedLigatures } from './ligatures.js';
import { checkedKerning } from './kerning.js';
import { checkedTextScale } from './text-scale.js';
import { checkedCharacterSpacing } from './character-spacing.js';
import { checkedHighlight, checkedShading } from './backgrounds.js';
import { checkedVerticalAlign, checkedBaselineShift } from './vertical-align.js';
import { normalizeColor } from './colors.js';
import { validateIndent, normalizeTabStops } from './paragraph-geometry.js';
import { UnsupportedDocumentError } from './errors.js';
// Spacing is in points, except auto line spacing, which is a multiple of a line.
export const PAGINATION_DEFAULTS = Object.freeze({ keepNext: false, keepLines: false, widowControl: true, pageBreakBefore: false });
export const PARAGRAPH_FORMAT = Object.freeze({ paragraphBorders: Object.freeze({}), paragraphShading: 'auto', alignment: 'left', lineRule: 'auto', lineSpacing: 1, spaceBefore: 0, spaceAfter: 9, contextualSpacing: false, ...PAGINATION_DEFAULTS, indentLeft: 0, indentRight: 0, firstLine: 0, tabs: Object.freeze([]), outlineLevel: 9 });
export const RUN_FORMAT = Object.freeze({ ...FONT_DEFAULTS, bold: false, italic: false, boldCs: false, italicCs: false, fontSizeCs: 12, cs: false, rtl: false, noProof: false, underline: false, underlineStyle: 'none', strikethrough: 'none', capitalization: 'normal', fontSize: 12, textOutline: null, textShadow: null, textFill: null, text3d: null, textScene: null, color: 'auto', underlineColor: 'auto', highlight: 'none', shading: 'auto', verticalAlign: 'baseline', baselineShift: 0, characterSpacing: 0, textScale: 100, kerning: 0, ligatures: 'none' });
export const runFormat = run => { const result = Object.fromEntries(Object.entries(RUN_FORMAT).map(([k, v]) => [k, run?.[k] ?? v])); result.underlineStyle = underlinePattern(run); result.underline = result.underlineStyle !== 'none'; if (run?.legacyKerning !== undefined) result.legacyKerning = run.legacyKerning; return result; };

export function resolvedFormat(properties) {
  const s = properties.spacing || {}, ind = properties.ind || {};
  const outlineLevel = properties.outlineLevel ?? 9;
  if (!Number.isInteger(outlineLevel) || outlineLevel < 0 || outlineLevel > 9) throw new UnsupportedDocumentError('outline levels outside 0–9');
  if (properties.mirrorIndents || properties.bidi) throw new UnsupportedDocumentError('mirrored or right-to-left paragraph indents');
  if (Object.keys(ind).some(k => k.endsWith('Chars') && ind[k] !== 0)) throw new UnsupportedDocumentError('character-unit paragraph indents');
  const geometry = { indentLeft: ind.left ?? 0, indentRight: ind.right ?? 0, firstLine: ind.hanging !== undefined ? -ind.hanging : ind.firstLine ?? 0 };
  try {
    for (const v of Object.values(geometry)) validateIndent(v);
    if ((ind.firstLine ?? 0) < 0 || (ind.hanging ?? 0) < 0) throw new Error('First-line and hanging distances must be non-negative.');
    geometry.tabs = normalizeTabStops(properties.tabs || []);
  } catch (e) { throw new UnsupportedDocumentError(e.message); }
  const alignment = properties.alignment || 'left';
  if (!['left', 'center', 'right', 'start', 'end', 'both'].includes(alignment)) throw new UnsupportedDocumentError(`${alignment} paragraph alignment`);
  const lineRule = s.line === undefined ? 'auto' : s.lineRule ?? 'auto';
  const lineSpacing = s.line === undefined ? 1 : Number(s.line) / (lineRule === 'auto' ? 240 : 20);
  // Paragraph line units measure 12pt, independently of text size
  // and inter-line spacing. Nonzero line units outrank point declarations;
  // zero leaves the point value active (MS-OI29500 §2.1.60).
  const gap = side => Number(s[side + 'Lines']) ? Number(s[side + 'Lines']) * .12 : Number(s[side] || 0) / 20;
  // HTML auto spacing is 14pt in both legacy and modern compatibility modes.
  // Retain the overridden value for doNotUseHTMLParagraphAutoSpacing; boundary
  // and list suppression belong to layout, not the imported paragraph model.
  const automatic = {};
  for (const [side, key] of [['before', 'Before'], ['after', 'After']]) {
    if (['1', 'true', 'on'].includes(s[side + 'Autospacing'])) {
      automatic['autoSpace' + key] = true;
      automatic['explicitSpace' + key] = gap(side);
    }
  }
  const spaceBefore = automatic.autoSpaceBefore ? 14 : gap('before'), spaceAfter = automatic.autoSpaceAfter ? 14 : gap('after');
  if (!['auto', 'exact', 'atLeast'].includes(lineRule) || !Number.isFinite(lineSpacing) || lineSpacing < 0 || lineSpacing > (lineRule === 'auto' ? 5 : 600) || [spaceBefore, spaceAfter].some(n => !Number.isFinite(n) || n < 0 || n > 600)) {
    throw new UnsupportedDocumentError('paragraph spacing outside the supported range');
  }
  const pagination = Object.fromEntries(Object.entries(PAGINATION_DEFAULTS).map(([key, fallback]) => [key, properties[key] ?? fallback]));
  return { ...geometry, ...pagination, ...automatic, paragraphBorders: checkedParagraphBorders(properties.paragraphBorders || {}), paragraphShading: checkedShading(properties.paragraphShading ?? 'auto'), contextualSpacing: properties.contextualSpacing ?? false, ...(properties.suppressAutoHyphens !== undefined ? { suppressAutoHyphens: properties.suppressAutoHyphens } : {}), outlineLevel, alignment: alignment === 'start' ? 'left' : alignment === 'end' ? 'right' : alignment, lineRule, lineSpacing, spaceBefore, spaceAfter };
}

// Explicit point edits switch off inherited/direct automatic spacing. Retain
// the source XML in styleContext so clearing the edit can restore inheritance.
export function clearAutomaticSpacing(format, patch) {
  for (const side of ['Before', 'After']) if (Object.hasOwn(patch || {}, 'space' + side)) {
    delete format['autoSpace' + side];
    delete format['explicitSpace' + side];
  }
  return format;
}

// Geometry and contextual spacing are supported on numbering levels. Preserve the raw
// presence of each attribute so paragraph and direct formatting can override it.
export function geometryPatch(properties, checkCharacters = false) {
  const ind = properties.ind || {}, result = {};
  if (checkCharacters && Object.keys(ind).some(k => k.endsWith('Chars') && ind[k] !== 0)) throw new UnsupportedDocumentError('character-unit numbering indents');
  if ((ind.hanging ?? 0) < 0 || (ind.firstLine ?? 0) < 0) throw new UnsupportedDocumentError('negative first-line or hanging distance');
  if ('left' in ind) result.indentLeft = ind.left;
  if ('right' in ind) result.indentRight = ind.right;
  if ('hanging' in ind || 'firstLine' in ind) result.firstLine = ind.hanging !== undefined ? -ind.hanging : ind.firstLine;
  for (const v of Object.values(result)) validateIndent(v);
  if ('contextualSpacing' in properties) result.contextualSpacing = properties.contextualSpacing;
  if (properties.tabChanges?.length) result.tabs = properties.tabChanges;
  return result;
}

// Imported run-level RTL/CS formatting supports editing and round-trip.
// Unsupported properties still use the existing preview fallback.
export function checkedRunFormat(format, { displayOnly = false } = {}) {
  if (!validFontSize(format.fontSize)) throw new UnsupportedDocumentError('font sizes outside 1–1638 pt in half-point steps');
  if (format.fontSizeCs !== undefined && (!validFontSize(format.fontSizeCs))) throw new UnsupportedDocumentError('complex-script font sizes outside 1–1638 pt in half-point steps');
  if (format.fitText) throw new UnsupportedDocumentError('manual run widths (fitText), which override character spacing');
  const result = runFormat(format);
  // Hidden text (§17.3.2.41) is kept in the text and laid out with no width.
  if (format.vanish) result.vanish = true;
  result.textFill = checkedTextFill(result.textFill);
  result.textOutline = checkedTextOutline(result.textOutline);
  result.textShadow = checkedTextShadow(result.textShadow);
  for (const key of ['text3d', 'textScene']) result[key] = checkedText3d(result[key], key);
  for (const key of Object.keys(FONT_DEFAULTS)) result[key] = checkedFontProperty(key, result[key]);
  result.capitalization = checkedCapitalization(result.capitalization);
  result.strikethrough = checkedStrike(result.strikethrough);
  result.kerning = checkedKerning(result.kerning);
  result.ligatures = checkedLigatures(result.ligatures);
  result.textScale = checkedTextScale(result.textScale);
  result.characterSpacing = checkedCharacterSpacing(result.characterSpacing);
  result.highlight = checkedHighlight(result.highlight); result.shading = checkedShading(result.shading);
  result.verticalAlign = checkedVerticalAlign(result.verticalAlign); result.baselineShift = checkedBaselineShift(result.baselineShift);
  for (const key of ['color', 'underlineColor']) result[key] = normalizeColor(result[key]);
  return result;
}
