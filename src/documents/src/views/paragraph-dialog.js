import { el } from '../ui/dom.js';
import { tabStrip, field, checkbox, group, select, distance, points, openFormatDialog, paragraphPreview } from './format-dialog-kit.js';

const ALIGNMENTS = [['left', 'Left'], ['center', 'Centered'], ['right', 'Right'], ['both', 'Justified'], ['distribute', 'Distributed']];
const OUTLINE = [...Array.from({ length: 9 }, (_, i) => [String(i), `Level ${i + 1}`]), ['9', 'Body text']];
const LINE_CHOICES = [['single', 'Single'], ['oneHalf', '1.5 lines'], ['double', 'Double'], ['atLeast', 'At least'], ['exact', 'Exactly'], ['multiple', 'Multiple']];

/** The line-spacing choice and amount for a paragraph format (null when mixed). */
export function lineChoice(rule, spacing) {
  if (rule === null || spacing === null || rule === undefined) return ['', ''];
  if (rule === 'exact') return ['exact', spacing];
  if (rule === 'atLeast') return ['atLeast', spacing];
  if (spacing === 1) return ['single', ''];
  if (spacing === 1.5) return ['oneHalf', ''];
  if (spacing === 2) return ['double', ''];
  return ['multiple', spacing];
}
/** The lineRule/lineSpacing pair a choice stands for. */
export function lineSetting(choice, amount) {
  if (choice === 'single') return { lineRule: 'auto', lineSpacing: 1 };
  if (choice === 'oneHalf') return { lineRule: 'auto', lineSpacing: 1.5 };
  if (choice === 'double') return { lineRule: 'auto', lineSpacing: 2 };
  if (choice === 'multiple') return { lineRule: 'auto', lineSpacing: Math.round(Number(amount) * 240) / 240 };
  return { lineRule: choice, lineSpacing: Math.round(Number(amount) * 20) / 20 };
}

/**
 * The Paragraph dialog: Indents and Spacing, Line and Page Breaks, with a live preview, Tabs… and Set As
 * Default. Fields start from the selection; mixed values stay blank and only changed fields are applied,
 * in one undo step.
 *
 * format: the selection's paragraph formatting (null where mixed). apply(patch) returns false on failure.
 * openTabs(patch): applies the pending patch and opens the Tabs dialog. setDefault(patch): applies it to
 * the default paragraph style.
 */
