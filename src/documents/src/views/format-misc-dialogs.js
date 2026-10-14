import { el, fieldId } from '../ui/dom.js';
import { styleDisplayName } from '../lib/style-names.js';
import { BULLET_LIBRARY, NUMBER_LIBRARY, MULTILEVEL_LIBRARY } from '../engine/list-library.js';
import { styleRun, styleProperties } from '../engine/styles.js';
import { resolvedFormat } from '../engine/formatting.js';
import { tabStrip, field, select, openFormatDialog } from './format-dialog-kit.js';

/** Change Case modes in the order the dialog and the Home menu list them. */
export const CASE_MODES = [['sentence', 'Sentence case.'], ['lower', 'lowercase'], ['upper', 'UPPERCASE'], ['title', 'Capitalize Each Word'], ['toggle', 'tOGGLE cASE']];

/** Format → Change Case…: one of five conversions for the selection (or the word at the cursor). */
export function openChangeCase({ apply, onClose }) {
  const name = fieldId('fmt-case');
  const radios = CASE_MODES.map(([value, label], i) => el('label.ed-check', {}, el('input', { type: 'radio', name, value, checked: !i }), label));
  const modal = openFormatDialog({ title: 'Change Case', wide: false, onClose, className: 'fmt-case-dialog',
    body: el('div.fmt-radios', { role: 'radiogroup', 'aria-label': 'Change case to' }, ...radios),
    submit: () => apply(radios.map(r => r.firstChild).find(r => r.checked).value) });
  radios[0].firstChild.focus();
  return modal;
}

/** A one-line description of a style's formatting for the Style dialog and tooltips. */
export function describeStyle(styles, id) {
  const style = styles.definitions[id];
  if (!style) return '';
  try {
    const run = styleRun(styles, id, styles.defaults.run, style.type === 'character' ? 'character' : 'paragraph');
    const parts = [`Font: ${run.fontAscii || 'Default'}`, `${run.fontSize} pt`];
    if (run.bold) parts.push('Bold'); if (run.italic) parts.push('Italic');
    if (run.underlineStyle && run.underlineStyle !== 'none') parts.push('Underline');
    if (run.color && run.color !== 'auto') parts.push(`Color #${run.color}`);
    if (style.type === 'paragraph') {
      const f = resolvedFormat(styleProperties(styles, id));
      parts.push({ left: 'Left', center: 'Centered', right: 'Right', both: 'Justified' }[f.alignment] || f.alignment);
      parts.push(f.lineRule === 'auto' ? `Line spacing: ${Math.round(f.lineSpacing * 100) / 100}` : `Line spacing: ${f.lineRule === 'exact' ? 'exactly' : 'at least'} ${f.lineSpacing} pt`);
      parts.push(`Space before ${f.spaceBefore} pt, after ${f.spaceAfter} pt`);
      if (f.keepNext) parts.push('Keep with next');
      if (f.outlineLevel < 9) parts.push(`Level ${f.outlineLevel + 1}`);
    }
    parts.push(style.basedOn ? `Based on: ${styleDisplayName(styles.definitions[style.basedOn]?.name || style.basedOn)}` : 'Not based on another style');
    if (style.type === 'paragraph' && style.next) parts.push(`Following: ${styleDisplayName(styles.definitions[style.next]?.name || style.next)}`);
    return parts.join(', ');
  } catch (e) { return e.message; }
}

/**
 * New Style from Formatting: name, type, base and following style. The style captures the selection's
 * formatting and is applied to it.
 */
export function openNewStyle({ paragraphStyles, characterStyles, basedOn = '', characterBase = '', apply, onClose }) {
  const name = el('input.input', { type: 'text', required: true, maxLength: 253, 'aria-label': 'Name', value: 'Style1', autocomplete: 'off' });
  const type = select('Style type', [['paragraph', 'Paragraph'], ['character', 'Character']], 'paragraph', { onchange: () => sync() });
  const options = list => list.filter(s => !s.error).map(s => [s.id, styleDisplayName(s.name)]);
  const base = select('Style based on', [['', '(no style)'], ...options(paragraphStyles)], basedOn || '');
  const next = select('Style for following paragraph', [['', '(same style)'], ...options(paragraphStyles)], '');
  function sync() {
    const character = type.value === 'character';
    base.replaceChildren(...[['', '(no style)'], ...options(character ? characterStyles : paragraphStyles)].map(([v, t]) => el('option', { value: v }, t)));
    base.value = character ? characterBase || '' : basedOn || '';
    next.disabled = character;
  }
  const modal = openFormatDialog({ title: 'Create New Style from Formatting', wide: false, onClose, className: 'fmt-new-style-dialog',
    body: [field('Name', name), field('Style type', type), field('Style based on', base), field('Style for following paragraph', next),
      el('p.field-hint', {}, 'The new style takes the formatting of the selected text and is applied to it.')],
    submit: () => {
      const value = name.value.trim();
      if (!value) throw new Error('Enter a style name.');
      return apply({ name: value, type: type.value, basedOn: base.value, next: type.value === 'paragraph' ? next.value || null : undefined });
    } });
  name.focus(); name.select();
  return modal;
}

