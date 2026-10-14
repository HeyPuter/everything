import { el, fieldId } from '../ui/dom.js';
import { openSymbolPicker } from '../ui/symbols.js';
import { NUMBER_STYLES, LIST_SUFFIXES } from '../engine/list-definitions.js';
import { fontChoices } from './font-picker.js';
import { field, checkbox, group, select, distance, openFormatDialog, colorField } from './format-dialog-kit.js';

/** Bullet characters that read well in any font; Symbol… offers the rest. */
export const BULLET_CHOICES = ['•', '◦', '▪', '▫', '■', '□', '●', '○', '◆', '◇', '❖', '➢', '➤', '►', '▸', '✓', '✔', '✗', '★', '☆', '♦', '–', '—', '→', '⇒', '※', '¶', '§'];
const ALIGN = [['left', 'Left'], ['center', 'Centered'], ['right', 'Right']];
const numeral = (n, format) => {
  if (format === 'none') return '';
  if (format === 'decimalZero') return String(n).padStart(2, '0');
  if (/Letter$/.test(format)) { const s = String.fromCharCode(64 + ((n - 1) % 26) + 1).repeat(Math.floor((n - 1) / 26) + 1); return format === 'lowerLetter' ? s.toLowerCase() : s; }
  if (/Roman$/.test(format)) {
    let text = '', v = n;
    for (const [k, t] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (v >= k) { text += t; v -= k; }
    return format === 'lowerRoman' ? text.toLowerCase() : text;
  }
  return String(n);
};
const fontSelect = (label, value) => {
  const list = el('datalist', { id: fieldId('fmt-fonts') }, ...fontChoices().map(name => el('option', { value: name })));
  const input = el('input.input', { type: 'text', value: value || '', placeholder: 'Same as text', list: list.id, 'aria-label': label, autocomplete: 'off' });
  return { input, node: el('span.fmt-font-input', {}, input, list) };
};
const listPreview = () => el('div.fmt-list-preview', { 'aria-hidden': 'true' });
function paintList(node, labels, { alignment = 'left', font = '', bold = false, italic = false, color = null } = {}) {
  node.replaceChildren(...labels.map(([label, depth = 0]) => el('div.fmt-list-preview-row', { style: { paddingLeft: `${depth * 18}px` } },
    el('span.fmt-list-preview-label', { style: { textAlign: alignment === 'center' ? 'center' : alignment === 'right' ? 'right' : 'left', fontFamily: font ? `"${font}", system-ui` : '', fontWeight: bold ? '700' : '', fontStyle: italic ? 'italic' : '', color: color && color !== 'auto' ? `#${color}` : '' } }, label),
    el('span.fmt-list-preview-line'))));
}

/** Define New Bullet: a character, its font and color, and the bullet's alignment. */
export function openDefineBullet({ level, apply, onClose }) {
  let character = level?.format === 'bullet' ? level.text : '•';
  const grid = el('div.fmt-symbol-grid', { role: 'radiogroup', 'aria-label': 'Bullet character' });
  const custom = el('input.input', { type: 'text', maxLength: 2, value: character, 'aria-label': 'Bullet character', autocomplete: 'off', oninput: () => { if ([...custom.value].length) { character = [...custom.value][0]; paint(); } } });
  const font = fontSelect('Bullet font', level?.markerStyle?.fontAscii);
  const color = colorField('Bullet color', level?.markerStyle?.color || 'auto', { onchange: () => paint() });
  const alignment = select('Bullet alignment', ALIGN, level?.alignment || 'left', { onchange: () => paint() });
  const preview = listPreview();
  function paint() {
    for (const button of grid.children) button.setAttribute('aria-checked', String(button.textContent === character));
    if ([...custom.value][0] !== character) custom.value = character;
    paintList(preview, [[character], [character], [character]], { alignment: alignment.value, font: font.input.value.trim(), color: color.value });
  }
  for (const ch of BULLET_CHOICES) grid.append(el('button.fmt-symbol', { type: 'button', role: 'radio', 'aria-label': `Bullet ${ch}`, 'aria-checked': 'false', onclick: () => { character = ch; paint(); } }, ch));
  font.input.addEventListener('input', paint);
  const more = el('button.btn.btn-outline', { type: 'button', onclick: () => openSymbolPicker({ onPick: ch => { character = ch; paint(); } }) }, 'Symbol…');
  paint();
  const modal = openFormatDialog({ title: 'Define New Bullet', className: 'fmt-list-dialog', onClose, wide: false,
    body: [group('Bullet character', grid, el('div.row', {}, field('Character', custom), more)),
      el('div.fmt-grid', {}, field('Font', font.node), field('Color', color), field('Alignment', alignment)),
      el('div.ed-font-preview-frame', {}, el('span.field-label', {}, 'Preview'), preview)],
    submit: () => apply({ character, font: font.input.value.trim() || null, color: color.value === 'auto' ? null : color.value, alignment: alignment.value }) });
  grid.querySelector('[aria-checked="true"]')?.focus() || grid.firstChild.focus();
  return modal;
}

/** Split a level's lvlText around its own number into the literal text before and after. */
export function splitLevelText(text, index) {
  const token = `%${index + 1}`, at = String(text || '').indexOf(token);
  return at < 0 ? { before: '', after: '.' } : { before: text.slice(0, at).replace(/%\d/g, ''), after: text.slice(at + token.length).replace(/%\d/g, '') };
}

/** Define New Number Format: number style, the text around the number, start, alignment and font. */
export function openDefineNumberFormat({ level, levelIndex = 0, apply, onClose }) {
  const parts = level && level.format !== 'bullet' ? splitLevelText(level.text, levelIndex) : { before: '', after: '.' };
  const style = select('Number style', NUMBER_STYLES, level && level.format !== 'bullet' ? level.format : 'decimal', { onchange: () => paint() });
  const before = el('input.input', { type: 'text', value: parts.before, maxLength: 20, 'aria-label': 'Text before number', oninput: () => paint() });
  const after = el('input.input', { type: 'text', value: parts.after, maxLength: 20, 'aria-label': 'Text after number', oninput: () => paint() });
  const start = el('input.input', { type: 'number', min: 0, max: 32767, step: 1, value: level?.start ?? 1, 'aria-label': 'Start at', oninput: () => paint() });
  const alignment = select('Number alignment', ALIGN, level?.alignment || 'left', { onchange: () => paint() });
  const font = fontSelect('Number font', level?.markerStyle?.fontAscii);
  const bold = checkbox('Bold', !!level?.markerStyle?.bold, () => paint()), italic = checkbox('Italic', !!level?.markerStyle?.italic, () => paint());
  const preview = listPreview();
  function paint() {
    const first = Math.max(0, Number(start.value) || 0);
    paintList(preview, [0, 1, 2].map(i => [`${before.value}${numeral(first + i, style.value)}${after.value}`]), { alignment: alignment.value, font: font.input.value.trim(), bold: bold.box.checked, italic: italic.box.checked });
  }
  font.input.addEventListener('input', paint);
  paint();
  const modal = openFormatDialog({ title: 'Define New Number Format', className: 'fmt-list-dialog', onClose, wide: false,
    body: [el('div.fmt-grid', {}, field('Number style', style), field('Start at', start)),
      group('Number format', el('div.fmt-number-format', {}, field('Before', before), el('span.fmt-number-token', { 'aria-hidden': 'true' }, '1'), field('After', after))),
      el('div.fmt-grid', {}, field('Alignment', alignment), field('Font', font.node)), el('div.fmt-checks', {}, bold, italic),
      el('div.ed-font-preview-frame', {}, el('span.field-label', {}, 'Preview'), preview)],
    submit: () => {
      if (!start.checkValidity() || start.value === '') throw new Error('Start at a whole number from 0 to 32767.');
      return apply({ format: style.value, before: before.value, after: after.value, start: Number(start.value), alignment: alignment.value, font: font.input.value.trim() || null, bold: bold.box.checked, italic: italic.box.checked });
    } });
  style.focus();
  return modal;
}

/** Set Numbering Value: start a new list at a value, or continue the previous list (optionally skipping ahead). */
export function openSetNumberingValue({ current = 1, canContinue = false, apply, onClose }) {
  const name = fieldId('fmt-numbering-mode');
  const fresh = el('input', { type: 'radio', name, value: 'new', checked: true, onchange: () => sync() });
  const resume = el('input', { type: 'radio', name, value: 'continue', disabled: !canContinue, onchange: () => sync() });
  const advance = checkbox('Advance value (skip numbers)', false, () => sync());
  const value = el('input.input', { type: 'number', min: 0, max: 32767, step: 1, value: canContinue ? current : 1, 'aria-label': 'Set value to' });
  const sync = () => { advance.box.disabled = !resume.checked; value.disabled = resume.checked && !advance.box.checked; };
  sync();
  const modal = openFormatDialog({ title: 'Set Numbering Value', className: 'fmt-list-dialog', onClose, wide: false,
    body: [el('div.fmt-radios', { role: 'radiogroup', 'aria-label': 'Numbering' },
      el('label.ed-check', {}, fresh, 'Start new list'),
      el('label.ed-check', { title: canContinue ? '' : 'There is no earlier numbered list to continue.' }, resume, 'Continue from previous list'), advance),
      field('Set value to', value)],
    submit: () => {
      if (!value.disabled && (!value.checkValidity() || value.value === '')) throw new Error('Enter a whole number from 0 to 32767.');
      return apply(resume.checked ? { mode: 'continue', value: advance.box.checked ? Number(value.value) : null } : { mode: 'new', value: Number(value.value) });
    } });
  value.focus(); value.select();
  return modal;
}

/** Adjust List Indents: number position, text indent, what follows the number and an optional tab stop. */
export function openAdjustListIndents({ level, unit = 'in', apply, onClose }) {
  const g = level?.geometry || {}, indent = g.indentLeft ?? 720, first = g.firstLine ?? -360;
  const position = distance('Number position', indent + first, { unit, min: -22 });
  const text = distance('Text indent', indent, { unit });
  const follow = select('Follow number with', Object.entries(LIST_SUFFIXES), level?.suffix || 'tab');
  const tabTwips = g.tabs?.find(t => t.numberingOnly || t.alignment === 'left')?.position;
  const addTab = checkbox('Add tab stop at', tabTwips !== undefined, on => { tab.disabled = !on; });
  const tab = distance('Tab stop', tabTwips ?? indent, { unit });
  tab.disabled = tabTwips === undefined;
  follow.addEventListener('change', () => { addTab.box.disabled = follow.value !== 'tab'; tab.disabled = follow.value !== 'tab' || !addTab.box.checked; });
  const modal = openFormatDialog({ title: 'Adjust List Indents', className: 'fmt-list-dialog', onClose, wide: false,
    body: [el('div.fmt-grid', {}, field(`Number position (${position.unit})`, position), field(`Text indent (${text.unit})`, text)),
      field('Follow number with', follow), el('div.row', {}, addTab, tab),
      el('p.field-hint', {}, 'Positions are measured from the text margin. The change applies to this level of the whole list.')],
    submit: () => {
      const numberPosition = position.read(), textIndent = text.read();
      if (numberPosition === null || textIndent === null) throw new Error('Enter the number position and text indent.');
      return apply({ numberPosition, textIndent, suffix: follow.value, tabStop: follow.value === 'tab' && addTab.box.checked ? tab.read() : null });
    } });
  position.focus();
  return modal;
}

/**
 * Define New Multilevel List: each of the nine levels' number style, format text (with %1–%9 for level
 * numbers), start, alignment, positions and what follows the number. levels: the current nine definitions.
 */
export function openDefineMultilevelList({ levels, unit = 'in', apply, onClose }) {
  const state = levels.map((level, i) => ({
    format: level?.format || 'decimal', text: level?.text ?? `%${i + 1}.`, start: level?.start ?? 1, alignment: level?.alignment || 'left', suffix: level?.suffix || 'tab',
    indentLeft: level?.geometry?.indentLeft ?? 720 * (i + 1), firstLine: level?.geometry?.firstLine ?? -360,
  }));
  let current = 0;
  const levelList = el('div.fmt-level-list', { role: 'listbox', 'aria-label': 'Level to modify', tabindex: 0 });
  const style = select('Level number style', [['bullet', 'Bullet'], ...NUMBER_STYLES], 'decimal');
  const text = el('input.input', { type: 'text', maxLength: 64, 'aria-label': 'Level format text', autocomplete: 'off' });
  const include = select('Include level number from', [['', 'Insert a level number…'], ...Array.from({ length: 9 }, (_, i) => [String(i + 1), `Level ${i + 1}`])], '');
  const start = el('input.input', { type: 'number', min: 0, max: 32767, step: 1, 'aria-label': 'Level start at' });
  const alignment = select('Level number alignment', ALIGN, 'left');
  const at = distance('Aligned at', 0, { unit }), indent = distance('Text indent at', 0, { unit });
  const follow = select('Level follow number with', Object.entries(LIST_SUFFIXES), 'tab');
  const preview = listPreview();
  function load(i) {
    current = i;
    const s = state[i];
    style.value = s.format; text.value = s.format === 'bullet' ? s.text : s.text; start.value = s.start; alignment.value = s.alignment; follow.value = s.suffix;
    at.value = String(Number(((s.indentLeft + s.firstLine) / (unit === 'cm' ? 1440 / 2.54 : 1440)).toFixed(3)));
    indent.value = String(Number((s.indentLeft / (unit === 'cm' ? 1440 / 2.54 : 1440)).toFixed(3)));
    for (const [n, item] of [...levelList.children].entries()) item.setAttribute('aria-selected', String(n === i));
    levelList.setAttribute('aria-activedescendant', levelList.children[i].id);
    paint();
  }
  function store() {
    const s = state[current], perTwips = unit === 'cm' ? 1440 / 2.54 : 1440;
    s.format = style.value; s.text = text.value; s.start = Number(start.value) || 0; s.alignment = alignment.value; s.suffix = follow.value;
    const textAt = Math.round(Number(indent.value || 0) * perTwips), numberAt = Math.round(Number(at.value || 0) * perTwips);
    s.indentLeft = textAt; s.firstLine = numberAt - textAt;
  }
  function label(i, counters) {
    const s = state[i];
    if (s.format === 'bullet') return s.text;
    return s.text.replace(/%([1-9])/g, (_, n) => numeral(counters[n - 1] ?? state[n - 1]?.start ?? 1, state[n - 1]?.format === 'bullet' ? 'decimal' : state[n - 1]?.format || 'decimal'));
  }
  function paint() {
    store();
    const counters = state.map(s => s.start);
    paintList(preview, [0, 1, 2].map(i => [label(i, counters), i]).concat([[label(0, counters.map((c, i) => i === 0 ? c + 1 : c)), 0]]));
  }
  for (let i = 0; i < 9; i++) levelList.append(el('div.fmt-level-item', { role: 'option', id: fieldId('fmt-level'), 'aria-selected': 'false', onclick: () => { store(); load(i); } }, String(i + 1)));
  levelList.addEventListener('keydown', e => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault(); store(); load(Math.max(0, Math.min(8, current + step)));
  });
  include.addEventListener('change', () => {
    if (!include.value) return;
    const pos = text.selectionStart ?? text.value.length;
    text.value = text.value.slice(0, pos) + `%${include.value}` + text.value.slice(text.selectionEnd ?? pos);
    include.value = ''; paint(); text.focus();
  });
  style.addEventListener('change', () => {
    if (style.value === 'bullet' && /%\d/.test(text.value)) text.value = '•';
    if (style.value !== 'bullet' && !/%\d/.test(text.value)) text.value = `%${current + 1}.`;
    paint();
  });
  for (const input of [text, start, at, indent]) input.addEventListener('input', paint);
  for (const input of [alignment, follow]) input.addEventListener('change', paint);
  load(0);
  const modal = openFormatDialog({ title: 'Define New Multilevel List', className: 'fmt-multilevel-dialog', onClose,
    body: el('div.fmt-multilevel', {},
      el('div.fmt-multilevel-levels', {}, el('span.field-label', {}, 'Level'), levelList),
      el('div.fmt-multilevel-fields', {},
        el('div.fmt-grid', {}, field('Number style', style), field('Start at', start)),
        el('div.fmt-grid', {}, field('Number format', text, 'Use %1–%9 for level numbers'), field('Include level number', include)),
        el('div.fmt-grid', {}, field('Alignment', alignment), field(`Aligned at (${at.unit})`, at), field(`Text indent at (${indent.unit})`, indent), field('Follow with', follow)),
        el('div.ed-font-preview-frame', {}, el('span.field-label', {}, 'Preview'), preview))),
    submit: () => {
      store();
      for (const [i, s] of state.entries()) {
        if (s.format !== 'bullet' && !/%[1-9]/.test(s.text)) throw new Error(`Level ${i + 1}: include a level number (%1–%9) in the number format.`);
        if (s.format === 'bullet' && !s.text) throw new Error(`Level ${i + 1}: enter a bullet character.`);
        if ([...s.text.matchAll(/%([1-9])/g)].some(m => Number(m[1]) > i + 1)) throw new Error(`Level ${i + 1}: a level number can refer only to this level or a higher one.`);
      }
      return apply(state.map(s => ({ format: s.format, text: s.text, start: s.start, alignment: s.alignment, suffix: s.suffix, geometry: { indentLeft: s.indentLeft, firstLine: s.firstLine } })));
    } });
  levelList.focus();
  return modal;
}