export function openParagraphDialog({ format: f, unit = 'in', canSetOutline = true, apply, openTabs, setDefault, onClose, initialTab = 'indents' }) {
  /* ---- Indents and Spacing ---- */
  const alignment = select('Alignment', ALIGNMENTS, f.alignment, { mixed: f.alignment === null });
  const outline = select('Outline level', OUTLINE, f.outlineLevel === null ? '' : String(f.outlineLevel), { mixed: f.outlineLevel === null });
  outline.disabled = !canSetOutline;
  if (!canSetOutline) outline.title = 'Built-in heading styles have a fixed outline level.';
  const left = distance('Left indent', f.indentLeft, { unit }), right = distance('Right indent', f.indentRight, { unit });
  const special = select('Special indent', [['none', '(none)'], ['firstLine', 'First line'], ['hanging', 'Hanging']], f.firstLine === null ? '' : f.firstLine > 0 ? 'firstLine' : f.firstLine < 0 ? 'hanging' : 'none', { mixed: f.firstLine === null });
  const by = distance('Special indent by', f.firstLine === null ? null : Math.abs(f.firstLine), { unit, min: 0 });
  const syncSpecial = () => { by.disabled = !special.value || special.value === 'none'; if (!by.disabled && by.value === '') by.value = unit === 'cm' ? '1.27' : '0.5'; };
  special.addEventListener('change', syncSpecial); syncSpecial();
  const leftLabel = el('span.field-label', {}, 'Left'), rightLabel = el('span.field-label', {}, 'Right');
  const mirror = checkbox('Mirror indents', f.mirrorIndents, on => { leftLabel.textContent = on ? 'Inside' : 'Left'; rightLabel.textContent = on ? 'Outside' : 'Right'; preview(); });
  if (f.mirrorIndents) { leftLabel.textContent = 'Inside'; rightLabel.textContent = 'Outside'; }
  const before = points('Spacing before', f.spaceBefore, { step: 1 }), after = points('Spacing after', f.spaceAfter, { step: 1 });
  const [choice, amount] = lineChoice(f.lineRule, f.lineSpacing);
  const line = select('Line spacing', LINE_CHOICES, choice, { mixed: !choice });
  const at = el('input.input', { type: 'number', min: 0, step: 'any', value: amount, placeholder: choice ? '' : 'Mixed', 'aria-label': 'Line spacing at' });
  const syncLine = (fill = false) => {
    const fixed = ['single', 'oneHalf', 'double', ''].includes(line.value);
    at.disabled = fixed;
    at.max = line.value === 'multiple' ? 5 : 600;
    at.step = line.value === 'multiple' ? 0.01 : 0.5;
    if (fixed) at.value = '';
    else if (fill || at.value === '') at.value = line.value === 'multiple' ? '3' : '12';
  };
  line.addEventListener('change', () => { syncLine(true); preview(); }); syncLine();
  const contextual = checkbox('Don’t add space between paragraphs of the same style', f.contextualSpacing);
  const indentsPanel = el('div', {},
    group('General', el('div.fmt-grid', {}, field('Alignment', alignment), field('Outline level', outline))),
    group('Indentation', el('div.fmt-grid', {}, el('label.ed-font-field', {}, leftLabel, left), el('label.ed-font-field', {}, rightLabel, right), field('Special', special), field(`By (${by.unit})`, by)), mirror),
    group('Spacing', el('div.fmt-grid', {}, field('Before (pt)', before), field('After (pt)', after), field('Line spacing', line), field('At', at)), contextual));

  /* ---- Line and Page Breaks ---- */
  const flags = [['widowControl', 'Widow/Orphan control'], ['keepNext', 'Keep with next'], ['keepLines', 'Keep lines together'], ['pageBreakBefore', 'Page break before']].map(([key, label]) => ({ key, node: checkbox(label, f[key]) }));
  const exceptions = [['suppressLineNumbers', 'Suppress line numbers'], ['suppressAutoHyphens', 'Don’t hyphenate']].map(([key, label]) => ({ key, node: checkbox(label, f[key]) }));
  const breaksPanel = el('div', {},
    group('Pagination', el('div.fmt-checks', {}, ...flags.map(x => x.node))),
    group('Formatting exceptions', el('div.fmt-checks', {}, ...exceptions.map(x => x.node))),
    el('p.field-hint', {}, 'Line numbers and hyphenation are kept in the file for other word processors; this editor does not number lines or hyphenate automatically.'));
  const tabs = tabStrip('Paragraph settings', [['indents', 'Indents and Spacing', indentsPanel], ['breaks', 'Line and Page Breaks', breaksPanel]]);

  /* ---- Preview ---- */
  const sample = paragraphPreview();
  function preview() {
    const s = sample.sample.style, scale = 1 / 1440 * 40; // 40px per inch in the miniature page
    const twips = input => { const v = input.read?.(); return v ?? 0; };
    const align = alignment.value || 'left';
    s.textAlign = align === 'both' || align === 'distribute' ? 'justify' : align;
    s.textAlignLast = align === 'distribute' ? 'justify' : '';
    const leftTw = twips(left), rightTw = twips(right);
    s.marginLeft = `${Math.max(-20, leftTw * scale)}px`; s.marginRight = `${Math.max(-20, rightTw * scale)}px`;
    const first = special.value === 'firstLine' ? twips(by) : special.value === 'hanging' ? -twips(by) : 0;
    s.textIndent = `${first * scale}px`;
    s.marginTop = `${Math.min(24, Number(before.value || 0) / 2)}px`; s.marginBottom = `${Math.min(24, Number(after.value || 0) / 2)}px`;
    const setting = line.value ? lineSetting(line.value, at.value || 1) : null;
    s.lineHeight = !setting ? '' : setting.lineRule === 'auto' ? String(1.2 * setting.lineSpacing) : `${Math.max(4, setting.lineSpacing / 2)}px`;
  }
  for (const input of [alignment, left, right, special, by, before, after, at]) input.addEventListener('input', preview);
  for (const input of [alignment, special]) input.addEventListener('change', preview);
  preview();

  /* ---- Reading the patch ---- */
  function patch() {
    const result = {};
    if (alignment.value && alignment.value !== f.alignment) result.alignment = alignment.value;
    if (canSetOutline && outline.value !== '' && Number(outline.value) !== f.outlineLevel) result.outlineLevel = Number(outline.value);
    for (const [key, input] of [['indentLeft', left], ['indentRight', right]]) { const v = input.read(); if (v !== null && v !== f[key]) result[key] = v; }
    if (special.value) {
      const v = special.value === 'none' ? 0 : (by.read() ?? 0) * (special.value === 'hanging' ? -1 : 1);
      if (v !== f.firstLine) result.firstLine = v;
    }
    for (const [key, input] of [['spaceBefore', before], ['spaceAfter', after]]) { const v = input.read(); if (v !== null && v !== f[key]) result[key] = v; }
    if (line.value) {
      if (!line.value.match(/single|oneHalf|double/) && (at.value === '' || !at.checkValidity())) throw new Error('Enter a line spacing amount.');
      const setting = lineSetting(line.value, at.value);
      if (setting.lineRule !== f.lineRule || setting.lineSpacing !== f.lineSpacing) Object.assign(result, setting);
    }
    const box = (key, node) => { if (!node.box.indeterminate && node.box.checked !== f[key]) result[key] = node.box.checked; };
    box('mirrorIndents', mirror); box('contextualSpacing', contextual);
    for (const { key, node } of [...flags, ...exceptions]) box(key, node);
    return result;
  }
  const tabsButton = el('button.btn.btn-outline', { type: 'button', onclick: async () => {
    try { const value = patch(); if (await openTabs?.(value) !== false) modal.close(); } catch (e) { modal.fail(e.message); }
  } }, 'Tabs…');
  const defaultButton = el('button.btn.btn-ghost', { type: 'button', onclick: async () => {
    try { const value = patch(); if (await setDefault?.(value) !== false) modal.close(); } catch (e) { modal.fail(e.message); }
  } }, 'Set As Default');
  const modal = openFormatDialog({ title: 'Paragraph', className: 'fmt-paragraph-dialog', onClose,
    body: [tabs.node, indentsPanel, breaksPanel, el('div.ed-font-preview-frame', {}, el('span.field-label', {}, 'Preview'), sample.node)],
    extra: [openTabs && tabsButton, setDefault && defaultButton].filter(Boolean),
    submit: () => { const value = patch(); return Object.keys(value).length ? apply(value) : true; } });
  if (initialTab !== 'indents') tabs.show(initialTab);
  (initialTab === 'breaks' ? flags[0].node.box : alignment).focus();
  return modal;
}
