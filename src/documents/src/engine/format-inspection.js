import { locate, paragraphFormat, runFormat } from './model.js';
import { effectiveStyleId } from './styles.js';
import { listKind, levelFor } from './numbering.js';
import { directRun, directParagraph } from './home-editing.js';
import { visibleParagraphBorders } from './paragraph-borders.js';
import { advancedFind } from './advanced-search.js';

/**
 * Reveal Formatting and the Style Inspector: the effective formatting at the selection, grouped as Font,
 * Paragraph and Section, each value marked as direct formatting or coming from styles and defaults.
 * Also the "similar formatting" condition used by Select → Select All Text With Similar Formatting.
 */

const pt = n => `${Math.round(n * 100) / 100} pt`;
const inches = twips => `${Math.round(twips / 1440 * 100) / 100}″`;
const yes = value => value ? 'Yes' : 'No';
const caps = { normal: 'None', caps: 'All caps', smallCaps: 'Small caps' };
const strikes = { none: 'None', single: 'Single', double: 'Double' };
const lineRules = { auto: 'Multiple', exact: 'Exactly', atLeast: 'At least' };

/** The paragraph and run at the start of the selection. */
function anchor(model) {
  const [start, end] = model.range;
  const { index } = locate(model.paragraphs, start);
  return { p: model.paragraphs[index], run: start === end ? model.typingRun() : model.formatAt(start, 'forward') };
}

/**
 * Sections of { title, entries: [{ label, value, direct, target }] }. `target` names the dialog that edits
 * the value ('font', 'paragraph', 'tabs', 'borders', 'numbering', 'page', 'style').
 */
