import { MAX_FONT_SIZE } from '../engine/font-size.js';
import { paragraphBorderFields } from './paragraph-borders.js';
import { styleLineSpacingFields } from './style-line-spacing.js';
import { UNDERLINE_STYLES } from '../engine/underlines.js';
import { KERNING_LIMIT } from '../engine/kerning.js';
import { CHARACTER_SPACING_LIMIT } from '../engine/character-spacing.js';
import { styleDisplayName } from '../lib/style-names.js';
import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { builtinOutlineLevel } from '../engine/outline.js';

export function openStyleEditor(style, choices, apply, defaultRun = {}) {
  const character = style.type === 'character', kind = character ? 'character' : 'paragraph';
  const fixedOutline = character ? null : builtinOutlineLevel(style.id);
  const creating = !style.id, controls = [], error = el('p.field-error', { role: 'alert', hidden: true });
  const field = (label, input) => el('label.field', {}, el('span.field-label', {}, label), input);
  // Visible labels drop the "Style" prefix the dialog's title gives; accessible names keep it.
  const shown = label => label.replace(/^Style (\w)/, (_, c) => c.toUpperCase());
  const name = el('input.input', { required: true, maxLength: 253, value: style.name || '', 'aria-label': 'Style name' });
  const selectStyle = (label, value, emptyLabel, excludeSelf = false) => el('select.input', { 'aria-label': label },
    el('option', { value: '' }, emptyLabel), ...choices.filter(s => !s.error && (!excludeSelf || s.id !== style.id)).map(s => el('option', { value: s.id, selected: s.id === value }, styleDisplayName(s.name))));
  const basedOn = selectStyle('Based on style', style.basedOn, 'No base style', true);
  const next = selectStyle('Following paragraph style', style.next, 'Same style');
  // Keep ignored/missing original references unless the user changes the field.
  const originalBase = basedOn.value, originalNext = next.value;
  const register = (group, key, label, value, options) => {
    const input = ['color', 'underlineColor', 'paragraphShading'].includes(key) ? el('input.input', { type: 'text', placeholder: 'Inherit', pattern: key === 'paragraphShading' ? 'auto|foreground|#?[0-9a-fA-F]{6}' : 'auto|#?[0-9a-fA-F]{6}', title: key === 'paragraphShading' ? 'auto for no fill, foreground for automatic black, or six-digit RGB; leave empty to inherit' : 'auto or six-digit RGB color; leave empty to inherit', 'aria-label': label }) : options ? el('select.input', { 'aria-label': label }, ...[['', 'Inherit'], ...options].map(([v, text]) => el('option', { value: v }, text))) : el('input.input', { type: 'number', min: key === 'characterSpacing' ? -CHARACTER_SPACING_LIMIT : key === 'baselineShift' ? -200 : ['fontSize', 'textScale'].includes(key) ? 1 : 0, max: key === 'kerning' ? KERNING_LIMIT : key === 'characterSpacing' ? CHARACTER_SPACING_LIMIT : key === 'fontSize' ? MAX_FONT_SIZE : ['baselineShift', 'kerning'].includes(key) ? 200 : 600, step: key === 'textScale' ? 1 : key === 'characterSpacing' ? .05 : ['fontSize', 'baselineShift', 'kerning'].includes(key) ? .5 : 'any', placeholder: 'Inherit', 'aria-label': label });
    input.value = value === undefined ? '' : String(value);
    if (key === 'outlineLevel' && fixedOutline !== null) { input.value = String(fixedOutline); input.disabled = true; input.title = 'Built-in heading styles have a fixed outline level.'; }
    controls.push({ group, key, input, original: input.value, boolean: typeof value === 'boolean' || ['bold', 'italic', 'underline', 'keepNext', 'keepLines', 'widowControl', 'pageBreakBefore', 'contextualSpacing'].includes(key), number: (!options && !['color', 'underlineColor', 'paragraphShading'].includes(key)) || key === 'outlineLevel' });
    return field(shown(label), input);
  };
  const toggles = [['true', 'On'], ['false', 'Off']];
  const combinedCaps = { bothCapsOff: 'All caps off; small caps off', capsSmallCapsOff: 'All caps on; small caps off', smallCapsCapsOff: 'All caps off; small caps on', bothCapsOn: 'All caps on; small caps on' };
  const retainedCaps = combinedCaps[style.run?.capitalization] ? [[style.run.capitalization, combinedCaps[style.run.capitalization]]] : [];
  const lineSpacing = !creating && !character ? styleLineSpacingFields(style.properties?.spacing) : null;
  // Fields are grouped by kind: font, paragraph, pagination.
  const run = creating ? null : {
    fontSize: register('run', 'fontSize', 'Style font size (pt)', style.run?.fontSize),
    kerning: register('run', 'kerning', 'Style kerning from (pt)', style.run?.kerning),
    textScale: register('run', 'textScale', 'Style text width (%)', style.run?.textScale),
    characterSpacing: register('run', 'characterSpacing', 'Style character spacing (pt)', style.run?.characterSpacing),
    baselineShift: register('run', 'baselineShift', 'Style baseline shift (pt)', style.run?.baselineShift),
    capitalization: register('run', 'capitalization', 'Style capitalization', style.run?.capitalization, ['caps', 'capsOff', 'smallCaps', 'smallCapsOff'].map(value => { const kind = value.startsWith('smallCaps') ? 'smallCaps' : 'caps', on = !value.endsWith('Off'); return [value, `${kind === 'caps' ? 'All caps' : 'Small caps'} ${on ? 'on' : 'off'}${character ? ` (${on === (defaultRun.capitalization === kind) ? 'keep' : 'reverse'})` : ''}`]; }).concat(retainedCaps)),
    strikethrough: register('run', 'strikethrough', 'Style strikethrough', style.run?.strikethrough, [['single', character ? `Single on (${defaultRun.strikethrough === 'single' ? 'keep' : 'reverse'})` : 'Single on'], ['singleOff', character ? `Single off (${defaultRun.strikethrough === 'single' ? 'reverse' : 'keep'})` : 'Single off'], ['double', 'Double on'], ['doubleOff', 'Double off'], ['bothStrikeOff', 'Single and double off'], ['singleStrikeDoubleOff', 'Single on, double off'], ['doubleStrikeSingleOff', 'Double on, single off']]),
    color: register('run', 'color', 'Style text color', style.run?.color),
    verticalAlign: register('run', 'verticalAlign', 'Style text position', style.run?.verticalAlign, [['baseline', 'Baseline'], ['superscript', 'Superscript'], ['subscript', 'Subscript']]),
    underlineStyle: register('run', 'underlineStyle', 'Style underline', style.run?.underlineStyle ?? (style.run?.underline === undefined ? undefined : style.run.underline ? 'single' : 'none'), Object.entries(UNDERLINE_STYLES)),
    underlineColor: register('run', 'underlineColor', 'Style underline color', style.run?.underlineColor),
    ...Object.fromEntries([['bold', 'Style bold'], ['italic', 'Style italic']].map(([key, label]) => [key, register('run', key, label, style.run?.[key], character && key !== 'underline'
      ? toggles.map(([value, label]) => [value, `${label} (${(value === 'true') === Boolean(defaultRun[key]) ? 'keep' : 'reverse'})`]) : toggles)])),
  };
  const paragraphFields = creating || character ? [] : [register('paragraph', 'alignment', 'Style alignment', style.properties?.alignment, [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['both', 'Justified'], ['distribute', 'Distributed']]),
    ...lineSpacing.nodes,
    ...[['spaceBefore', 'before', 'Style space before (pt)'], ['spaceAfter', 'after', 'Style space after (pt)']].map(([key, attr, label]) => register('paragraph', key, label, style.properties?.spacing?.[attr] === undefined ? undefined : Number(style.properties.spacing[attr]) / 20)),
    register('paragraph', 'paragraphShading', 'Style paragraph fill', style.properties?.paragraphShading),
    register('paragraph', 'outlineLevel', 'Style outline level', style.properties?.outlineLevel, [...Array.from({ length: 9 }, (_, i) => [String(i), `Level ${i + 1}`]), ['9', 'Body text']])];
  const paginationFields = creating || character ? [] : [['contextualSpacing', 'Style contextual spacing'], ['keepNext', 'Style keep with next'], ['keepLines', 'Style keep lines together'], ['widowControl', 'Style widow and orphan control'], ['pageBreakBefore', 'Style page break before']].map(([key, label]) => register('paragraph', key, label, style.properties?.[key], toggles));
  const group = (title, nodes) => nodes.length ? el('section.canvas-style-section', { 'aria-label': title }, el('h3', {}, title), el('div.canvas-page-fields.canvas-style-fields', {}, ...nodes)) : null;
  const sections = creating ? [] : [
    group('Font', ['fontSize', 'bold', 'italic', 'underlineStyle', 'underlineColor', 'strikethrough', 'color', 'capitalization', 'verticalAlign', 'characterSpacing', 'textScale', 'kerning', 'baselineShift'].map(key => run[key])),
    group('Paragraph', paragraphFields), group('Pagination', paginationFields)].filter(Boolean);
  const borders = !creating && !character ? paragraphBorderFields([style.properties?.paragraphBorders], true) : null;
  const content = el('form.canvas-style-form', { onsubmit: e => {
    e.preventDefault();
    const patch = character ? { run: {} } : { paragraph: {}, run: {} };
    for (const [key, input, old] of [['name', name, style.name || ''], ['basedOn', basedOn, originalBase], ...(!character ? [['next', next, originalNext]] : [])]) if (creating || input.value !== old) patch[key] = input.value || null;
    for (const control of controls) if (control.input.value !== control.original) {
      const value = control.input.value;
      patch[control.group][control.key] = value === '' ? null : control.boolean ? value === 'true' : control.number ? Number(value) : ['color', 'underlineColor', 'paragraphShading'].includes(control.key) ? value.replace(/^#/, '') : value;
    }
    try {
      if (lineSpacing) Object.assign(patch.paragraph, lineSpacing.read());
      if (borders) { const value = borders.read(); if (value === null || Object.keys(value).length) patch.paragraph.paragraphBorders = value; }
      if (apply(patch) === false) throw new Error('This style could not be applied. Review its formatting and inheritance.');
      modal.close();
    } catch (e) { error.textContent = e.message; error.hidden = false; }
  } }, el('div.canvas-style-scroll', {}, el('div.canvas-page-fields.canvas-style-fields', {}, field('Style name', name), field('Based on', basedOn), ...(!creating && !character ? [field('Following paragraph', next)] : [])), ...sections, borders?.node,
  el('p.field-hint', {}, creating ? character ? 'Create a style for selected text or future typing.' : 'Create a style and apply it to the selected paragraphs.' : 'Changes apply wherever this style is used, including styles based on it. Direct formatting is kept. Choose Inherit to remove a declaration.' + (character ? ' For bold and italic, Keep retains inherited formatting; Reverse switches it. Capitalization and single strikethrough also toggle relative to document defaults; double strikethrough uses ordinary on/off inheritance.' : ''))), error,
  el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, creating ? 'Create style' : 'Apply')));
  const modal = openModal({ wide: !creating && !character, title: `${creating ? 'New' : 'Edit'} ${kind} style`, content, onClose: () => {
    const root = modal.panel.closest('.modal-root'); root?.setAttribute('inert', ''); root?.setAttribute('aria-hidden', 'true');
  } });
  modal.panel.classList.add('canvas-style-dialog');
  return modal;
}
