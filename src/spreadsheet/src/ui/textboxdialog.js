/**
 * Text box dialog: the text, its size, weight, colors, and alignment. Used
 * to insert a new box at the active cell and to edit one (double-click,
 * Enter, or the Edit button on a selected box).
 */

import { el, isComposing } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { TEXT_SIZES, TEXT_MAX_LENGTH, textBoxText } from '../core/charts.js';
import { EFFECT_LEVELS } from '../core/theme-effects.js';

const COLORS = [['', 'Automatic'], ['#1a1a1a', 'Black'], ['#6b6964', 'Gray'], ['#c22a2a', 'Red'], ['#eb6834', 'Orange'], ['#b8860b', 'Gold'], ['#1baf7a', 'Green'], ['#0a63f0', 'Blue'], ['#4a3aa7', 'Purple'], ['#ffffff', 'White']];
const FILLS = [['', 'None'], ['#ffffff', 'White'], ['#fff7c2', 'Yellow'], ['#e3f0ff', 'Blue'], ['#e2f6ea', 'Green'], ['#fde8e8', 'Red'], ['#f2f1ee', 'Gray'], ['#1a1a1a', 'Black']];

export function openTextBoxDialog(ctx, { textbox = null } = {}) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return;
  const st = { size: 13, bold: false, italic: false, color: null, bg: null, align: 'left', valign: 'top', border: true, ...(textbox?.style || {}) };

  const initialText = textbox ? textBoxText(wb, sheetId, textbox) : '';
  const textArea = el('textarea.input.textbox-text', { rows: 4, placeholder: 'Type the text…', 'aria-label': 'Text', value: initialText });
  const sizes = [...new Set([...TEXT_SIZES, st.size])].sort((a, b) => a - b);
  const sizeSel = el('select.select', { 'aria-label': 'Font size' }, sizes.map((n) => el('option', { value: String(n), selected: n === st.size }, `${n}`)));
  const colorSelect = (label, palette, current) => {
    const options = current && !palette.some(([value]) => value === current)
      ? [...palette, [current, `Custom (${current})`]] : palette;
    return el('select.select', { 'aria-label': label }, options.map(([value, name]) =>
      el('option', { value, selected: (current || '') === value }, name)));
  };
  const colorSel = colorSelect('Text color', COLORS, st.color);
  const fillSel = colorSelect('Fill color', FILLS, st.bg);
  // A theme effect (Page Layout ▸ Effects decides how it looks).
  const effectSel = el('select.select', { 'aria-label': 'Theme effect' }, [['0', 'None'], ...EFFECT_LEVELS.map((label, i) => [String(i + 1), label])]
    .map(([value, label]) => el('option', { value, selected: String(st.effectRef || 0) === value }, label)));
  const check = (key, label) => {
    const input = el('input', { type: 'checkbox', checked: !!st[key], onchange: () => { st[key] = input.checked; } });
    return el('label.check', {}, input, el('span', {}, label));
  };
  const seg = (key, options) => {
    const group = el('div.seg', { role: 'radiogroup', 'aria-label': key === 'align' ? 'Horizontal alignment' : 'Vertical alignment' });
    const choose = (val) => {
      st[key] = val;
      for (const b of group.children) {
        const selected = b.dataset.key === val;
        b.setAttribute('aria-checked', String(selected));
        b.tabIndex = selected ? 0 : -1;
      }
    };
    for (const [val, label] of options) {
      group.append(el('button.seg-btn', {
        type: 'button', role: 'radio', 'aria-checked': String(st[key] === val), dataset: { key: val }, tabindex: st[key] === val ? 0 : -1,
        onclick: () => choose(val),
      }, label));
    }
    group.addEventListener('keydown', (e) => {
      if (isComposing(e)) return;
      const step = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 0;
      if (!step) return;
      const choices = [...group.children];
      const index = choices.indexOf(e.target.closest('[role="radio"]'));
      if (index < 0) return;
      e.preventDefault();
      const next = choices[(index + step + choices.length) % choices.length];
      choose(next.dataset.key);
      next.focus();
    });
    return group;
  };
  const { alert: error, refuse } = fieldAlert('textbox'); // a protected sheet is about no field

  function canChange() {
    if (!wb.isProtected(sheetId)) return true;
    return refuse(null, 'This sheet is protected. Unprotect it before changing text boxes.');
  }

  const submit = (e) => {
    e?.preventDefault();
    if (!canChange()) return;
    const text = textArea.value.replace(/\r\n/g, '\n');
    if (!text.trim()) return refuse(textArea, 'Type some text');
    if (text.length > TEXT_MAX_LENGTH) return refuse(textArea, `Use ${TEXT_MAX_LENGTH.toLocaleString('en-US')} characters or fewer. Your text is still here to edit.`);
    const style = { ...st, size: Number(sizeSel.value), color: colorSel.value || null, bg: fillSel.value || null, effectRef: Number(effectSel.value) || undefined };
    if (textbox) {
      wb.updateChart(sheetId, textbox.id, { text, style, ...(text !== initialText ? { textRef: null, textPrefix: '', textSuffix: '' } : {}) }, 'Edit text box');
    } else {
      const a = ctx.active();
      const lines = text.split('\n');
      const longest = Math.max(...lines.map((l) => l.length));
      const w = Math.min(520, Math.max(120, Math.round(longest * style.size * 0.55) + 24));
      const h = Math.min(400, Math.max(48, Math.round(lines.length * style.size * 1.35) + 20));
      const id = wb.addChart(sheetId, { type: 'text', text, style, anchor: { r: a.r, c: a.c }, dx: 4, dy: 4, w, h });
      if (id) ctx.grid.selectChart(id);
    }
    modal.close();
  };

  const content = el('form', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, 'Text'), textArea, error,
      textbox?.textRef && el('span.field-hint', {}, `Linked to ${textbox.textRef}. Replacing the text removes the link.`),
      el('span.field-hint', {}, `Up to ${TEXT_MAX_LENGTH.toLocaleString('en-US')} characters`)),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, 'Size'), sizeSel),
      el('div.field', {}, el('span.field-label', {}, 'Style'), el('div.row.textbox-style-checks', {}, check('bold', 'Bold'), check('italic', 'Italic'), check('border', 'Border')))),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, 'Text color'), colorSel),
      el('label.field', {}, el('span.field-label', {}, 'Fill'), fillSel)),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, 'Theme effect'), effectSel), el('span')),
    el('div.row.row-2', {},
      el('div.field', {}, el('span.field-label', {}, 'Align'), seg('align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])),
      el('div.field', {}, el('span.field-label', {}, 'Vertical'), seg('valign', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]))),
    el('p.field-hint', {}, 'The box floats over the cells: drag it to move, drag its corner to resize. It prints where it sits and is saved with the file.'),
    el('div.row.row-end', {},
      textbox && el('button.btn.btn-ghost.btn-danger', { type: 'button', onclick: () => { if (!canChange()) return; modal.close(); ctx.run('deleteChart', textbox.id); } }, 'Delete'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, textbox ? 'Save' : 'Insert')));
  const modal = openModal({ title: textbox ? 'Edit text box' : 'Insert text box', content, initialFocus: textArea, onClose: () => ctx.grid.focus() });
  return modal;
}