export function revealFormatting(model, { styleName = id => model.styles.definitions[id]?.name || id || 'Default' } = {}) {
  const { p, run } = anchor(model);
  const f = runFormat(run), direct = model.stylesEnabled ? directRun(model, run, p) : {};
  const format = paragraphFormat(p, model.numbering, model.pageSettings), directP = model.stylesEnabled ? directParagraph(model, p) : {};
  const runEntry = (label, value, keys, target = 'font') => ({ label, value, direct: keys.some(k => Object.hasOwn(direct, k)), target });
  const paraEntry = (label, value, keys, target = 'paragraph') => ({ label, value, direct: keys.some(k => Object.hasOwn(directP, k)), target });
  const font = [
    runEntry('Font', f.fontAscii || 'Default', ['fontAscii', 'fontHAnsi']),
    runEntry('Size', pt(f.fontSize), ['fontSize']),
    runEntry('Style', [f.bold && 'Bold', f.italic && 'Italic'].filter(Boolean).join(' ') || 'Regular', ['bold', 'italic']),
    runEntry('Color', f.color === 'auto' ? 'Automatic' : `#${f.color}`, ['color']),
    runEntry('Underline', f.underlineStyle === 'none' ? 'None' : f.underlineStyle, ['underline', 'underlineStyle', 'underlineColor']),
    runEntry('Strikethrough', strikes[f.strikethrough] || f.strikethrough, ['strikethrough']),
    runEntry('Capitals', caps[f.capitalization] || f.capitalization, ['capitalization']),
    runEntry('Position', f.verticalAlign === 'baseline' ? (f.baselineShift ? `${f.baselineShift > 0 ? 'Raised' : 'Lowered'} ${pt(Math.abs(f.baselineShift))}` : 'Normal') : f.verticalAlign === 'superscript' ? 'Superscript' : 'Subscript', ['verticalAlign', 'baselineShift']),
    runEntry('Spacing', f.characterSpacing ? `${f.characterSpacing > 0 ? 'Expanded' : 'Condensed'} ${pt(Math.abs(f.characterSpacing))}` : 'Normal', ['characterSpacing']),
    runEntry('Scale', `${f.textScale}%`, ['textScale']),
    runEntry('Kerning', f.kerning ? `From ${pt(f.kerning)}` : 'Off', ['kerning']),
    runEntry('Highlight', f.highlight === 'none' ? 'None' : f.highlight, ['highlight'], 'font'),
    runEntry('Hidden', yes(f.vanish), ['vanish']),
    { label: 'Character style', value: run.styleId ? styleName(run.styleId) : 'Default characters', direct: false, target: 'style' },
  ];
  if (f.textOutline || f.textShadow) font.push(runEntry('Text effects', [f.textOutline && 'Outline', f.textShadow && 'Shadow'].filter(Boolean).join(', '), ['textOutline', 'textShadow'], 'effects'));
  const styleId = effectiveStyleId(p, model.styles);
  const special = format.firstLine > 0 ? `First line ${inches(format.firstLine)}` : format.firstLine < 0 ? `Hanging ${inches(-format.firstLine)}` : 'None';
  const paragraph = [
    { label: 'Paragraph style', value: styleId ? styleName(styleId) : 'Default paragraph', direct: false, target: 'style' },
    paraEntry('Alignment', { left: 'Left', center: 'Centered', right: 'Right', both: 'Justified' }[format.alignment] || format.alignment, ['alignment']),
    paraEntry('Outline level', format.outlineLevel === 9 ? 'Body text' : `Level ${format.outlineLevel + 1}`, ['outlineLevel']),
    paraEntry('Indentation', `Left ${inches(format.indentLeft)}, right ${inches(format.indentRight)}`, ['indentLeft', 'indentRight']),
    paraEntry('Special indent', special, ['firstLine']),
    paraEntry('Spacing', `Before ${pt(format.spaceBefore)}, after ${pt(format.spaceAfter)}`, ['spaceBefore', 'spaceAfter']),
    paraEntry('Line spacing', format.lineRule === 'auto' ? `${lineRules.auto} ${Math.round(format.lineSpacing * 100) / 100} lines` : `${lineRules[format.lineRule]} ${pt(format.lineSpacing)}`, ['lineSpacing', 'lineRule']),
    paraEntry('Pagination', [format.widowControl && 'Widow/orphan control', format.keepNext && 'Keep with next', format.keepLines && 'Keep lines together', format.pageBreakBefore && 'Page break before'].filter(Boolean).join(', ') || 'None', ['widowControl', 'keepNext', 'keepLines', 'pageBreakBefore']),
    paraEntry('Tabs', format.tabs.length ? format.tabs.map(t => `${inches(t.position)} ${t.alignment}`).join(', ') : 'Default stops', ['tabs'], 'tabs'),
    paraEntry('Borders', visibleParagraphBorders(format.paragraphBorders) ? 'Custom' : 'None', ['paragraphBorders'], 'borders'),
    paraEntry('Shading', format.paragraphShading === 'auto' ? 'None' : format.paragraphShading === 'foreground' ? 'Automatic' : `#${format.paragraphShading}`, ['paragraphShading'], 'borders'),
  ];
  if (format.mirrorIndents) paragraph.push(paraEntry('Mirror indents', 'Yes', ['mirrorIndents']));
  if (p.list) {
    let value = 'List';
    try { const level = levelFor(model.numbering, p.list); value = `${listKind(model.numbering, p.list) === 'bullet' ? 'Bulleted' : 'Numbered'}, level ${p.list.level + 1}${level.format === 'bullet' ? ` (${level.text})` : ''}`; } catch { /* keep the generic label */ }
    paragraph.push({ label: 'Bullets and numbering', value, direct: !!p.list.direct, target: 'numbering' });
  }
  const page = model.sectionPageSettings;
  const section = [
    { label: 'Paper', value: `${inches(page.width)} × ${inches(page.height)} (${page.orientation === 'landscape' ? 'landscape' : 'portrait'})`, direct: false, target: 'page' },
    { label: 'Margins', value: `Top ${inches(page.top)}, bottom ${inches(page.bottom)}, left ${inches(page.left)}, right ${inches(page.right)}`, direct: false, target: 'page' },
    { label: 'Columns', value: String(page.columns?.count || 1), direct: false, target: 'page' },
  ];
  return [{ title: 'Font', entries: font }, { title: 'Paragraph', entries: paragraph }, { title: 'Section', entries: section }];
}

/** The Style Inspector summary: paragraph and character styles plus whether direct formatting is present. */
export function styleInspection(model) {
  const { p, run } = anchor(model);
  const direct = model.stylesEnabled ? directRun(model, run, p) : {}, directP = model.stylesEnabled ? directParagraph(model, p) : {};
  return { paragraphStyle: effectiveStyleId(p, model.styles) || '', characterStyle: run.styleId || '', directParagraph: Object.keys(directP), directText: Object.keys(direct).filter(k => !['boldCs', 'italicCs', 'fontSizeCs'].includes(k)) };
}

const SIMILAR_KEYS = ['fontAscii', 'fontSize', 'bold', 'italic', 'underline', 'strikethrough', 'color', 'highlight', 'capitalization', 'verticalAlign'];

/** The formatting condition "similar formatting" means for the selection: style plus the main font properties. */
export function similarFormatCondition(model) {
  const { p, run } = anchor(model);
  const f = runFormat(run);
  const condition = Object.fromEntries(SIMILAR_KEYS.map(key => [key, key === 'underline' ? f.underlineStyle !== 'none' : f[key]]));
  condition.paragraphStyle = effectiveStyleId(p, model.styles) || '';
  condition.characterStyle = run.styleId || '';
  return condition;
}

/** Every stretch of text with formatting similar to the selection, in document order. */
export function similarFormattingRanges(model) {
  return advancedFind(model.paragraphs, '', { format: similarFormatCondition(model) }, { styles: model.styles, numbering: model.numbering });
}