/** Apply Styles: type or pick a style name and apply it, reapply it, or modify it. */
export function openApplyStyles({ styles, current = '', apply, modify, create, pane, onClose }) {
  const listId = fieldId('fmt-style-names');
  const names = styles.filter(s => !s.error).map(s => ({ ...s, label: styleDisplayName(s.name) }));
  const input = el('input.input', { type: 'text', list: listId, 'aria-label': 'Style name', autocomplete: 'off', value: names.find(s => s.id === current)?.label || '' });
  const datalist = el('datalist', { id: listId }, ...names.map(s => el('option', { value: s.label })));
  const find = () => { const text = input.value.trim().toLowerCase(); return names.find(s => s.label.toLowerCase() === text || s.id.toLowerCase() === text); };
  const button = el('button.btn.btn-outline', { type: 'button', onclick: () => { const style = find(); if (style) { modal.close(); modify(style.id); } else modal.fail('Choose an existing style to modify.'); } }, 'Modify…');
  const paneButton = el('button.btn.btn-ghost', { type: 'button', onclick: () => { modal.close(); pane(); } }, 'Styles Pane');
  const applyButton = el('button.btn.btn-primary', { type: 'submit' }, 'Apply');
  const sync = () => { applyButton.textContent = find()?.id === current && current ? 'Reapply' : 'Apply'; };
  input.addEventListener('input', sync);
  const modal = openFormatDialog({ title: 'Apply Styles', wide: false, onClose, className: 'fmt-apply-styles', okLabel: 'Apply',
    body: [field('Style name', el('span', {}, input, datalist))], extra: [button, paneButton],
    submit: async () => {
      const style = find(), value = input.value.trim();
      if (style) return apply(style.id);
      if (!value) throw new Error('Type a style name.');
      return create(value);
    } });
  modal.form.querySelector('.btn-primary').replaceWith(applyButton);
  sync();
  input.focus(); input.select();
  return modal;
}

/** Format → Style…: browse styles with a description and New, Modify, Delete and Apply. */
export function openStyleDialog({ styles: getStyles, describe, usage, current = '', actions, onClose }) {
  let selected = current, filter = 'all';
  const list = el('div.fmt-listbox.fmt-style-list', { role: 'listbox', 'aria-label': 'Styles', tabindex: 0 });
  const description = el('p.fmt-style-description', { 'aria-live': 'polite' });
  const filterSelect = select('List', [['all', 'All styles'], ['inUse', 'Styles in use'], ['paragraph', 'Paragraph styles'], ['character', 'Character styles']], 'all', { onchange: v => { filter = v; render(); } });
  const buttons = {
    create: el('button.btn.btn-outline', { type: 'button', onclick: () => { modal.close(); actions.create(); } }, 'New…'),
    modify: el('button.btn.btn-outline', { type: 'button', onclick: () => { modal.close(); actions.modify(selected); } }, 'Modify…'),
    remove: el('button.btn.btn-outline', { type: 'button', onclick: async () => { if (await actions.remove(selected)) { selected = ''; render(); } } }, 'Delete'),
  };
  function render() {
    const counts = usage();
    const shown = getStyles().filter(s => !s.error && (filter === 'all' || filter === s.type || filter === 'inUse' && counts.has(s.id)));
    if (!shown.some(s => s.id === selected)) selected = shown[0]?.id || '';
    list.replaceChildren(...shown.map(s => el('div.fmt-listbox-item', { role: 'option', id: `fmt-style-${s.id}`, 'aria-selected': String(s.id === selected), onclick: () => { selected = s.id; render(); }, ondblclick: () => modal.form.requestSubmit() },
      el('span', {}, styleDisplayName(s.name)), el('span.fmt-listbox-meta', {}, s.type === 'character' ? 'a' : '¶'))));
    if (selected) list.setAttribute('aria-activedescendant', `fmt-style-${selected}`);
    description.textContent = selected ? describe(selected) : '';
    buttons.modify.disabled = buttons.remove.disabled = !selected || actions.readOnly();
    buttons.create.disabled = actions.readOnly();
  }
  list.addEventListener('keydown', e => {
    const items = [...list.children], at = items.findIndex(i => i.getAttribute('aria-selected') === 'true');
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = items[Math.max(0, Math.min(items.length - 1, at + step))];
    if (next) { selected = next.id.slice('fmt-style-'.length); render(); next.scrollIntoView?.({ block: 'nearest' }); }
  });
  render();
  const modal = openFormatDialog({ title: 'Style', onClose, className: 'fmt-style-dialog', okLabel: 'Apply',
    body: el('div.fmt-style-layout', {}, el('div', {}, field('List', filterSelect), list), el('div.fmt-style-side', {}, el('span.field-label', {}, 'Description'), description)),
    extra: [buttons.create, buttons.modify, buttons.remove],
    submit: () => selected ? actions.apply(selected) : true });
  list.focus();
  return modal;
}

/** Bullets and Numbering: the bullet, number and multilevel libraries with links to the define dialogs. */
export function openBulletsAndNumbering({ current = {}, apply, none, define, setValue, adjust, onClose, initialTab = 'bullet' }) {
  const tile = (label, content, selected, action) => el('button.fmt-list-tile', { type: 'button', 'aria-pressed': String(selected), 'aria-label': label, title: label, onclick: () => { modal.close(); action(); } }, content);
  const lines = labels => el('span.fmt-list-tile-sample', { 'aria-hidden': 'true' }, ...labels.map(text => el('span', {}, el('b', {}, text), el('i'))));
  const numbered = (entry, i) => ({ decimal: String(i + 1), upperRoman: ['I', 'II', 'III'][i], lowerRoman: ['i', 'ii', 'iii'][i], upperLetter: 'ABC'[i], lowerLetter: 'abc'[i] }[entry[1]] + entry[2]);
  const grid = (kind, entries, sample, extra) => el('div', {}, el('div.fmt-list-grid', {},
    tile('None', el('span.list-library-none', {}, 'None'), current[kind] === -2, () => none(kind)),
    ...entries.map((entry, index) => tile(entry[0], sample(entry), current[kind] === index, () => apply(kind, index)))), el('div.row', {}, ...extra));
  const action = (label, run) => el('button.btn.btn-outline', { type: 'button', onclick: () => { modal.close(); run(); } }, label);
  const bulletPanel = grid('bullet', BULLET_LIBRARY, entry => lines([entry[1], entry[1], entry[1]]), [action('Define New Bullet…', () => define('bullet')), action('Adjust List Indents…', adjust)]);
  const numberPanel = grid('number', NUMBER_LIBRARY, entry => lines([0, 1, 2].map(i => numbered(entry, i))), [action('Define New Number Format…', () => define('number')), action('Set Numbering Value…', setValue), action('Adjust List Indents…', adjust)]);
  const multiPanel = grid('multilevel', MULTILEVEL_LIBRARY, entry => lines([0, 1, 2].map(i => entry[1](i)).map((level, i) => level.format === 'bullet' ? level.text : level.text.replace(/%\d/g, '1'))), [action('Define New Multilevel List…', () => define('multilevel'))]);
  const tabs = tabStrip('List type', [['bullet', 'Bulleted', bulletPanel], ['number', 'Numbered', numberPanel], ['multilevel', 'Multilevel', multiPanel]]);
  const modal = openFormatDialog({ title: 'Bullets and Numbering', onClose, className: 'fmt-bullets-dialog', okLabel: 'Close',
    body: [tabs.node, bulletPanel, numberPanel, multiPanel], submit: () => true });
  modal.form.querySelector('.btn-ghost')?.remove();
  if (initialTab !== 'bullet') tabs.show(initialTab);
  tabs.buttons[['bullet', 'number', 'multilevel'].indexOf(initialTab)]?.focus();
  return modal;
}

/** Paste Special: choose how the clipboard content is pasted. choices: [{ id, label, hint }]. */
export function openPasteSpecial({ source = '', choices, apply, onClose }) {
  const name = fieldId('fmt-paste');
  const radios = choices.map((choice, i) => el('label.fmt-paste-choice', {}, el('input', { type: 'radio', name, value: choice.id, checked: !i }), el('span', {}, el('strong', {}, choice.label), el('span.field-hint', {}, choice.hint))));
  const modal = openFormatDialog({ title: 'Paste Special', wide: false, onClose, className: 'fmt-paste-dialog',
    body: [el('p.field-hint', {}, source ? `Source: ${source.replace(/\s+/g, ' ').slice(0, 80)}${source.length > 80 ? '…' : ''}` : 'The clipboard has no text.'),
      el('div.fmt-radios', { role: 'radiogroup', 'aria-label': 'Paste as' }, ...radios)],
    submit: () => apply(radios.map(r => r.firstChild).find(r => r.checked)?.value) });
  radios[0]?.firstChild.focus();
  return modal;
}
